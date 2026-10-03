import { afterAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import type {
	ClaimedRun,
	CreateWebhookEndpointResponse,
	TestRunBatch,
	WebhookDelivery,
	WebhookEndpoint,
	WebhookRule,
} from "@jittle-lamp/shared";
import { webhookRuleSchema } from "@jittle-lamp/shared";
import { eq } from "drizzle-orm";

import { testRuns, webhookBatches } from "../src/db/schema";
import {
	createEnvKeyProvider,
	createTestSecrets,
} from "../src/services/test-config";
import {
	globToRegExp,
	matchRule,
	normalizeWebhookEvent,
	processWebhookReports,
	signBody,
	verifyWebhookSignature,
	type WebhookEvent,
} from "../src/services/test-webhooks";
import {
	createTestCaseFixture,
	FAKE_MODEL_KEY,
	FAKE_PASSWORD,
	type TestCaseFixture,
} from "./test-case-fixtures";
import {
	buildRunReport,
	registerRunner,
	seedRunnableCase,
} from "./test-run-fixtures";

// Obviously fake provider tokens.
const FAKE_GITHUB_TOKEN = "github_pat_fake_0000000000";
const FAKE_GITLAB_TOKEN = "glpat-fake-0000000000";
const WEB = "https://jl-web.example.test";
const SHA = "3f786850e387550fdab836ed7e6dc881de23001b";

type Captured = {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: unknown;
	raw: string;
};

// A fake GitHub / GitLab / callback receiver on a local port.
const startFakeProvider = () => {
	const requests: Captured[] = [];
	let failNext: { path: RegExp; status: number } | null = null;
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const raw = await request.text();
			let body: unknown = raw;
			try {
				body = JSON.parse(raw);
			} catch {
				// keep text
			}
			requests.push({
				method: request.method,
				path: url.pathname,
				headers: Object.fromEntries(request.headers.entries()),
				body,
				raw,
			});
			if (failNext?.path.test(url.pathname)) {
				const status = failNext.status;
				failNext = null;
				return new Response("provider down", { status });
			}
			return Response.json({ id: requests.length }, { status: 201 });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		requests,
		failOnce: (path: RegExp, status = 500) => {
			failNext = { path, status };
		},
		stop: () => server.stop(true),
	};
};

const provider = startFakeProvider();
afterAll(() => provider.stop());

const setup = async () => {
	const masterKey = randomBytes(32).toString("base64");
	let fetchCalls = 0;
	const injectedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		fetchCalls += 1;
		return fetch(input, init);
	}) as typeof fetch;
	const fixture = await createTestCaseFixture({
		env: { JL_SECRETS_MASTER_KEY: masterKey, WEB_APP_ORIGIN: WEB },
		dependencies: { fetch: injectedFetch },
	});
	const seeded = await seedRunnableCase(fixture, {
		password: FAKE_PASSWORD,
		modelKey: FAKE_MODEL_KEY,
	});
	const suite = await fixture.call<{ id: string }>("/test-suites", {
		token: fixture.qa.token,
		body: { name: "Smoke", memberIds: [seeded.testCase.id] },
	});
	expect(suite.status).toBe(201);
	const reportDeps = () => ({
		db: fixture.db,
		secrets: createTestSecrets({
			db: fixture.db,
			keyProvider: createEnvKeyProvider({ masterKey }),
		}),
		fetch: injectedFetch,
		webOrigin: WEB,
	});
	return {
		fixture,
		...seeded,
		suiteId: suite.body.id,
		reportDeps,
		fetchCalls: () => fetchCalls,
	};
};

const credential = async (
	fixture: TestCaseFixture,
	kind: "github_app" | "gitlab_token",
	token: string,
) => {
	const created = await fixture.call<{ id: string }>("/test-credentials", {
		token: fixture.admin.token,
		body: {
			profile: kind === "github_app" ? "GITHUB_STATUS" : "GITLAB_STATUS",
			kind,
			fields: { api_url: provider.url },
			secretFields: { token },
		},
	});
	expect(created.status).toBe(201);
	return created.body.id;
};

const rule = (
	input: Partial<WebhookRule> & { suiteId: string; environmentId: string },
) =>
	webhookRuleSchema.parse({
		when: input.when ?? { events: ["merge_request"], branches: [], labels: [] },
		run: { suiteId: input.suiteId },
		environment: input.environment ?? { id: input.environmentId },
		priority: input.priority ?? 40,
		report: input.report,
	});

