import { describe, expect, it } from "bun:test";
import type {
	ClaimedRun,
	CreateTestRunResponse,
	TestCaseDetail,
	TestRunDetail,
} from "@jittle-lamp/shared";
import { and, eq } from "drizzle-orm";

import {
	evidences,
	testCases,
	testModelPrices,
	testRuns,
	testStepScripts,
} from "../src/db/schema";
import {
	applyTestRunRetention,
	DEFAULT_PASSED_RUN_RETENTION_DAYS,
} from "../src/services/evidence-maintenance";
import { defaultRunSettings } from "../src/services/test-runs";
import { saveRunSettings } from "../src/services/test-settings";
import {
	createTestCaseFixture,
	FAKE_PASSWORD,
	type TestCaseFixture,
} from "./test-case-fixtures";
import {
	buildEvidenceZip,
	buildRunReport,
	registerRunner,
	seedRunnableCase,
} from "./test-run-fixtures";

const DAY = 24 * 60 * 60 * 1000;

const claimNext = async (fixture: TestCaseFixture, workerToken: string) => {
	const claim = await fixture.call<{ run: ClaimedRun | null }>(
		"/runner-pools/claim",
		{ token: workerToken, body: {} },
	);
	if (!claim.body.run) throw new Error("Expected a claimed run");
	return claim.body.run;
};

const finalize = (
	fixture: TestCaseFixture,
	claimed: ClaimedRun,
	report: ReturnType<typeof buildRunReport>,
	evidenceId: string | null = null,
) =>
	fixture.call<TestRunDetail>(`/test-runs/${claimed.runId}/finalize`, {
		token: claimed.runToken,
		body: { report, evidenceId },
	});

