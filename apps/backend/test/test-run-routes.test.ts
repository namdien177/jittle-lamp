import { describe, expect, it } from "bun:test";
import type {
	ClaimedRun,
	CreateTestRunResponse,
	TestRunConfig,
	TestRunDetail,
} from "@jittle-lamp/shared";
import { and, eq } from "drizzle-orm";

import {
	evidenceArtifacts,
	evidences,
	organizationActivityLogs,
	testCaseEvidences,
	testRuns,
} from "../src/db/schema";
import {
	createTestCaseFixture,
	FAKE_MODEL_KEY,
	FAKE_PASSWORD,
	loginTranscript,
} from "./test-case-fixtures";
import {
	buildEvidenceZip,
	buildRunReport,
	registerRunner,
	runnerInfo,
	seedRunnableCase,
} from "./test-run-fixtures";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("test run routes and runner contract", () => {
	it("runs a case end to end: queue, register, claim, config, progress, cache, evidence, finalize", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase, environmentId } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
			modelKey: FAKE_MODEL_KEY,
		});

		const requested = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{ token: fixture.qa.token, body: { params: { role: "HQ" } } },
		);
		expect(requested.status).toBe(201);
		expect(requested.body).toMatchObject({
			attached: false,
			status: "queued",
			queuePosition: 0,
			queueDepth: 1,
		});
		const runId = requested.body.runId;
		const queued = await fixture.call<TestRunDetail>(`/test-runs/${runId}`, {
			token: fixture.qa.token,
		});
		// The environment names a pool that does not exist yet.
		expect(queued.body.blockedReason).toBe("NO_RUNNER");
		expect(queued.body.runnerPool).toBe("self-hosted:devbox");
		expect(queued.body.steps.map((step) => step.status)).toEqual([
			"pending",
			"pending",
			"pending",
			"pending",
			"pending",
		]);
		expect(queued.body.environmentName).toBe("pcf-uat");

		const runner = await registerRunner(fixture);
		expect(runner.heartbeatMs).toBe(10_000);
		expect(runner.leaseMs).toBe(30_000);
		const ready = await fixture.call<TestRunDetail>(`/test-runs/${runId}`, {
			token: fixture.qa.token,
		});
		expect(ready.body.blockedReason).toBeNull();
		expect(ready.body.estimatedStartAt).toBeNumber();

		// A second request for the same case, version, environment, params and cache mode attaches.
		const attached = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{ token: fixture.developer.token, body: { params: { role: "HQ" } } },
		);
		expect(attached.status).toBe(200);
		expect(attached.body.runId).toBe(runId);
		expect(attached.body.attached).toBe(true);
		expect(
			attached.body.requestedBy.map((entry) => entry.userId).sort(),
		).toEqual([fixture.qa.userId, fixture.developer.userId].sort());

		const heartbeat = await fixture.call("/runner-pools/heartbeat", {
			token: runner.workerToken,
			body: { runId: null, load: 0 },
		});
		expect(heartbeat.body).toEqual({ ok: true });
		const claim = await fixture.call<{ run: ClaimedRun | null }>(
			"/runner-pools/claim",
			{ token: runner.workerToken, body: {} },
		);
		expect(claim.status).toBe(200);
		const claimed = claim.body.run;
		if (!claimed) throw new Error("Expected a claimed run");
		expect(claimed).toMatchObject({
			runId,
			testCaseId: testCase.id,
			testCaseKey: "TC-0001",
			transcriptVersion: 1,
			environmentId,
			params: { role: "HQ" },
			cacheMode: "read-write",
			attempt: 1,
		});
		expect(claimed.steps).toHaveLength(5);
		expect(claimed.runToken.startsWith("jl_run_")).toBe(true);
		const empty = await fixture.call<{ run: ClaimedRun | null }>(
			"/runner-pools/claim",
			{ token: runner.workerToken, body: {} },
		);
		expect(empty.body.run).toBeNull();
		const badWorker = await fixture.call("/runner-pools/claim", {
			token: "jl_rw_not-a-real-token",
			body: {},
		});
		expect(badWorker.status).toBe(401);

		const config = await fixture.call<TestRunConfig>(
			`/test-runs/${runId}/config`,
			{
				token: claimed.runToken,
			},
		);
		expect(config.status).toBe(200);
		expect(config.body.environment).toEqual({
			name: "pcf-uat",
			baseUrl: "https://uat.example.test",
			variables: { SCHOOL_CODE: "HQ" },
			agentInstructions: "Never delete records.",
		});
		// Only the profile the transcript references is decrypted.
		expect(config.body.credentials).toEqual([
			{
				profile: "PCF_HQ_ADMIN",
				fields: { username: "hq.admin@example.test" },
				secretFields: { password: FAKE_PASSWORD },
			},
		]);
		expect(config.body.model).toEqual({
			act: "anthropic/claude-opus-5-5",
			judge: "anthropic/claude-sonnet-5-5",
			apiKeys: { ANTHROPIC_API_KEY: FAKE_MODEL_KEY },
		});
		expect(config.body.prices.length).toBeGreaterThan(0);
		const reads = await fixture.db.query.organizationActivityLogs.findMany({
			where: and(
				eq(organizationActivityLogs.organizationId, fixture.orgId),
				eq(organizationActivityLogs.action, "test_config.secret_read"),
			),
		});
		const runReads = reads.filter(
			(log) => JSON.parse(log.metadataJson).runId === runId,
		);
		expect(runReads).toHaveLength(2);
		expect(runReads.every((log) => log.actorUserId === fixture.qa.userId)).toBe(
			true,
		);
		for (const log of reads) {
			expect(log.metadataJson).not.toContain(FAKE_PASSWORD);
			expect(log.metadataJson).not.toContain(FAKE_MODEL_KEY);
		}
		// Neither a session nor the worker token can read the config.
		expect(
			(
				await fixture.call(`/test-runs/${runId}/config`, {
					token: fixture.admin.token,
				})
			).status,
		).toBe(401);
		expect(
			(
				await fixture.call(`/test-runs/${runId}/config`, {
					token: runner.workerToken,
				})
			).status,
		).toBe(401);

		const firstStep = claimed.steps[0];
		const progress = await fixture.call<{
			cancelRequested: boolean;
			leaseExpiresAt: number;
		}>(`/test-runs/${runId}/progress`, {
			method: "PATCH",
			token: claimed.runToken,
			body: {
				status: "running",
				currentStepId: firstStep?.stepId,
				runnerInfo,
				steps: [
					{
						stepId: firstStep?.stepId,
						status: "running",
						ordinal: 1,
						type: "open",
					},
				],
				screenshot: {
					stepId: firstStep?.stepId,
					mimeType: "image/png",
					base64: Buffer.from(PNG).toString("base64"),
				},
			},
		});
		expect(progress.status).toBe(200);
		expect(progress.body.cancelRequested).toBe(false);
		expect(progress.body.leaseExpiresAt).toBeGreaterThan(Date.now());
		const running = await fixture.call<TestRunDetail>(`/test-runs/${runId}`, {
			token: fixture.developer.token,
		});
		expect(running.body.status).toBe("running");
		expect(running.body.currentStepId).toBe(firstStep?.stepId ?? "");
		expect(running.body.steps[0]?.status).toBe("running");
		expect(running.body.runnerInfo?.host).toBe("self-hosted");

		const miss = await fixture.call<{ status: string }>(
			`/test-runs/${runId}/cache/key-1`,
			{ token: claimed.runToken },
		);
		expect(miss.body).toEqual({ status: "miss" });
		const actStep = claimed.steps.find((step) => step.type === "act");
		const write = await fixture.call(`/test-runs/${runId}/cache/key-1`, {
			method: "PUT",
			token: claimed.runToken,
			body: {
				entry: {
					schemaVersion: "trace-1",
					createdAt: "now",
					payload: { actions: [] },
				},
				stepIds: [actStep?.stepId],
				instructionKey: actStep?.instructionKey,
				renderedCode: "await page.getByRole('button').click();",
			},
		});
		expect(write.body).toEqual({ ok: true });
		const hit = await fixture.call<{ status: string; entry: unknown }>(
			`/test-runs/${runId}/cache/key-1`,
			{ token: claimed.runToken },
		);
		expect(hit.body).toEqual({
			status: "hit",
			entry: {
				schemaVersion: "trace-1",
				createdAt: "now",
				payload: { actions: [] },
			},
		});

		const report = buildRunReport(claimed);
		const upload = await fixture.call<{ evidenceId: string }>(
			`/test-runs/${runId}/evidence`,
			{
				method: "POST",
				token: claimed.runToken,
				raw: buildEvidenceZip(report, { [firstStep?.stepId ?? "x"]: PNG }),
				headers: { "content-type": "application/zip" },
			},
		);
		expect(upload.status).toBe(201);
		const evidenceId = upload.body.evidenceId;
		const evidence = await fixture.db.query.evidences.findFirst({
			where: eq(evidences.id, evidenceId),
		});
		expect(evidence).toMatchObject({
			sourceType: "test-run",
			sourceExternalId: runId,
			createdBy: fixture.qa.userId,
			orgId: fixture.orgId,
		});
		const artifacts = await fixture.db.query.evidenceArtifacts.findMany({
			where: eq(evidenceArtifacts.evidenceId, evidenceId),
		});
		expect(artifacts.map((artifact) => artifact.kind).sort()).toEqual([
			"attachment",
			"network-log",
			"recording",
			"screenshot",
		]);
		expect(
			artifacts.every((artifact) => artifact.uploadStatus === "uploaded"),
		).toBe(true);
		const repeat = await fixture.call<{ evidenceId: string }>(
			`/test-runs/${runId}/evidence`,
			{
				method: "POST",
				token: claimed.runToken,
				raw: buildEvidenceZip(report),
				headers: { "content-type": "application/zip" },
			},
		);
		expect(repeat.status).toBe(200);
		expect(repeat.body.evidenceId).toBe(evidenceId);

		const finalized = await fixture.call<TestRunDetail>(
			`/test-runs/${runId}/finalize`,
			{
				token: claimed.runToken,
				body: { report, evidenceId },
			},
		);
		expect(finalized.status).toBe(200);
		expect(finalized.body).toMatchObject({
			status: "completed",
			outcome: "passed",
			evidenceId,
			flaky: false,
		});
		// 1 act: (1000 × 4 + 500 × 0.2 + 150 × 20) / 1e6; 2 asserts: (400 × 2 + 20 × 10) / 1e6 each.
		expect(finalized.body.metrics).toMatchObject({
			modelId: "anthropic/claude-opus-5-5",
			judgeModelId: "anthropic/claude-sonnet-5-5",
			provider: "anthropic",
			modelCalls: 4,
			inputTokens: 1800,
			cachedInputTokens: 500,
			outputTokens: 140,
			reasoningTokens: 50,
			costUsd: 0.0091,
			priceTableVersion: "seed-2026-09-25",
			durationMs: 10_000,
			stepsTotal: 5,
			stepsAgent: 1,
		});
		expect(finalized.body.steps.every((step) => step.status === "passed")).toBe(
			true,
		);
		expect(finalized.body.steps[0]?.screenshotUrl).toBeNull();
		const link = await fixture.db.query.testCaseEvidences.findFirst({
			where: eq(testCaseEvidences.evidenceId, evidenceId),
		});
		expect(link).toMatchObject({
			testCaseId: testCase.id,
			runId,
			relation: "run",
		});
		expect(
			(
				await fixture.call(`/test-runs/${runId}/progress`, {
					method: "PATCH",
					token: claimed.runToken,
					body: {},
				})
			).status,
		).toBe(401);
		const stats = await fixture.call<{
			stats: { runs: number; lastOutcome: string };
		}>(`/test-cases/${testCase.id}`, { token: fixture.qa.token });
		expect(stats.body.stats).toMatchObject({
			runs: 1,
			lastOutcome: "passed",
			passRate: 1,
			avgCostUsd: 0.0091,
			cachedSteps: 1,
		});

		// Within the dedupe window a repeat request attaches to the finished run unless forced.
		const recent = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{ token: fixture.qa.token, body: { params: { role: "HQ" } } },
		);
		expect(recent.body).toMatchObject({
			runId,
			attached: true,
			status: "completed",
		});
		const forced = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{
				token: fixture.qa.token,
				body: { params: { role: "HQ" }, force: true },
			},
		);
		expect(forced.status).toBe(201);
		expect(forced.body.runId).not.toBe(runId);
	});

	it("applies queue caps and the token bucket with 429s", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});
		const settings = await fixture.call("/test-run-settings", {
			method: "PUT",
			token: fixture.admin.token,
			body: {
				maxConcurrentRuns: 1,
				dedupeWindowSeconds: 120,
				maxQueuedRuns: 3,
				maxQueuedPerCase: 2,
				tokenBucketSize: 4,
				tokenBucketWindowSeconds: 600,
				dailyBudgetUsd: null,
				retention: { failedDays: 180, passedDays: 30 },
			},
		});
		expect(settings.status).toBe(200);
		const run = (params: Record<string, string>, token = fixture.qa.token) =>
			fixture.call<CreateTestRunResponse>(`/test-cases/${testCase.id}/runs`, {
				token,
				body: { params },
			});
		expect((await run({ n: "1" })).status).toBe(201);
		expect((await run({ n: "2" })).status).toBe(201);
		const perCase = await run({ n: "3" });
		expect(perCase.status).toBe(429);
		expect(perCase.body).toMatchObject({
			error: { code: "QUEUE_FULL" },
			depth: 2,
			maxQueuedPerCase: 2,
		});
		// Attaching does not count against the caps.
		expect((await run({ n: "1" })).body.attached).toBe(true);
		const limited = await run({ n: "1" });
		expect(limited.status).toBe(429);
		expect(limited.body).toMatchObject({ error: { code: "RATE_LIMITED" } });
		expect(
			(limited.body as unknown as { retryAfter: number }).retryAfter,
		).toBeGreaterThan(0);
		expect(limited.headers.get("retry-after")).toBe(
			String((limited.body as unknown as { retryAfter: number }).retryAfter),
		);
		// Another user has their own bucket; the organisation cap of 3 queued still holds.
		const other = await fixture.call<{ id: string }>("/test-cases", {
			token: fixture.admin.token,
			body: { transcript: "# Other\n\n[Act] other" },
		});
		const otherRun = (n: string) =>
			fixture.call(`/test-cases/${other.body.id}/runs`, {
				token: fixture.admin.token,
				body: { params: { n } },
			});
		expect((await otherRun("1")).status).toBe(201);
		const orgFull = await otherRun("2");
		expect(orgFull.status).toBe(429);
		expect(orgFull.body).toMatchObject({
			error: { code: "QUEUE_FULL" },
			depth: 3,
			maxQueuedRuns: 3,
		});
	});

	it("lets the requester cancel, unsubscribes others and signals running runs", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});
		const first = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{ token: fixture.qa.token, body: {} },
		);
		await fixture.call(`/test-cases/${testCase.id}/runs`, {
			token: fixture.developer.token,
			body: {},
		});
		const unsubscribed = await fixture.call<{
			unsubscribed: boolean;
			status: string;
		}>(`/test-runs/${first.body.runId}/cancel`, {
			token: fixture.developer.token,
			body: {},
		});
		expect(unsubscribed.body).toMatchObject({
			unsubscribed: true,
			status: "queued",
		});
		const again = await fixture.call(`/test-runs/${first.body.runId}/cancel`, {
			token: fixture.developer.token,
			body: {},
		});
		expect(again.status).toBe(403);
		const cancelled = await fixture.call<{
			cancelled: boolean;
			status: string;
		}>(`/test-runs/${first.body.runId}/cancel`, {
			token: fixture.qa.token,
			body: {},
		});
		expect(cancelled.body).toMatchObject({
			cancelled: true,
			status: "cancelled",
		});

		const runner = await registerRunner(fixture);
		const second = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{ token: fixture.qa.token, body: {} },
		);
		const claim = await fixture.call<{ run: ClaimedRun }>(
			"/runner-pools/claim",
			{
				token: runner.workerToken,
				body: {},
			},
		);
		expect(claim.body.run.runId).toBe(second.body.runId);
		const requested = await fixture.call<{
			cancelRequested: boolean;
			status: string;
		}>(`/test-runs/${second.body.runId}/cancel`, {
			token: fixture.admin.token,
			body: {},
		});
		expect(requested.body).toMatchObject({
			cancelRequested: true,
			status: "claimed",
		});
		const progress = await fixture.call<{ cancelRequested: boolean }>(
			`/test-runs/${second.body.runId}/progress`,
			{
				method: "PATCH",
				token: claim.body.run.runToken,
				body: { status: "running" },
			},
		);
		expect(progress.body.cancelRequested).toBe(true);
		const report = buildRunReport(claim.body.run, {
			status: "cancelled",
			outcome: "blocked",
		});
		const final = await fixture.call<TestRunDetail>(
			`/test-runs/${second.body.runId}/finalize`,
			{ token: claim.body.run.runToken, body: { report, evidenceId: null } },
		);
		expect(final.body).toMatchObject({ status: "cancelled", outcome: null });
	});

	it("accepts automation tokens only on the CI routes and rejects unrunnable cases", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});
		const ci = await fixture.automationToken(fixture.qa);
		const run = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{ token: ci, body: { trigger: "ci" } },
		);
		expect(run.status).toBe(201);
		const row = await fixture.db.query.testRuns.findFirst({
			where: eq(testRuns.id, run.body.runId),
		});
		expect(row).toMatchObject({
			trigger: "ci",
			priority: 10,
			createdBy: fixture.qa.userId,
		});
		expect(
			(await fixture.call(`/test-runs/${run.body.runId}`, { token: ci }))
				.status,
		).toBe(200);
		expect((await fixture.call("/test-cases", { token: ci })).status).toBe(200);
		const exported = await fixture.call<{ document: string }>(
			`/test-cases/export?ids=${testCase.id}`,
			{ token: ci },
		);
		expect(exported.body.document).toContain("Key: TC-0001");
		const patched = await fixture.call(`/test-cases/${testCase.id}`, {
			method: "PATCH",
			token: ci,
			body: { transcript: `${testCase.transcript}\n[Note] from CI` },
		});
		expect(patched.status).toBe(200);
		for (const [path, method] of [
			["/test-cases", "POST"],
			["/test-environments", "GET"],
			["/test-credentials", "GET"],
			[`/test-cases/${testCase.id}`, "DELETE"],
			["/runner-pools", "GET"],
		] as const) {
			const response = await fixture.call(path, {
				method,
				token: ci,
				...(method === "POST"
					? { body: { transcript: loginTranscript() } }
					: {}),
			});
			expect(response.status).toBe(403);
			expect(response.body).toMatchObject({
				error: { code: "AUTOMATION_ACTION_FORBIDDEN" },
			});
		}
		// The owner's role still applies: a developer's token cannot edit cases.
		const devToken = await fixture.automationToken(fixture.developer);
		const devPatch = await fixture.call(`/test-cases/${testCase.id}`, {
			method: "PATCH",
			token: devToken,
			body: { status: "archived" },
		});
		expect(devPatch.status).toBe(403);

		const review = await fixture.call<{ id: string }>("/test-cases", {
			token: fixture.qa.token,
			body: { transcript: "# Needs review\n\n[Act] x", status: "review" },
		});
		const blocked = await fixture.call(`/test-cases/${review.body.id}/runs`, {
			token: fixture.qa.token,
			body: {},
		});
		expect(blocked.status).toBe(409);
		expect(blocked.body).toMatchObject({
			error: { code: "TEST_CASE_NOT_RUNNABLE" },
		});
	});
});