const createEndpoint = async (
	fixture: TestCaseFixture,
	provider: "github" | "gitlab" | "generic",
	rules: WebhookRule[],
) => {
	const created = await fixture.call<CreateWebhookEndpointResponse>(
		"/test-webhooks",
		{ token: fixture.admin.token, body: { provider, rules } },
	);
	expect(created.status).toBe(201);
	return created.body;
};

const pullRequest = (
	action: string,
	options: { sha?: string; labels?: string[]; branch?: string } = {},
) => ({
	action,
	number: 42,
	pull_request: {
		title: "Checkout: keep the cart",
		head: { sha: options.sha ?? SHA, ref: options.branch ?? "feature/cart" },
		labels: (options.labels ?? ["e2e"]).map((name) => ({ name })),
	},
	repository: { full_name: "acme/shop" },
});

const postGithub = (
	fixture: TestCaseFixture,
	endpointId: string,
	secret: string,
	event: string,
	payload: unknown,
	deliveryId = crypto.randomUUID(),
	signatureSecret = secret,
) => {
	const raw = JSON.stringify(payload);
	return fixture.call<{
		status: string;
		reason?: string;
		batches?: Array<{ ruleIndex: number; batchId: string; attached: boolean }>;
	}>(`/hooks/${endpointId}`, {
		method: "POST",
		raw,
		headers: {
			"content-type": "application/json",
			"x-github-event": event,
			"x-github-delivery": deliveryId,
			"x-hub-signature-256": signBody(signatureSecret, raw),
		},
	});
};

const postGitlab = (
	fixture: TestCaseFixture,
	endpointId: string,
	token: string,
	event: string,
	payload: unknown,
) =>
	fixture.call<{
		status: string;
		batches?: Array<{ ruleIndex: number; batchId: string; attached: boolean }>;
	}>(`/hooks/${endpointId}`, {
		method: "POST",
		raw: JSON.stringify(payload),
		headers: {
			"content-type": "application/json",
			"x-gitlab-event": event,
			"x-gitlab-event-uuid": crypto.randomUUID(),
			"x-gitlab-token": token,
		},
	});

const finishBatchRuns = async (
	fixture: TestCaseFixture,
	batchId: string,
	outcome: "passed" | "failed" = "passed",
) => {
	const runner = await registerRunner(
		fixture,
		`devbox-${crypto.randomUUID().slice(0, 6)}`,
	);
	const pool = await fixture.db.query.runnerPools.findFirst({
		where: (table, { eq: equals }) => equals(table.id, runner.poolId),
	});
	// Point the batch's runs at the new pool so this runner claims them.
	await fixture.db
		.update(testRuns)
		.set({
			runnerPoolId: runner.poolId,
			runnerPool: `self-hosted:${pool?.name}`,
		})
		.where(eq(testRuns.batchId, batchId));
	for (;;) {
		const claim = await fixture.call<{ run: ClaimedRun | null }>(
			"/runner-pools/claim",
			{ token: runner.workerToken, body: {} },
		);
		const claimed = claim.body.run;
		if (!claimed) break;
		const finalized = await fixture.call(
			`/test-runs/${claimed.runId}/finalize`,
			{
				token: claimed.runToken,
				body: {
					report: buildRunReport(claimed, { outcome }),
					evidenceId: null,
				},
			},
		);
		expect(finalized.status).toBe(200);
	}
	const batch = await fixture.call<TestRunBatch>(
		`/test-run-batches/${batchId}`,
		{
			token: fixture.qa.token,
		},
	);
	expect(batch.body.finishedAt).not.toBeNull();
	return batch.body;
};

const sampleEvent = (overrides: Partial<WebhookEvent> = {}): WebhookEvent => ({
	kind: "merge_request",
	sha: SHA,
	branch: "feature/cart",
	labels: ["e2e"],
	mrId: "42",
	title: null,
	reviewAppUrl: null,
	deploymentUrl: null,
	github: { owner: "acme", repo: "shop" },
	gitlab: null,
	...overrides,
});

