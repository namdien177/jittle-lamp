import { describe, expect, it } from "bun:test";
import type {
	ClaimedExploration,
	ExplorationConfig,
	ExplorationRecord,
	ImportBatch,
	RunnerPool,
} from "@jittle-lamp/shared";
import { STOPPED_WAITING } from "../src/services/test-explorations";
import {
	createTestCaseFixture,
	FAKE_MODEL_KEY,
	FAKE_PASSWORD,
} from "./test-case-fixtures";
import { registerRunner, seedRunnableCase } from "./test-run-fixtures";

// "General instructions" imports: each case waits in `pending` while a runner of the
// environment's pool explores it; the result becomes the item's transcript.

const instructions = [
	"# Admin creates an interest",
	"Sign in as PCF_HQ_ADMIN, open Interests and add one for a new parent.",
	"The new interest is listed.",
	"",
	"# Parent signs out",
	"Sign out from the account menu. The login form is shown.",
	"",
	"# Teacher prints a report",
	"Open Reports and print the attendance report.",
].join("\n");

const record = (goal: string): ExplorationRecord => ({
	goal,
	ended: "finished",
	summary: "The interest list shows the new parent.",
	steps: [
		{
			index: 1,
			title: "Sign in",
			instruction: "Sign in as the HQ admin",
			status: "passed",
			summary: "Dashboard shown",
			errorCode: null,
		},
		{
			index: 2,
			title: "Add interest",
			instruction: "Open Interests and click New interest",
			status: "passed",
			summary: null,
			errorCode: null,
		},
	],
	findings: [],
});

