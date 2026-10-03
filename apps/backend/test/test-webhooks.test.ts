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
import { and, count, eq } from "drizzle-orm";

import {
	organizationActivityLogs,
	testRuns,
	webhookBatches,
	webhookDeliveries,
} from "../src/db/schema";
import {
	createEnvKeyProvider,
	createTestSecrets,
} from "../src/services/test-config";
import {
	globToRegExp,
	matchRule,
	mergeEventContext,
	normalizeWebhookEvent,
	payloadHostAllowed,
	processWebhookReports,
	signBody,
	verifyWebhookSignature,
	type WebhookEvent,
} from "../src/services/test-webhooks";
import {
	createTestCaseFixture,
	FAKE_MODEL_KEY,
	FAKE_PASSWORD,
	loginTranscript,
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
	let failNext: { path: RegExp; status: number; remaining: number } | null =
		null;
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
				failNext.remaining -= 1;
				if (failNext.remaining <= 0) failNext = null;
				return new Response("provider down", { status });
			}
			return Response.json({ id: requests.length }, { status: 201 });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		requests,
		failOnce: (path: RegExp, status = 500) => {
			failNext = { path, status, remaining: 1 };
		},
		failTimes: (path: RegExp, times: number, status = 500) => {
			failNext = { path, status, remaining: times };
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
		env: {
			JL_SECRETS_MASTER_KEY: masterKey,
			WEB_APP_ORIGIN: WEB,
			// The fake provider listens on 127.0.0.1.
			JL_OUTBOUND_ALLOW_LOOPBACK: "true",
		},
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
		outbound: { allowLoopback: true, allowHosts: [] },
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
			environment: {
				fromPayload: "review_app_url",
				baseEnvironmentId: "e1",
				allowedHosts: ["*.review.example.test"],
			},
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
					allowedHosts: ["*.review.example.test"],
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

const pushEvent = (sha: string, branch = "feature/cart") => ({
	ref: `refs/heads/${branch}`,
	after: sha,
	repository: { full_name: "acme/shop" },
});

const deliveriesOf = (fixture: TestCaseFixture, endpointId: string) =>
	fixture.call<{ items: WebhookDelivery[] }>(
		`/test-webhooks/${endpointId}/deliveries`,
		{ token: fixture.admin.token },
	);

const linkOf = (fixture: TestCaseFixture, batchId: string) =>
	fixture.db.query.webhookBatches.findFirst({
		where: eq(webhookBatches.batchId, batchId),
	});

const noReport = {
	commitStatus: false,
	mrNote: false,
	callbackUrl: null,
	credentialId: null,
};

describe("webhook review fixes", () => {
	it("sends review-app runs only to allowed hosts", async () => {
		expect(
			payloadHostAllowed(
				"https://mr-1.review.example.test/",
				["*.review.example.test"],
				null,
			),
		).toEqual({ allowed: true });
		expect(
			payloadHostAllowed(
				"https://a.b.review.example.test",
				["*.review.example.test"],
				null,
			),
		).toEqual({ allowed: false, host: "a.b.review.example.test" });
		expect(
			payloadHostAllowed(
				"https://review.example.test.evil.net",
				["*.review.example.test"],
				null,
			).allowed,
		).toBe(false);
		expect(
			payloadHostAllowed("https://uat.example.test/x", [], "uat.example.test")
				.allowed,
		).toBe(true);
		expect(
			payloadHostAllowed("https://other.example.test", [], null).allowed,
		).toBe(false);

		const { fixture, suiteId, environmentId } = await setup();
		const { endpoint, secret } = await createEndpoint(fixture, "gitlab", [
			rule({
				suiteId,
				environmentId,
				when: { events: ["deployment"], branches: [], labels: [] },
				// No allowedHosts: only the base environment's own host (uat.example.test).
				environment: {
					fromPayload: "deployment_url",
					baseEnvironmentId: environmentId,
					allowedHosts: [],
				},
				report: noReport,
			}),
		]);
		const deployment = (url: string, sha: string) => ({
			object_kind: "deployment",
			status: "success",
			ref: "main",
			commit_url: `https://gitlab.example.test/acme/shop/-/commit/${sha}`,
			environment_external_url: url,
			project: { id: 123 },
		});
		const evil = await postGitlab(
			fixture,
			endpoint.id,
			secret,
			"Deployment Hook",
			deployment("https://collector.evil.example.net", "d".repeat(40)),
		);
		expect(evil.status).toBe(200);
		expect(evil.body.status).toBe("ignored");
		const deliveries = await deliveriesOf(fixture, endpoint.id);
		expect(deliveries.body.items[0]?.error).toContain(
			"host collector.evil.example.net is not an allowed review app host",
		);
		expect(
			await fixture.db.query.webhookBatches.findMany({
				where: eq(webhookBatches.endpointId, endpoint.id),
			}),
		).toHaveLength(0);

		const own = await postGitlab(
			fixture,
			endpoint.id,
			secret,
			"Deployment Hook",
			deployment("https://uat.example.test/mr-7", "e".repeat(40)),
		);
		expect(own.status).toBe(202);
	});

	it("requires api_url on GitLab credentials so the PAT never follows a payload host", async () => {
		const { fixture, suiteId, environmentId } = await setup();
		const bare = await fixture.call<{ id: string }>("/test-credentials", {
			token: fixture.admin.token,
			body: {
				profile: "GITLAB_NO_API",
				kind: "gitlab_token",
				secretFields: { token: FAKE_GITLAB_TOKEN },
			},
		});
		const refused = await fixture.call<{ error: { message: string } }>(
			"/test-webhooks",
			{
				token: fixture.admin.token,
				body: {
					provider: "gitlab",
					rules: [
						rule({
							suiteId,
							environmentId,
							report: {
								commitStatus: true,
								mrNote: false,
								callbackUrl: null,
								credentialId: bare.body.id,
							},
						}),
					],
				},
			},
		);
		expect(refused.status).toBe(422);
		expect(refused.body.error.message).toContain("api_url");
	});

	it("refuses callbacks to private addresses and does not follow redirects", async () => {
		const { fixture, suiteId, environmentId, reportDeps } = await setup();
		const { endpoint, secret } = await createEndpoint(fixture, "github", [
			rule({
				suiteId,
				environmentId,
				report: { ...noReport, callbackUrl: "http://10.0.0.7/hook" },
			}),
		]);
		const opened = await postGithub(
			fixture,
			endpoint.id,
			secret,
			"pull_request",
			pullRequest("opened", { sha: "1".repeat(40) }),
		);
		const batchId = opened.body.batches?.[0]?.batchId ?? "";
		await finishBatchRuns(fixture, batchId);
		await processWebhookReports(reportDeps());
		const link = await linkOf(fixture, batchId);
		expect(link?.reportError).toContain("private or local address");
		expect(link?.finalReportedAt).toBeNull();
	});

	it("verifies signatures without audit rows, samples bad signatures and limits each client", async () => {
		const { fixture, suiteId, environmentId } = await setup();
		const { endpoint, secret } = await createEndpoint(fixture, "github", [
			rule({ suiteId, environmentId, report: noReport }),
		]);
		const secretReads = async () =>
			(
				await fixture.db
					.select({ value: count() })
					.from(organizationActivityLogs)
					.where(
						and(
							eq(organizationActivityLogs.organizationId, fixture.orgId),
							eq(organizationActivityLogs.action, "test_config.secret_read"),
						),
					)
			)[0]?.value ?? 0;
		const before = await secretReads();
		for (let index = 0; index < 3; index += 1) {
			await postGithub(
				fixture,
				endpoint.id,
				secret,
				"pull_request",
				pullRequest("synchronize", { sha: `${index}`.repeat(40), labels: [] }),
			);
		}
		for (let index = 0; index < 5; index += 1) {
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
		}
		expect(await secretReads()).toBe(before);
		const badRows = await fixture.db.query.webhookDeliveries.findMany({
			where: and(
				eq(webhookDeliveries.endpointId, endpoint.id),
				eq(webhookDeliveries.signatureValid, false),
			),
		});
		expect(badRows).toHaveLength(1);

		// No Content-Length and a body over 2 MB: refused while streaming.
		const chunk = new Uint8Array(512 * 1024).fill(0x20);
		let sent = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent >= 5) return controller.close();
				sent += 1;
				controller.enqueue(chunk);
			},
		});
		const huge = await fixture.app.handle(
			new Request(`http://localhost/hooks/${endpoint.id}`, {
				method: "POST",
				body: stream,
				headers: {
					"content-type": "application/json",
					"x-github-event": "push",
					"x-forwarded-for": "198.51.100.1",
				},
				duplex: "half",
			} as RequestInit),
		);
		expect(huge.status).toBe(413);

		const statuses: number[] = [];
		for (let index = 0; index < 121; index += 1) {
			const response = await fixture.call(`/hooks/${endpoint.id}`, {
				method: "POST",
				raw: "{}",
				headers: {
					"content-type": "application/json",
					"x-github-event": "ping",
					"x-forwarded-for": "203.0.113.9",
				},
			});
			statuses.push(response.status);
		}
		expect(statuses.at(-1)).toBe(429);
		expect(statuses.filter((status) => status === 429)).toHaveLength(1);
		// Another client is not affected.
		const other = await fixture.call(`/hooks/${endpoint.id}`, {
			method: "POST",
			raw: "{}",
			headers: {
				"content-type": "application/json",
				"x-github-event": "ping",
				"x-forwarded-for": "203.0.113.10",
			},
		});
		expect(other.status).toBe(401);
	});

	it("still sends the final report after the pending status ran out of attempts, and shows the dead letter", async () => {
		const { fixture, suiteId, environmentId, reportDeps } = await setup();
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
					mrNote: false,
					callbackUrl: null,
					credentialId,
				},
			}),
		]);
		const sha = "2".repeat(40);
		provider.failTimes(new RegExp(`/statuses/${sha}$`), 5);
		const opened = await postGithub(
			fixture,
			endpoint.id,
			secret,
			"pull_request",
			pullRequest("opened", { sha }),
		);
		const batchId = opened.body.batches?.[0]?.batchId ?? "";
		let now = Date.now();
		for (let attempt = 0; attempt < 6; attempt += 1) {
			now += 3_600_000;
			await processWebhookReports(reportDeps(), now);
		}
		expect(await linkOf(fixture, batchId)).toMatchObject({
			reportStage: "pending",
			reportAttempts: 5,
		});
		const dead = await deliveriesOf(fixture, endpoint.id);
		expect(dead.body.items[0]?.report).toMatchObject({
			stage: "pending",
			state: "failed",
			attempts: 5,
			error: expect.stringContaining("GitHub commit status answered 500"),
		});

		const before = provider.requests.length;
		await finishBatchRuns(fixture, batchId);
		await processWebhookReports(reportDeps(), now + 60_000);
		const final = provider.requests
			.slice(before)
			.filter((call) => call.path.endsWith(`/statuses/${sha}`));
		expect(final.map((call) => (call.body as { state: string }).state)).toEqual(
			["success"],
		);
		const sent = await deliveriesOf(fixture, endpoint.id);
		expect(sent.body.items[0]?.report).toMatchObject({
			stage: "final",
			state: "sent",
			attempts: 0,
			error: null,
		});
	});

	it("never lets one commit's run stand in for another commit's run", async () => {
		const { fixture, suiteId, environmentId } = await setup();
		const { endpoint, secret } = await createEndpoint(fixture, "github", [
			rule({ suiteId, environmentId, report: noReport }),
		]);
		const first = await postGithub(
			fixture,
			endpoint.id,
			secret,
			"pull_request",
			pullRequest("opened", { sha: "3".repeat(40) }),
		);
		const firstBatch = first.body.batches?.[0]?.batchId ?? "";
		await finishBatchRuns(fixture, firstBatch);
		// Within the dedupe window: a new commit must still get its own run.
		const second = await postGithub(
			fixture,
			endpoint.id,
			secret,
			"pull_request",
			pullRequest("synchronize", { sha: "4".repeat(40) }),
		);
		const secondBatch = second.body.batches?.[0]?.batchId ?? "";
		expect(secondBatch).not.toBe(firstBatch);
		const [a] = await fixture.db.query.testRuns.findMany({
			where: eq(testRuns.batchId, firstBatch),
		});
		const [b] = await fixture.db.query.testRuns.findMany({
			where: eq(testRuns.batchId, secondBatch),
		});
		expect(a?.id).toBeString();
		expect(b?.id).toBeString();
		expect(b?.id).not.toBe(a?.id);
		expect(b?.dedupeKey).not.toBe(a?.dedupeKey);
		expect(b?.status).toBe("queued");
	});

	it("joins a later merge request event to the commit's batch, and concurrent deliveries create one batch", async () => {
		expect(
			mergeEventContext(
				sampleEvent({ kind: "push", mrId: null, labels: ["a"], github: null }),
				sampleEvent({ mrId: "42", labels: ["b"] }),
			),
		).toMatchObject({
			kind: "push",
			mrId: "42",
			labels: ["a", "b"],
			github: { owner: "acme", repo: "shop" },
		});

		const { fixture, suiteId, environmentId, reportDeps } = await setup();
		const credentialId = await credential(
			fixture,
			"github_app",
			FAKE_GITHUB_TOKEN,
		);
		const { endpoint, secret } = await createEndpoint(fixture, "github", [
			rule({
				suiteId,
				environmentId,
				when: { events: ["push", "merge_request"], branches: [], labels: [] },
				report: {
					commitStatus: false,
					mrNote: true,
					callbackUrl: null,
					credentialId,
				},
			}),
		]);
		const sha = "5".repeat(40);
		const [push, pr] = await Promise.all([
			postGithub(fixture, endpoint.id, secret, "push", pushEvent(sha)),
			postGithub(
				fixture,
				endpoint.id,
				secret,
				"pull_request",
				pullRequest("opened", { sha }),
			),
		]);
		const results = [push.body.batches?.[0], pr.body.batches?.[0]];
		expect(new Set(results.map((entry) => entry?.batchId)).size).toBe(1);
		expect(results.map((entry) => entry?.attached).sort()).toEqual([
			false,
			true,
		]);
		const batchId = results[0]?.batchId ?? "";
		expect(
			await fixture.db.query.testRuns.findMany({
				where: eq(testRuns.batchId, batchId),
			}),
		).toHaveLength(1);
		expect(
			await fixture.db.query.webhookBatches.findMany({
				where: eq(webhookBatches.endpointId, endpoint.id),
			}),
		).toHaveLength(1);

		const before = provider.requests.length;
		await finishBatchRuns(fixture, batchId);
		await processWebhookReports(reportDeps());
		// Whichever event came first, the PR number reached the batch: the comment is posted.
		expect(provider.requests.slice(before).map((call) => call.path)).toEqual([
			"/repos/acme/shop/issues/42/comments",
		]);
	});

	it("never reports a partly cancelled batch as success", async () => {
		const { fixture, environmentId, reportDeps, testCase } = await setup();
		const second = await fixture.call<{ id: string }>("/test-cases", {
			token: fixture.qa.token,
			body: {
				transcript: loginTranscript("Branch admin logout clears the email"),
				environmentId,
			},
		});
		const suite = await fixture.call<{ id: string }>("/test-suites", {
			token: fixture.qa.token,
			body: { name: "Two cases", memberIds: [testCase.id, second.body.id] },
		});
		const credentialId = await credential(
			fixture,
			"github_app",
			FAKE_GITHUB_TOKEN,
		);
		const { endpoint, secret } = await createEndpoint(fixture, "github", [
			rule({
				suiteId: suite.body.id,
				environmentId,
				report: {
					commitStatus: true,
					mrNote: false,
					callbackUrl: null,
					credentialId,
				},
			}),
		]);
		const sha = "6".repeat(40);
		const opened = await postGithub(
			fixture,
			endpoint.id,
			secret,
			"pull_request",
			pullRequest("opened", { sha }),
		);
		const batchId = opened.body.batches?.[0]?.batchId ?? "";
		const runs = await fixture.db.query.testRuns.findMany({
			where: eq(testRuns.batchId, batchId),
		});
		expect(runs).toHaveLength(2);
		const cancelled = await fixture.call(`/test-runs/${runs[1]?.id}/cancel`, {
			token: fixture.admin.token,
			body: {},
		});
		expect(cancelled.status).toBe(200);
		const batch = await finishBatchRuns(fixture, batchId, "passed");
		expect(batch.status).toBe("cancelled");
		const before = provider.requests.length;
		await processWebhookReports(reportDeps());
		const status = provider.requests
			.slice(before)
			.find((call) => call.path.endsWith(`/statuses/${sha}`));
		expect((status?.body as { state?: string } | undefined)?.state).toBe(
			"error",
		);
	});

	it("accepts a redelivery of an ignored delivery and runs only active cases", async () => {
		const { fixture, environmentId, testCase } = await setup();
		const draft = await fixture.call<{ id: string; status: string }>(
			"/test-cases",
			{
				token: fixture.qa.token,
				body: {
					transcript: loginTranscript("Draft case stays out of CI"),
					environmentId,
					status: "draft",
				},
			},
		);
		expect(draft.body.status).toBe("draft");
		const suite = await fixture.call<{ id: string }>("/test-suites", {
			token: fixture.qa.token,
			body: { name: "Mixed", memberIds: [testCase.id, draft.body.id] },
		});
		const { endpoint, secret } = await createEndpoint(fixture, "github", [
			rule({
				suiteId: suite.body.id,
				environmentId,
				when: { events: ["merge_request"], branches: ["main"], labels: [] },
				report: noReport,
			}),
		]);
		const deliveryId = crypto.randomUUID();
		const payload = pullRequest("opened", { sha: "7".repeat(40) });
		const first = await postGithub(
			fixture,
			endpoint.id,
			secret,
			"pull_request",
			payload,
			deliveryId,
		);
		expect(first.body.status).toBe("ignored");
		// The operator fixes the rule and redelivers from the provider's UI.
		await fixture.call(`/test-webhooks/${endpoint.id}`, {
			method: "PATCH",
			token: fixture.admin.token,
			body: {
				rules: [
					rule({ suiteId: suite.body.id, environmentId, report: noReport }),
				],
			},
		});
		const again = await postGithub(
			fixture,
			endpoint.id,
			secret,
			"pull_request",
			payload,
			deliveryId,
		);
		expect(again.status).toBe(202);
		const batchId = again.body.batches?.[0]?.batchId ?? "";
		const runs = await fixture.db.query.testRuns.findMany({
			where: eq(testRuns.batchId, batchId),
		});
		expect(runs.map((run) => run.testCaseId)).toEqual([testCase.id]);
	});
});