describe("webhook signatures", () => {
	const secret = "whsec_fake-secret-for-tests";
	const body = new TextEncoder().encode('{"ref":"refs/heads/main"}');

	it("verifies the GitHub HMAC over the raw body", () => {
		const headers = new Headers({
			"x-hub-signature-256": signBody(secret, body),
		});
		expect(verifyWebhookSignature("github", secret, headers, body)).toBe(true);
		const tampered = new TextEncoder().encode('{"ref":"refs/heads/evil"}');
		expect(verifyWebhookSignature("github", secret, headers, tampered)).toBe(
			false,
		);
		expect(verifyWebhookSignature("github", "whsec_other", headers, body)).toBe(
			false,
		);
		expect(verifyWebhookSignature("github", secret, new Headers(), body)).toBe(
			false,
		);
		expect(
			verifyWebhookSignature(
				"github",
				secret,
				new Headers({ "x-hub-signature-256": "sha1=abc" }),
				body,
			),
		).toBe(false);
	});

	it("compares the GitLab token", () => {
		expect(
			verifyWebhookSignature(
				"gitlab",
				secret,
				new Headers({ "x-gitlab-token": secret }),
				body,
			),
		).toBe(true);
		expect(
			verifyWebhookSignature(
				"gitlab",
				secret,
				new Headers({ "x-gitlab-token": `${secret}x` }),
				body,
			),
		).toBe(false);
		expect(verifyWebhookSignature("gitlab", "", new Headers(), body)).toBe(
			false,
		);
	});
});

describe("webhook rules and normalisation", () => {
	const base = rule({ suiteId: "s1", environmentId: "e1" });

	it("matches events, branch globs and labels", () => {
		expect(globToRegExp("release/*").test("release/1.2")).toBe(true);
		expect(globToRegExp("release/*").test("release/1.2/hotfix")).toBe(false);
		expect(globToRegExp("feature/**").test("feature/a/b")).toBe(true);
		expect(globToRegExp("main").test("mainline")).toBe(false);

		expect(matchRule(base, sampleEvent())).toEqual({ matched: true });
		expect(matchRule(base, sampleEvent({ kind: "push" })).matched).toBe(false);
		const branches = rule({
			suiteId: "s1",
			environmentId: "e1",
			when: {
				events: ["merge_request"],
				branches: ["release/*", "main"],
				labels: [],
			},
		});
		expect(matchRule(branches, sampleEvent()).matched).toBe(false);
		expect(
			matchRule(branches, sampleEvent({ branch: "release/2" })).matched,
		).toBe(true);
		const labels = rule({
			suiteId: "s1",
			environmentId: "e1",
			when: { events: ["merge_request"], branches: [], labels: ["E2E", "qa"] },
		});
		expect(matchRule(labels, sampleEvent()).matched).toBe(true);
		expect(matchRule(labels, sampleEvent({ labels: ["docs"] })).matched).toBe(
			false,
		);
		const reviewApp = rule({
			suiteId: "s1",
			environmentId: "e1",
			environment: { fromPayload: "review_app_url", baseEnvironmentId: "e1" },
		});
		expect(matchRule(reviewApp, sampleEvent())).toEqual({
			matched: false,
			reason: "payload has no review app url",
		});
		expect(
			matchRule(
				reviewApp,
				sampleEvent({ reviewAppUrl: "https://mr-42.review.example.test" }),
			).matched,
		).toBe(true);
	});

	it("normalises GitLab and GitHub events", () => {
		const mr = normalizeWebhookEvent(
			"gitlab",
			new Headers({ "x-gitlab-event": "Merge Request Hook" }),
			{
				object_attributes: {
					iid: 7,
					action: "update",
					source_branch: "feature/cart",
					last_commit: { id: SHA },
				},
				labels: [{ title: "e2e" }],
				project: { id: 123, web_url: "https://gitlab.example.test/acme/shop" },
			},
		);
		expect(mr).toMatchObject({
			ok: true,
			event: {
				kind: "merge_request",
				sha: SHA,
				mrId: "7",
				labels: ["e2e"],
				gitlab: { projectId: "123" },
			},
		});
		const closed = normalizeWebhookEvent(
			"gitlab",
			new Headers({ "x-gitlab-event": "Merge Request Hook" }),
			{
				object_attributes: {
					iid: 7,
					action: "close",
					source_branch: "x",
					last_commit: { id: SHA },
				},
				project: { id: 1 },
			},
		);
		expect(closed.ok).toBe(false);
		const pipeline = normalizeWebhookEvent(
			"gitlab",
			new Headers({ "x-gitlab-event": "Pipeline Hook" }),
			{
				object_attributes: { status: "failed", sha: SHA, ref: "main" },
				project: { id: 1 },
			},
		);
		expect(pipeline).toMatchObject({ ok: false, reason: "pipeline failed" });
		const deployment = normalizeWebhookEvent(
			"github",
			new Headers({ "x-github-event": "deployment_status" }),
			{
				deployment_status: {
					state: "success",
					environment_url: "https://pr-42.preview.example.test",
				},
				deployment: { sha: SHA, ref: "feature/cart" },
				repository: { full_name: "acme/shop" },
			},
		);
		expect(deployment).toMatchObject({
			ok: true,
			event: {
				kind: "deployment",
				deploymentUrl: "https://pr-42.preview.example.test",
				reviewAppUrl: "https://pr-42.preview.example.test",
			},
		});
		const synchronize = normalizeWebhookEvent(
			"github",
			new Headers({ "x-github-event": "pull_request" }),
			pullRequest("synchronize"),
		);
		expect(synchronize).toMatchObject({
			ok: true,
			event: {
				kind: "merge_request",
				mrId: "42",
				github: { owner: "acme", repo: "shop" },
			},
		});
		expect(
			normalizeWebhookEvent(
				"github",
				new Headers({ "x-github-event": "pull_request" }),
				pullRequest("closed"),
			).ok,
		).toBe(false);
	});
});