describe("explored imports", () => {
	it("queues one exploration per case, serves it to an idle runner and writes the result back", async () => {
		const prompts: string[] = [];
		const fixture = await createTestCaseFixture({
			dependencies: {
				generateText: async ({ prompt }) => {
					prompts.push(prompt);
					if (prompt.includes("Parent signs out"))
						throw new Error("model down");
					return "```\n# Something else\n\n[Login: PCF_HQ_ADMIN]\n[Act] open Interests and click New interest\n## Checkpoint: Saved\n[Assert] the new interest is listed\n```";
				},
			},
		});
		const { environmentId } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
			modelKey: FAKE_MODEL_KEY,
		});

		const noEnvironment = await fixture.call("/test-cases/import", {
			token: fixture.admin.token,
			body: { sourceKind: "instructions", content: instructions },
		});
		expect(noEnvironment.status).toBe(422);
		expect(noEnvironment.body).toMatchObject({
			error: { code: "EXPLORE_NEEDS_ENVIRONMENT" },
		});

		// No runner in the environment's pool yet: refused rather than queued out of sight.
		const refused = await fixture.call("/test-cases/import", {
			token: fixture.admin.token,
			body: {
				sourceKind: "instructions",
				content: instructions,
				environmentId,
			},
		});
		expect(refused.status).toBe(409);
		expect(refused.body).toMatchObject({
			error: { code: "EXPLORE_NO_RUNNER" },
			pool: "self-hosted:devbox",
		});

		const created = await fixture.call<ImportBatch>("/test-cases/import", {
			token: fixture.admin.token,
			body: {
				sourceKind: "instructions",
				content: instructions,
				environmentId,
				queueWithoutRunner: true,
			},
		});
		expect(created.status).toBe(201);
		expect(created.body.items[0]?.exploration).toMatchObject({
			runnerPoolName: "self-hosted:devbox",
			runnersOnline: 0,
		});
		expect(created.body.status).toBe("parsing");
		expect(
			created.body.items.map((item) => [
				item.title,
				item.state,
				item.exploration?.status,
			]),
		).toEqual([
			["Admin creates an interest", "pending", "queued"],
			["Parent signs out", "pending", "queued"],
			["Teacher prints a report", "pending", "queued"],
		]);
		// Until it is explored, an item holds its instructions as notes.
		expect(created.body.items[0]?.transcript).toContain(
			"[Note] Sign in as PCF_HQ_ADMIN",
		);
		const batchId = created.body.id;

		const early = await fixture.call(`/test-cases/import/${batchId}`, {
			method: "PATCH",
			token: fixture.admin.token,
			body: { commit: true },
		});
		expect(early.status).toBe(409);
		expect(early.body).toMatchObject({ error: { code: "IMPORT_EXPLORING" } });

		const runner = await registerRunner(fixture);
		// The new pool adopts the queued explorations; they count on it next to runs.
		const pools = await fixture.call<{ items: RunnerPool[] }>("/runner-pools", {
			token: fixture.admin.token,
		});
		expect(
			pools.body.items
				.filter((pool) => pool.name === "devbox")
				.map((pool) => [
					pool.queued,
					pool.explorationsQueued,
					pool.explorationsRunning,
				]),
		).toEqual([[0, 3, 0]]);
		const waiting = await fixture.call<ImportBatch>(
			`/test-cases/import/${batchId}`,
			{ token: fixture.admin.token },
		);
		expect(waiting.body.items[0]?.exploration).toMatchObject({
			runnerPoolName: "devbox",
			runnersOnline: 1,
		});
		const claim = async () => {
			const response = await fixture.call<{
				run: unknown;
				exploration: ClaimedExploration | null;
			}>("/runner-pools/claim", { token: runner.workerToken, body: {} });
			expect(response.body.run).toBeNull();
			if (!response.body.exploration)
				throw new Error("Expected an exploration");
			return response.body.exploration;
		};

		const first = await claim();
		const busy = await fixture.call<{ items: RunnerPool[] }>("/runner-pools", {
			token: fixture.admin.token,
		});
		expect(
			busy.body.items
				.filter((pool) => pool.name === "devbox")
				.map((pool) => [pool.explorationsQueued, pool.explorationsRunning]),
		).toEqual([[2, 1]]);
		expect(first.goal).toContain("Admin creates an interest");
		expect(first.goal).toContain("Sign in as PCF_HQ_ADMIN");
		expect(first.maxSteps).toBe(8);

		const config = await fixture.call<ExplorationConfig>(
			`/test-explorations/${first.explorationId}/config`,
			{ token: runner.workerToken },
		);
		expect(config.status).toBe(200);
		expect(config.body.environment).toMatchObject({
			name: "pcf-uat",
			baseUrl: "https://uat.example.test",
		});
		// Only the profile the instructions name is decrypted.
		expect(
			config.body.credentials.map((credential) => credential.profile),
		).toEqual(["PCF_HQ_ADMIN"]);
		expect(config.body.credentials[0]?.secretFields.password).toBe(
			FAKE_PASSWORD,
		);
		expect(config.body.model?.apiKeys).not.toEqual({});

		const done = await fixture.call(
			`/test-explorations/${first.explorationId}/result`,
			{
				token: runner.workerToken,
				body: { status: "done", explore: record(first.goal) },
			},
		);
		expect(done.status).toBe(200);
		expect(prompts[0]).toContain(
			"2. [passed] Add interest: Open Interests and click New interest",
		);

		// The lease is spent: a second result for the same exploration is refused.
		const again = await fixture.call(
			`/test-explorations/${first.explorationId}/result`,
			{
				token: runner.workerToken,
				body: { status: "done", explore: record(first.goal) },
			},
		);
		expect(again.status).toBe(409);

		const second = await claim();
		await fixture.call(`/test-explorations/${second.explorationId}/result`, {
			token: runner.workerToken,
			body: { status: "done", explore: record(second.goal) },
		});
		const third = await claim();
		await fixture.call(`/test-explorations/${third.explorationId}/result`, {
			token: runner.workerToken,
			body: {
				status: "failed",
				explore: null,
				error: "net::ERR_NAME_NOT_RESOLVED",
			},
		});

		const batch = await fixture.call<ImportBatch>(
			`/test-cases/import/${batchId}`,
			{
				token: fixture.admin.token,
			},
		);
		expect(batch.body.status).toBe("ready");
		const [interest, signOut, report] = batch.body.items;
		// Written by the model; the import keeps its own title and tags the source.
		expect(interest?.state).toBe("ready");
		expect(interest?.exploration).toMatchObject({
			status: "done",
			environmentName: "pcf-uat",
			steps: 2,
			findings: 0,
		});
		expect(interest?.transcript.split("\n").slice(0, 3)).toEqual([
			"# Admin creates an interest",
			"Tags: source:exploration",
			"Env: pcf-uat",
		]);
		expect(interest?.transcript).toContain(
			"[Assert] the new interest is listed",
		);
		// The model failed: one Act per explored step, and the reason on the exploration.
		expect(signOut?.transcript).toContain(
			"[Act] Open Interests and click New interest",
		);
		expect(signOut?.exploration?.error).toContain("model down");
		// The runner could not explore: the item keeps its notes for the reviewer, is skipped by
		// default and says why.
		expect(report?.exploration).toMatchObject({
			status: "failed",
			error: "net::ERR_NAME_NOT_RESOLVED",
		});
		expect(report?.decision).toBe("skip");
		expect(report?.error).toBe(
			"Not explored: net::ERR_NAME_NOT_RESOLVED. Review the instructions before creating a case",
		);
		// [Login: PCF_HQ_ADMIN] uses the runner's built-in macro; lint knows it.
		expect(interest?.transcript).toContain("[Login: PCF_HQ_ADMIN]");
		expect(
			interest?.lint.filter((finding) => finding.ruleId === "unknown-macro"),
		).toEqual([]);
		expect(report?.transcript).toContain(
			"[Note] Open Reports and print the attendance report.",
		);

		const commit = await fixture.call<ImportBatch>(
			`/test-cases/import/${batchId}`,
			{
				method: "PATCH",
				token: fixture.admin.token,
				body: { commit: true },
			},
		);
		expect(commit.status).toBe(200);
		expect(commit.body.counts).toMatchObject({ created: 2, skipped: 1 });
	});

	it("never writes a blocked exploration as a test; rejects ungrounded transcripts; waits out a short 429", async () => {
		const calls: string[] = [];
		let rateLimited = false;
		const fixture = await createTestCaseFixture({
			dependencies: {
				generateText: async ({ prompt }) => {
					const title = /Title: (.*)/.exec(prompt)?.[1] ?? "";
					calls.push(title);
					if (title === "Retried after a rate limit" && !rateLimited) {
						rateLimited = true;
						// What the production gateway answered (alibaba/qwen3.7-flash, 5 RPM).
						throw Object.assign(
							new Error("429 Too Many Requests: 5RPM per region Retry after1s"),
							{ statusCode: 429 },
						);
					}
					if (title === "Hallucinated macro") {
						return "# X\n\n[Signin: PCF_HQ_ADMIN]\n## Checkpoint: c\n[Assert] the dashboard is shown";
					}
					return "# X\n\n[Login: PCF_HQ_ADMIN]\n## Checkpoint: c\n[Assert] the dashboard shows the navigation menu";
				},
			},
		});
		const { environmentId } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
			modelKey: FAKE_MODEL_KEY,
		});
		const created = await fixture.call<ImportBatch>("/test-cases/import", {
			token: fixture.admin.token,
			body: {
				sourceKind: "instructions",
				content: [
					"# ILHAM - Đăng nhập thành công",
					"Đăng nhập bằng PCF_HQ_ADMIN. Kiểm tra trang chính hiển thị menu điều hướng.",
					"",
					"# Hallucinated macro",
					"Sign in as PCF_HQ_ADMIN and check the dashboard.",
					"",
					"# Retried after a rate limit",
					"Sign in as PCF_HQ_ADMIN and check the dashboard.",
					"",
					"# Unknown profile",
					"Sign in as PCF_ALL_ACCESS_ACCOUNT and check the dashboard.",
				].join("\n"),
				environmentId,
				queueWithoutRunner: true,
			},
		});
		expect(created.status).toBe(201);
		const runner = await registerRunner(fixture);
		const claim = async () => {
			const response = await fixture.call<{
				exploration: ClaimedExploration | null;
			}>("/runner-pools/claim", { token: runner.workerToken, body: {} });
			if (!response.body.exploration)
				throw new Error("Expected an exploration");
			return response.body.exploration;
		};
		const passed = (goal: string): ExplorationRecord => ({
			goal,
			ended: "finished",
			summary: "The dashboard shows the navigation menu.",
			steps: [
				{
					index: 1,
					title: "Sign in",
					instruction: "Sign in as the HQ admin",
					status: "passed",
					summary: null,
					errorCode: null,
				},
			],
			findings: [],
		});

		// 1. Production ILHAM shape: `finished`, but the sign-in step blocked.
		const blocked = await claim();
		const blockedResult = await fixture.call(
			`/test-explorations/${blocked.explorationId}/result`,
			{
				token: runner.workerToken,
				body: {
					status: "done",
					explore: {
						goal: blocked.goal,
						ended: "finished",
						summary: "Login failed: the goal was not achieved.",
						steps: [
							{
								index: 1,
								title: "Sign in",
								instruction: "Sign in with the account",
								status: "blocked",
								summary: "username is empty",
								errorCode: "AUTH_CREDENTIAL_UNAVAILABLE",
							},
						],
						findings: [],
					},
				},
			},
		);
		expect(blockedResult.status).toBe(200);
		// 2. The model invents a macro: rejected, the explored steps are listed instead.
		const hallucinated = await claim();
		await fixture.call(
			`/test-explorations/${hallucinated.explorationId}/result`,
			{
				token: runner.workerToken,
				body: { status: "done", explore: passed(hallucinated.goal) },
			},
		);
		// 3. The model is rate limited once with a short Retry-After: tried again.
		const retried = await claim();
		const started = Date.now();
		await fixture.call(`/test-explorations/${retried.explorationId}/result`, {
			token: runner.workerToken,
			body: { status: "done", explore: passed(retried.goal) },
		});
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);
		// 4. A profile the organisation lacks is named; the runner is told before exploring.
		const unknown = await claim();
		const config = await fixture.call<ExplorationConfig>(
			`/test-explorations/${unknown.explorationId}/config`,
			{ token: runner.workerToken },
		);
		expect(config.body.missingProfiles).toEqual(["PCF_ALL_ACCESS_ACCOUNT"]);
		expect(config.body.credentials).toEqual([]);

		// The model was never asked about the blocked exploration.
		expect(calls).toEqual([
			"Hallucinated macro",
			"Retried after a rate limit",
			"Retried after a rate limit",
		]);
		const batch = await fixture.call<ImportBatch>(
			`/test-cases/import/${created.body.id}`,
			{ token: fixture.admin.token },
		);
		const [ilham, invented, rateLimitedItem] = batch.body.items;
		expect(ilham?.exploration).toMatchObject({
			status: "done",
			outcome: "blocked",
		});
		expect(ilham?.decision).toBe("skip");
		expect(ilham?.error).toBe(
			'Exploration blocked at step 1 "Sign in" blocked (AUTH_CREDENTIAL_UNAVAILABLE); the instructions were kept, not written as a test',
		);
		// Nothing replayable, and no Assert that the login failed.
		expect(ilham?.transcript).not.toContain("[Act]");
		expect(ilham?.transcript).not.toContain("[Assert]");
		expect(ilham?.transcript).not.toContain("Login failed");
		expect(ilham?.transcript).toContain(
			"[Note] Đăng nhập bằng PCF_HQ_ADMIN. Kiểm tra trang chính hiển thị menu điều hướng.",
		);
		expect(invented?.transcript).not.toContain("Signin");
		expect(invented?.transcript).toContain("[Act] Sign in as the HQ admin");
		expect(invented?.exploration?.error).toContain(
			'invalid transcript: line 3: No macro named "Signin".',
		);
		expect(invented?.decision).toBe("create");
		expect(rateLimitedItem?.transcript).toContain("[Login: PCF_HQ_ADMIN]");
		expect(rateLimitedItem?.exploration).toMatchObject({
			outcome: "passed",
			error: null,
		});

		// A heartbeat naming an exploration does not make it the worker's current run.
		await fixture.call("/runner-pools/heartbeat", {
			token: runner.workerToken,
			body: { runId: unknown.explorationId, load: 1 },
		});
		const pools = await fixture.call<{ items: RunnerPool[] }>("/runner-pools", {
			token: fixture.admin.token,
		});
		expect(
			pools.body.items
				.flatMap((pool) => pool.workers)
				.map((worker) => worker.currentRunId),
		).toEqual([null]);
	});

	it("stops waiting for a runner: queued items go to review unexplored, a claimed one carries on", async () => {
		const fixture = await createTestCaseFixture();
		const { environmentId } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
			modelKey: FAKE_MODEL_KEY,
		});
		const created = await fixture.call<ImportBatch>("/test-cases/import", {
			token: fixture.admin.token,
			body: {
				sourceKind: "instructions",
				content: instructions,
				environmentId,
				queueWithoutRunner: true,
			},
		});
		expect(created.status).toBe(201);
		const batchId = created.body.id;
		const runner = await registerRunner(fixture);
		const claimed = await fixture.call<{
			exploration: ClaimedExploration | null;
		}>("/runner-pools/claim", { token: runner.workerToken, body: {} });
		expect(claimed.body.exploration?.goal).toContain(
			"Admin creates an interest",
		);

		const stopped = await fixture.call<ImportBatch>(
			`/test-cases/import/${batchId}/explorations/cancel`,
			{ token: fixture.admin.token, body: {} },
		);
		expect(stopped.status).toBe(200);
		expect(
			stopped.body.items.map((item) => [
				item.state,
				item.exploration?.status,
				item.exploration?.error ?? null,
			]),
		).toEqual([
			["pending", "running", null],
			["ready", "failed", STOPPED_WAITING],
			["ready", "failed", STOPPED_WAITING],
		]);
		// The rows hold the instructions as notes for the reviewer.
		expect(stopped.body.items[1]?.transcript).toContain(
			"[Note] Sign out from the account menu.",
		);
		// One exploration is still running, so the batch waits for it.
		expect(stopped.body.status).toBe("parsing");

		await fixture.call(
			`/test-explorations/${claimed.body.exploration?.explorationId}/result`,
			{
				token: runner.workerToken,
				body: { status: "failed", explore: null, error: "timeout" },
			},
		);
		const after = await fixture.call<ImportBatch>(
			`/test-cases/import/${batchId}`,
			{ token: fixture.admin.token },
		);
		expect(after.body.status).toBe("ready");
		// Nothing left to claim.
		const empty = await fixture.call<{
			exploration: ClaimedExploration | null;
		}>("/runner-pools/claim", { token: runner.workerToken, body: {} });
		expect(empty.body.exploration).toBeNull();
	});
});