describe("run finalisation", () => {
	it("retries a failed run per case retries and marks a later pass flaky", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});
		await fixture.call(`/test-cases/${testCase.id}`, {
			method: "PATCH",
			token: fixture.qa.token,
			body: {
				transcript: testCase.transcript.replace("Tags:", "Retries: 1\nTags:"),
			},
		});
		const runner = await registerRunner(fixture);
		const requested = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{ token: fixture.qa.token, body: {} },
		);
		await fixture.call(`/test-cases/${testCase.id}/runs`, {
			token: fixture.developer.token,
			body: {},
		});
		const first = await claimNext(fixture, runner.workerToken);
		const failed = await finalize(
			fixture,
			first,
			buildRunReport(first, { outcome: "failed" }),
		);
		expect(failed.body).toMatchObject({
			status: "failed",
			outcome: "failed",
			flaky: false,
		});
		const retry = await fixture.db.query.testRuns.findFirst({
			where: eq(testRuns.retryOfRunId, requested.body.runId),
		});
		expect(retry).toMatchObject({ status: "queued", retryAttempt: 2 });
		const retryDetail = await fixture.call<TestRunDetail>(
			`/test-runs/${retry?.id}`,
			{
				token: fixture.developer.token,
			},
		);
		// Everyone waiting on the first attempt follows the retry.
		expect(
			retryDetail.body.subscribers.map((entry) => entry.userId).sort(),
		).toEqual([fixture.qa.userId, fixture.developer.userId].sort());

		const second = await claimNext(fixture, runner.workerToken);
		expect(second.runId).toBe(retry?.id ?? "");
		const passed = await finalize(fixture, second, buildRunReport(second));
		expect(passed.body).toMatchObject({ outcome: "passed", flaky: true });
		const detail = await fixture.call<TestCaseDetail>(
			`/test-cases/${testCase.id}`,
			{
				token: fixture.qa.token,
			},
		);
		// The superseded attempt does not count; the retry carries the verdict.
		expect(detail.body.stats).toMatchObject({
			runs: 1,
			lastOutcome: "passed",
			passRate: 1,
			flakyRate: 1,
		});

		// Retries are spent: a failing retry is final.
		await fixture.call(`/test-cases/${testCase.id}/runs`, {
			token: fixture.qa.token,
			body: { force: true },
		});
		const third = await claimNext(fixture, runner.workerToken);
		await finalize(
			fixture,
			third,
			buildRunReport(third, { outcome: "failed" }),
		);
		const fourth = await fixture.call<{ run: ClaimedRun | null }>(
			"/runner-pools/claim",
			{ token: runner.workerToken, body: {} },
		);
		expect(fourth.body.run?.attempt).toBe(1);
		if (!fourth.body.run)
			throw new Error("Expected the retry of the third run");
		await finalize(
			fixture,
			fourth.body.run,
			buildRunReport(fourth.body.run, { outcome: "failed" }),
		);
		const fifth = await fixture.call<{ run: ClaimedRun | null }>(
			"/runner-pools/claim",
			{ token: runner.workerToken, body: {} },
		);
		expect(fifth.body.run).toBeNull();
	});

	it("prices from the org table, lets provider cost win and verifies or stales scripts", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});
		const runner = await registerRunner(fixture);
		await fixture.db.insert(testModelPrices).values({
			orgId: fixture.orgId,
			modelId: "anthropic/claude-opus-5-5",
			inputUsdPerMtok: 10,
			cachedInputUsdPerMtok: 1,
			outputUsdPerMtok: 50,
			version: "negotiated-2026",
			effectiveFrom: 1,
		});
		const actStep = testCase.steps.find((step) => step.type === "act");
		const assertStep = testCase.steps.find((step) => step.type === "assert");
		if (!actStep || !assertStep)
			throw new Error("Expected act and assert steps");
		const now = Date.now();
		for (const step of [actStep, assertStep]) {
			await fixture.db.insert(testStepScripts).values({
				orgId: fixture.orgId,
				testCaseId: testCase.id,
				stepId: step.stepId,
				stepIdsJson: JSON.stringify([step.stepId]),
				instructionKey: step.instructionKey,
				keyHash: `key-${step.stepId}`,
				entryJson: "{}",
				createdAt: now,
				updatedAt: now,
			});
		}

		await fixture.call(`/test-cases/${testCase.id}/runs`, {
			token: fixture.qa.token,
			body: {},
		});
		const first = await claimNext(fixture, runner.workerToken);
		const modes = first.steps.map((step) =>
			step.stepId === actStep.stepId
				? ("replayed" as const)
				: step.stepId === assertStep.stepId
					? ("handoff" as const)
					: null,
		);
		const priced = await finalize(
			fixture,
			first,
			buildRunReport(first, { modes }),
		);
		// Act at the org rate: (1000 × 10 + 500 × 1 + 150 × 50) / 1e6 = 0.018; asserts at the seed rate.
		expect(priced.body.metrics.costUsd).toBe(0.02);
		expect(priced.body.metrics.priceTableVersion).toBe(
			"org:negotiated-2026+seed-2026-10-03",
		);
		expect(priced.body.metrics.stepsReplayed).toBe(1);
		expect(priced.body.metrics.stepsHandoff).toBe(1);
		const actScript = await fixture.db.query.testStepScripts.findFirst({
			where: eq(testStepScripts.stepId, actStep.stepId),
		});
		expect(actScript).toMatchObject({ status: "active", verifiedCount: 1 });
		expect(actScript?.lastReplayedAt).toBeNumber();
		const assertScript = await fixture.db.query.testStepScripts.findFirst({
			where: eq(testStepScripts.stepId, assertStep.stepId),
		});
		expect(assertScript?.status).toBe("stale");
		expect(assertScript?.staleReason).toContain(first.runId);
		expect(
			priced.body.steps.find((step) => step.stepId === actStep.stepId)?.mode,
		).toBe("replayed");

		await fixture.call(`/test-cases/${testCase.id}/runs`, {
			token: fixture.qa.token,
			body: { force: true },
		});
		const second = await claimNext(fixture, runner.workerToken);
		const provider = await finalize(
			fixture,
			second,
			buildRunReport(second, { providerCost: 0.5 }),
		);
		expect(provider.body.metrics).toMatchObject({
			priceTableVersion: "provider",
			costUsd: 1.5,
		});
	});

	it("queues one read-write repair run for a strict run that stopped on REPLAY_STALE, deduped, and shows it on the detail", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});
		const runner = await registerRunner(fixture);
		const suite = await fixture.call<{ id: string }>("/test-suites", {
			token: fixture.qa.token,
			body: { name: "Regression", memberIds: [testCase.id] },
		});
		expect(suite.status).toBe(201);
		// A suite batch without a cache mode is the regression run: strict (roadmap §4.3).
		const requested = await fixture.call<CreateTestRunResponse>(
			`/test-suites/${suite.body.id}/runs`,
			{ token: fixture.qa.token, body: {} },
		);
		expect(requested.status).toBe(201);
		const strict = await claimNext(fixture, runner.workerToken);
		expect(strict.cacheMode).toBe("strict");
		const actStep = strict.steps.find((step) => step.type === "act");
		const staleReport = (claimed: ClaimedRun) => {
			const report = buildRunReport(claimed);
			return {
				...report,
				outcome: "blocked" as const,
				blockedReason: "REPLAY_STALE" as const,
				steps: report.steps.map((step) =>
					step.stepId === actStep?.stepId
						? {
								...step,
								status: "blocked" as const,
								mode: "agent" as const,
								cacheReason: "action-failed" as const,
								usage: { ...step.usage, modelCalls: 0 },
								error: {
									code: "REPLAY_STALE",
									message: "the recording of this step no longer replays",
								},
							}
						: step,
				),
				errors: [{ code: "REPLAY_STALE", message: "stale" }],
			};
		};
		const blocked = await finalize(fixture, strict, staleReport(strict));
		expect(blocked.status).toBe(200);
		expect(blocked.body.outcome).toBe("blocked");
		expect(blocked.body.blockedReason).toBe("REPLAY_STALE");
		const repairs = await fixture.db.query.testRuns.findMany({
			where: eq(testRuns.trigger, "repair"),
		});
		expect(repairs).toHaveLength(1);
		expect(repairs[0]).toMatchObject({
			testCaseId: testCase.id,
			cacheMode: "read-write",
			status: "queued",
			retryOfRunId: strict.runId,
			retryAttempt: 1,
			batchId: null,
			priority: 10,
		});
		expect(blocked.body.repairRunId).toBe(repairs[0]?.id ?? "");
		// The batch keeps the strict verdict; the repair is off the critical path.
		const batch = await fixture.call<{
			status: string;
			counts: { blocked: number; pending: number };
		}>(`/test-run-batches/${requested.body.batchId}`, {
			token: fixture.qa.token,
		});
		expect(batch.body.status).toBe("failed");
		expect(batch.body.counts).toMatchObject({ blocked: 1, pending: 0 });

		// A second strict run of the same case stops the same way: no second repair while one is open.
		await fixture.call(`/test-cases/${testCase.id}/runs`, {
			token: fixture.qa.token,
			body: { cacheMode: "strict", force: true },
		});
		const again = await claimNext(fixture, runner.workerToken);
		expect(again.cacheMode).toBe("strict");
		await finalize(fixture, again, staleReport(again));
		expect(
			await fixture.db.query.testRuns.findMany({
				where: eq(testRuns.trigger, "repair"),
			}),
		).toHaveLength(1);

		// The repair run itself is claimable and runs read-write; its own stale stop queues nothing.
		const repair = await claimNext(fixture, runner.workerToken);
		expect(repair.runId).toBe(repairs[0]?.id ?? "");
		expect(repair.cacheMode).toBe("read-write");
		await finalize(fixture, repair, staleReport(repair));
		expect(
			await fixture.db.query.testRuns.findMany({
				where: eq(testRuns.trigger, "repair"),
			}),
		).toHaveLength(1);
		// Once the repair is finished, a later stale strict run gets a new one.
		await fixture.call(`/test-cases/${testCase.id}/runs`, {
			token: fixture.qa.token,
			body: { cacheMode: "strict", force: true },
		});
		const later = await claimNext(fixture, runner.workerToken);
		const laterResult = await finalize(fixture, later, staleReport(later));
		expect(laterResult.status).toBe(200);
		expect(
			await fixture.db.query.testRuns.findMany({
				where: eq(testRuns.trigger, "repair"),
			}),
		).toHaveLength(2);
		// A case run without a cache mode stays read-write.
		const manual = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{ token: fixture.qa.token, body: { force: true } },
		);
		const manualRun = await fixture.call<TestRunDetail>(
			`/test-runs/${manual.body.runId}`,
			{ token: fixture.qa.token },
		);
		expect(manualRun.body.cacheMode).toBe("read-write");
		expect(manualRun.body.repairRunId).toBeNull();
	});

	it("verifies an assert check replayed deterministically", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});
		const runner = await registerRunner(fixture);
		const assertStep = testCase.steps.find((step) => step.type === "assert");
		if (!assertStep) throw new Error("Expected an assert step");
		const now = Date.now();
		await fixture.db.insert(testStepScripts).values({
			orgId: fixture.orgId,
			testCaseId: testCase.id,
			stepId: assertStep.stepId,
			stepIdsJson: JSON.stringify([assertStep.stepId]),
			instructionKey: assertStep.instructionKey,
			keyHash: `check:${assertStep.stepId}`,
			kind: "assert-check",
			entryJson: "null",
			checkJson: JSON.stringify({
				schemaVersion: "jl-assert-check-1",
				locator: { role: "heading", name: "Sign in" },
				matcher: "visible",
				expected: null,
				recordedAt: new Date(now).toISOString(),
			}),
			renderedCode:
				"expect(screen.getByRole('heading', 'Sign in')).toBeVisible()",
			createdAt: now,
			updatedAt: now,
		});
		await fixture.call(`/test-cases/${testCase.id}/runs`, {
			token: fixture.qa.token,
			body: {},
		});
		const claimed = await claimNext(fixture, runner.workerToken);
		const modes = claimed.steps.map((step) =>
			step.stepId === assertStep.stepId ? ("deterministic" as const) : null,
		);
		const report = buildRunReport(claimed, { modes });
		await finalize(fixture, claimed, {
			...report,
			steps: report.steps.map((step) =>
				step.stepId === assertStep.stepId
					? {
							...step,
							cacheReason: "hit" as const,
							usage: { ...step.usage, modelCalls: 0 },
						}
					: step,
			),
		});
		const script = await fixture.db.query.testStepScripts.findFirst({
			where: eq(testStepScripts.stepId, assertStep.stepId),
		});
		expect(script).toMatchObject({
			kind: "assert-check",
			status: "active",
			verifiedCount: 1,
		});
		const detail = await fixture.call<TestCaseDetail>(
			`/test-cases/${testCase.id}`,
			{ token: fixture.qa.token },
		);
		// The check counts as a cached step without any UI change.
		expect(detail.body.stats.cachedSteps).toBe(1);
	});

	it("moves expired run evidence to the bin and keeps the latest run per case", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});
		const runner = await registerRunner(fixture, "devbox", 5);
		const evidenceFor = async (
			outcome: "passed" | "failed" | "blocked",
			ageDays: number,
		) => {
			await fixture.call(`/test-cases/${testCase.id}/runs`, {
				token: fixture.qa.token,
				body: { force: true },
			});
			const claimed = await claimNext(fixture, runner.workerToken);
			const report = buildRunReport(claimed, { outcome });
			const upload = await fixture.call<{ evidenceId: string }>(
				`/test-runs/${claimed.runId}/evidence`,
				{
					method: "POST",
					token: claimed.runToken,
					raw: buildEvidenceZip(report),
					headers: { "content-type": "application/zip" },
				},
			);
			await finalize(fixture, claimed, report, upload.body.evidenceId);
			await fixture.db
				.update(testRuns)
				.set({ finishedAt: Date.now() - ageDays * DAY })
				.where(eq(testRuns.id, claimed.runId));
			return upload.body.evidenceId;
		};
		const oldPassed = await evidenceFor("passed", 40);
		const recentPassed = await evidenceFor("passed", 10);
		const oldFailed = await evidenceFor("failed", 40);
		const ancientBlocked = await evidenceFor("blocked", 200);
		const latest = await evidenceFor("passed", 1);
		// Make the newest run old too: it is still the latest run of the case and stays.
		await fixture.db
			.update(testRuns)
			.set({ finishedAt: Date.now() - 400 * DAY + 1 })
			.where(eq(testRuns.evidenceId, latest));
		await fixture.db
			.update(testRuns)
			.set({ finishedAt: Date.now() - 300 * DAY })
			.where(eq(testRuns.evidenceId, ancientBlocked));

		const deleted = async () =>
			(
				await fixture.db.query.evidences.findMany({
					where: eq(evidences.orgId, fixture.orgId),
					columns: { id: true, deletedAt: true, deletePurgesAt: true },
				})
			)
				.filter((row) => row.deletedAt !== null)
				.map((row) => row.id)
				.sort();

		expect(DEFAULT_PASSED_RUN_RETENTION_DAYS).toBe(30);
		// Ordering: latest by finished_at is recentPassed now (10 days); `latest` was pushed back.
		expect(await applyTestRunRetention(fixture.db)).toBe(3);
		expect(await deleted()).toEqual([oldPassed, ancientBlocked, latest].sort());
		const binned = await fixture.db.query.evidences.findFirst({
			where: and(
				eq(evidences.id, oldPassed),
				eq(evidences.orgId, fixture.orgId),
			),
		});
		expect(binned?.deletePurgesAt).toBeGreaterThan(Date.now());
		expect(oldFailed).toBeString();
		expect(recentPassed).toBeString();
		expect(await applyTestRunRetention(fixture.db)).toBe(0);

		// Per-organisation override: failed evidence kept only 30 days.
		await saveRunSettings(fixture.db, fixture.orgId, fixture.admin.userId, {
			...defaultRunSettings,
			retention: { failedDays: 30, passedDays: 30 },
		});
		expect(await applyTestRunRetention(fixture.db)).toBe(1);
		expect(await deleted()).toEqual(
			[oldPassed, ancientBlocked, latest, oldFailed].sort(),
		);
		const remaining = await fixture.db.query.testCases.findFirst({
			where: eq(testCases.id, testCase.id),
		});
		expect(remaining?.deletedAt).toBeNull();
	});
});