describe("webhook endpoints and deliveries", () => {
	it("manages endpoints with test_config.manage and shows the secret once", async () => {
		const { fixture, suiteId, environmentId } = await setup();
		const denied = await fixture.call("/test-webhooks", {
			token: fixture.qa.token,
			body: { provider: "github", rules: [rule({ suiteId, environmentId })] },
		});
		expect(denied.status).toBe(403);
		const badSuite = await fixture.call("/test-webhooks", {
			token: fixture.admin.token,
			body: {
				provider: "github",
				rules: [rule({ suiteId: crypto.randomUUID(), environmentId })],
			},
		});
		expect(badSuite.status).toBe(422);
		const gitlabCredential = await credential(
			fixture,
			"gitlab_token",
			FAKE_GITLAB_TOKEN,
		);
		const wrongKind = await fixture.call("/test-webhooks", {
			token: fixture.admin.token,
			body: {
				provider: "github",
				rules: [
					rule({
						suiteId,
						environmentId,
						report: {
							commitStatus: true,
							mrNote: false,
							callbackUrl: null,
							credentialId: gitlabCredential,
						},
					}),
				],
			},
		});
		expect(wrongKind.status).toBe(422);

		const created = await createEndpoint(fixture, "github", [
			rule({ suiteId, environmentId }),
		]);
		expect(created.secret).toStartWith("whsec_");
		expect(created.endpoint.url).toBe(
			`http://localhost/hooks/${created.endpoint.id}`,
		);
		const list = await fixture.call<{ items: WebhookEndpoint[] }>(
			"/test-webhooks",
			{ token: fixture.admin.token },
		);
		expect(list.body.items).toHaveLength(1);
		expect(JSON.stringify(list.body)).not.toContain(created.secret);

		const rotated = await fixture.call<CreateWebhookEndpointResponse>(
			`/test-webhooks/${created.endpoint.id}/rotate-secret`,
			{ token: fixture.admin.token, body: {} },
		);
		expect(rotated.body.secret).not.toBe(created.secret);
		const old = await postGithub(
			fixture,
			created.endpoint.id,
			created.secret,
			"pull_request",
			pullRequest("opened"),
		);
		expect(old.status).toBe(401);

		const disabled = await fixture.call<WebhookEndpoint>(
			`/test-webhooks/${created.endpoint.id}`,
			{ method: "PATCH", token: fixture.admin.token, body: { enabled: false } },
		);
		expect(disabled.body.enabled).toBe(false);
		const ignored = await postGithub(
			fixture,
			created.endpoint.id,
			rotated.body.secret,
			"pull_request",
			pullRequest("opened"),
		);
		expect(ignored.status).toBe(200);
		expect(ignored.body.status).toBe("ignored");

		const removed = await fixture.call(
			`/test-webhooks/${created.endpoint.id}`,
			{
				method: "DELETE",
				token: fixture.admin.token,
			},
		);
		expect(removed.status).toBe(200);
		const gone = await postGithub(
			fixture,
			created.endpoint.id,
			rotated.body.secret,
			"pull_request",
			pullRequest("reopened"),
		);
		expect(gone.status).toBe(404);
	});

	it("rejects bad signatures and replays, creates a CI batch and dedupes on the commit SHA", async () => {
		const { fixture, suiteId, environmentId, testCase } = await setup();
		const { endpoint, secret } = await createEndpoint(fixture, "github", [
			rule({
				suiteId,
				environmentId,
				when: {
					events: ["merge_request"],
					branches: ["feature/**"],
					labels: ["e2e"],
				},
				priority: 55,
				report: {
					commitStatus: false,
					mrNote: false,
					callbackUrl: null,
					credentialId: null,
				},
			}),
		]);
		const forged = await postGithub(
			fixture,
			endpoint.id,
			secret,
			"pull_request",
			pullRequest("opened"),
			crypto.randomUUID(),
			"whsec_attacker",
		);
		expect(forged.status).toBe(401);

		const ping = await postGithub(fixture, endpoint.id, secret, "ping", {
			zen: "hi",
		});
		expect(ping.body.status).toBe("pong");

		const deliveryId = crypto.randomUUID();
		const opened = await postGithub(
			fixture,
			endpoint.id,
			secret,
			"pull_request",
			pullRequest("opened"),
			deliveryId,
		);
		expect(opened.status).toBe(202);
		expect(opened.body.status).toBe("matched");
		const first = opened.body.batches?.[0];
		if (!first) throw new Error("Expected a batch");
		expect(first.attached).toBe(false);

		const batch = await fixture.call<TestRunBatch>(
			`/test-run-batches/${first.batchId}`,
			{
				token: fixture.qa.token,
			},
		);
		expect(batch.body).toMatchObject({
			kind: "ci",
			suiteId,
			trigger: "webhook",
			triggerRef: SHA,
			counts: { total: 1 },
		});
		const runs = await fixture.db.query.testRuns.findMany({
			where: eq(testRuns.batchId, first.batchId),
		});
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			testCaseId: testCase.id,
			trigger: "webhook",
			priority: 55,
			environmentId,
			createdBy: fixture.admin.userId,
			baseUrlOverride: null,
		});

		// The same delivery again (same id and signed body) is a replay.
		const replay = await postGithub(
			fixture,
			endpoint.id,
			secret,
			"pull_request",
			pullRequest("opened"),
			deliveryId,
		);
		expect(replay.status).toBe(409);
		// The same body under a new delivery id is a replay too.
		const replayBody = await postGithub(
			fixture,
			endpoint.id,
			secret,
			"pull_request",
			pullRequest("opened"),
		);
		expect(replayBody.status).toBe(409);

		// A retriggered event for the same commit attaches to the existing batch.
		const retriggered = await postGithub(
			fixture,
			endpoint.id,
			secret,
			"pull_request",
			pullRequest("reopened"),
		);
		expect(retriggered.status).toBe(202);
		expect(retriggered.body.batches).toEqual([
			{ ruleIndex: 0, batchId: first.batchId, attached: true },
		]);
		expect(
			await fixture.db.query.testRuns.findMany({
				where: eq(testRuns.batchId, first.batchId),
			}),
		).toHaveLength(1);

		// No matching label: recorded and ignored.
		const unlabelled = await postGithub(
			fixture,
			endpoint.id,
			secret,
			"pull_request",
			pullRequest("synchronize", { sha: "a".repeat(40), labels: ["docs"] }),
		);
		expect(unlabelled.body.status).toBe("ignored");
		expect(unlabelled.body.reason).toContain("no matching label");

		const deliveries = await fixture.call<{ items: WebhookDelivery[] }>(
			`/test-webhooks/${endpoint.id}/deliveries`,
			{ token: fixture.admin.token },
		);
		expect(deliveries.body.items.map((item) => item.status)).toEqual([
			"ignored",
			"matched",
			"rejected",
			"rejected",
			"matched",
			"ignored",
			"rejected",
		]);
		expect(deliveries.body.items.at(-1)).toMatchObject({
			signatureValid: false,
			error: "invalid signature",
		});
		expect(deliveries.body.items[1]).toMatchObject({
			triggerRef: SHA,
			batchId: first.batchId,
		});
	});

	it("runs against the review app URL from the payload with the base environment's config", async () => {
		const { fixture, suiteId, environmentId } = await setup();
		const { endpoint, secret } = await createEndpoint(fixture, "gitlab", [
			rule({
				suiteId,
				environmentId,
				when: { events: ["deployment"], branches: [], labels: [] },
				environment: {
					fromPayload: "review_app_url",
					baseEnvironmentId: environmentId,
				},
				report: {
					commitStatus: false,
					mrNote: false,
					callbackUrl: null,
					credentialId: null,
				},
			}),
		]);
		const response = await postGitlab(
			fixture,
			endpoint.id,
			secret,
			"Deployment Hook",
			{
				object_kind: "deployment",
				status: "success",
				ref: "feature/cart",
				short_sha: SHA.slice(0, 8),
				commit_url: `https://gitlab.example.test/acme/shop/-/commit/${SHA}`,
				environment_external_url: "https://mr-7.review.example.test",
				project: { id: 123, web_url: "https://gitlab.example.test/acme/shop" },
			},
		);
		expect(response.status).toBe(202);
		const batchId = response.body.batches?.[0]?.batchId ?? "";
		const run = await fixture.db.query.testRuns.findFirst({
			where: eq(testRuns.batchId, batchId),
		});
		expect(run?.baseUrlOverride).toBe("https://mr-7.review.example.test");
		expect(run?.environmentId).toBe(environmentId);

		// The runner receives the base environment's config with the review app's baseUrl.
		const runner = await registerRunner(fixture);
		const claim = await fixture.call<{ run: ClaimedRun | null }>(
			"/runner-pools/claim",
			{ token: runner.workerToken, body: {} },
		);
		const claimed = claim.body.run;
		if (!claimed) throw new Error("Expected a claimed run");
		const config = await fixture.call<{
			environment: {
				name: string;
				baseUrl: string;
				variables: Record<string, string>;
			};
		}>(`/test-runs/${claimed.runId}/config`, { token: claimed.runToken });
		expect(config.body.environment).toMatchObject({
			name: "pcf-uat",
			baseUrl: "https://mr-7.review.example.test",
			variables: { SCHOOL_CODE: "HQ" },
		});
	});

	it("reports pending and final GitHub commit statuses, a PR comment and a signed callback", async () => {
		const { fixture, suiteId, environmentId, reportDeps, fetchCalls } =
			await setup();
		const credentialId = await credential(
			fixture,
			"github_app",
			FAKE_GITHUB_TOKEN,
		);
		const { endpoint, secret } = await createEndpoint(fixture, "github", [
			rule({
				suiteId,
				environmentId,
				report: {
					commitStatus: true,
					mrNote: true,
					callbackUrl: `${provider.url}/callback`,
					credentialId,
				},
			}),
		]);
		const before = provider.requests.length;
		const opened = await postGithub(
			fixture,
			endpoint.id,
			secret,
			"pull_request",
			pullRequest("opened", { sha: "b".repeat(40) }),
		);
		expect(opened.status).toBe(202);
		const batchId = opened.body.batches?.[0]?.batchId ?? "";
		const pending = provider.requests.slice(before);
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({
			method: "POST",
			path: `/repos/acme/shop/statuses/${"b".repeat(40)}`,
			body: { state: "pending", context: "jittle-lamp/e2e" },
		});
		expect(pending[0]?.headers.authorization).toBe(
			`Bearer ${FAKE_GITHUB_TOKEN}`,
		);
		expect(fetchCalls()).toBeGreaterThan(0);

		// Nothing more is owed while the batch runs.
		expect(await processWebhookReports(reportDeps())).toBe(0);

		await finishBatchRuns(fixture, batchId, "failed");
		provider.failOnce(/\/issues\/42\/comments$/);
		const afterFinish = provider.requests.length;
		await processWebhookReports(reportDeps());
		const link = await fixture.db.query.webhookBatches.findFirst({
			where: eq(webhookBatches.batchId, batchId),
		});
		expect(link?.reportAttempts).toBe(1);
		expect(link?.reportError).toContain("GitHub PR comment answered 500");
		expect(link?.finalReportedAt).toBeNull();

		// Targets are independent: the callback goes out, and the retry sends only the comment.
		await processWebhookReports(reportDeps(), Date.now() + 120_000);
		const finalCalls = provider.requests.slice(afterFinish);
		expect(finalCalls.map((call) => call.path)).toEqual([
			`/repos/acme/shop/statuses/${"b".repeat(40)}`,
			"/repos/acme/shop/issues/42/comments",
			"/callback",
			"/repos/acme/shop/issues/42/comments",
		]);
		const status = finalCalls[0];
		expect(status?.body).toMatchObject({
			state: "failure",
			description: "Jittle Lamp: 0 passed, 1 failed, 0 blocked",
		});
		expect(
			String((status?.body as { target_url?: string } | undefined)?.target_url),
		).toStartWith(`${WEB}/test-runs/`);
		const comment = finalCalls[3]?.body as { body: string };
		expect(comment.body).toContain("Jittle Lamp E2E: failed");
		expect(comment.body).toContain("TC-0001");
		const callback = finalCalls[2];
		expect(callback?.headers["x-jl-signature-256"]).toBe(
			signBody(secret, callback?.raw ?? ""),
		);
		expect(callback?.body).toMatchObject({
			event: "batch.finished",
			batch: { id: batchId, status: "failed", triggerRef: "b".repeat(40) },
			trigger: { provider: "github", sha: "b".repeat(40), mrId: "42" },
		});
		const done = await fixture.db.query.webhookBatches.findFirst({
			where: eq(webhookBatches.batchId, batchId),
		});
		expect(done?.finalReportedAt).toBeNumber();
		expect(done?.reportError).toBeNull();

		// Reported once: later sweeps send nothing.
		const settled = provider.requests.length;
		await processWebhookReports(reportDeps(), Date.now() + 600_000);
		expect(provider.requests.length).toBe(settled);
		// The provider token never lands in the stored context or errors.
		expect(JSON.stringify(done)).not.toContain(FAKE_GITHUB_TOKEN);
	});

	it("reports GitLab commit statuses and an MR note", async () => {
		const { fixture, suiteId, environmentId, reportDeps } = await setup();
		const credentialId = await credential(
			fixture,
			"gitlab_token",
			FAKE_GITLAB_TOKEN,
		);
		const { endpoint, secret } = await createEndpoint(fixture, "gitlab", [
			rule({
				suiteId,
				environmentId,
				report: {
					commitStatus: true,
					mrNote: true,
					callbackUrl: null,
					credentialId,
				},
			}),
		]);
		const sha = "c".repeat(40);
		const before = provider.requests.length;
		const opened = await postGitlab(
			fixture,
			endpoint.id,
			secret,
			"Merge Request Hook",
			{
				object_kind: "merge_request",
				object_attributes: {
					iid: 7,
					action: "open",
					title: "Cart",
					source_branch: "feature/cart",
					last_commit: { id: sha },
				},
				labels: [],
				project: { id: 123, web_url: "https://gitlab.example.test/acme/shop" },
			},
		);
		expect(opened.status).toBe(202);
		const batchId = opened.body.batches?.[0]?.batchId ?? "";
		await finishBatchRuns(fixture, batchId, "passed");
		await processWebhookReports(reportDeps());
		const calls = provider.requests.slice(before);
		expect(
			calls.map(
				(call) =>
					`${call.path} ${(call.body as { state?: string }).state ?? "note"}`,
			),
		).toEqual([
			`/projects/123/statuses/${sha} pending`,
			`/projects/123/statuses/${sha} success`,
			"/projects/123/merge_requests/7/notes note",
		]);
		expect(calls[0]?.headers["private-token"]).toBe(FAKE_GITLAB_TOKEN);
		expect((calls[1]?.body as { name?: string } | undefined)?.name).toBe(
			"jittle-lamp/e2e",
		);
		expect((calls[2]?.body as { body?: string } | undefined)?.body).toContain(
			"Jittle Lamp E2E: passed",
		);
	});
});
