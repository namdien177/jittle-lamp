import { describe, expect, it } from "bun:test";
import {
	type ClaimedRun,
	type CreateTestRunResponse,
	createTestRunRequestSchema,
	type TestRunDetail,
	type TestRunSettings,
} from "@jittle-lamp/shared";
import { eq } from "drizzle-orm";

import { testRuns } from "../src/db/schema";
import { createRunnerPool, registerWorker } from "../src/services/runner-pools";
import { createTestCase } from "../src/services/test-cases";
import {
	budgetDayStart,
	modelSpendToday,
} from "../src/services/test-run-budget";
import { claimNextRun, sweepRunQueue } from "../src/services/test-run-queue";
import { defaultRunSettings, requestRuns } from "../src/services/test-runs";
import { saveRunSettings } from "../src/services/test-settings";
import { createTestCaseFixture, FAKE_PASSWORD } from "./test-case-fixtures";
import { registerRunner, seedRunnableCase } from "./test-run-fixtures";

// Daily model budget (design.md §10.3): over budget, new runs wait as queued BUDGET_EXCEEDED and
// are not claimable until the next UTC day or until the budget is raised.

const DAY_MS = 24 * 60 * 60 * 1000;
// Noon UTC, so "an hour later" stays on the same budget day.
const NOON = Date.UTC(2026, 9, 3, 12, 0, 0);

const roomySettings = (dailyBudgetUsd: number | null): TestRunSettings => ({
	...defaultRunSettings,
	maxConcurrentRuns: 5,
	maxQueuedRuns: 1000,
	maxQueuedPerCase: 100,
	tokenBucketSize: 1000,
	dailyBudgetUsd,
});

const setup = async (dailyBudgetUsd: number | null) => {
	const fixture = await createTestCaseFixture();
	const { db, orgId, qa } = fixture;
	await saveRunSettings(
		db,
		orgId,
		fixture.admin.userId,
		roomySettings(dailyBudgetUsd),
	);
	const environmentId = (
		await fixture.call<{ id: string }>("/test-environments", {
			token: fixture.admin.token,
			body: {
				name: "budget-env",
				baseUrl: "https://uat.example.test",
				runnerPool: "self-hosted:budget",
			},
		})
	).body.id;
	const { pool, registrationToken } = await createRunnerPool(db, {
		orgId,
		userId: fixture.admin.userId,
		name: "budget",
		maxConcurrentRuns: 5,
	});
	const worker = await registerWorker(db, {
		registrationToken,
		request: {
			hostname: "budget-1",
			version: "1.8.2",
			capabilities: { browsers: ["chromium"], headed: false, liveView: false },
		},
	});
	const testCase = await createTestCase(db, {
		orgId,
		userId: qa.userId,
		transcript: "# Budget case\n\n[Act] do something",
		status: "active",
		environmentId,
		source: "manual",
	});
	const request = async (now: number) => {
		const { results } = await requestRuns(db, {
			orgId,
			requester: { userId: qa.userId, tokenId: null, kind: "session" },
			cases: [
				{
					row: testCase,
					request: createTestRunRequestSchema.parse({
						params: { n: crypto.randomUUID() },
					}),
				},
			],
			now,
		});
		const runId = results[0]?.runId;
		if (!runId) throw new Error("Expected a run");
		return runId;
	};
	const read = async (runId: string) => {
		const row = await db.query.testRuns.findFirst({
			where: eq(testRuns.id, runId),
		});
		if (!row) throw new Error("Expected run row");
		return row;
	};
	// A finished run that cost `costUsd`, finished at `finishedAt`.
	const spend = async (costUsd: number, finishedAt: number) => {
		const runId = await request(finishedAt - 60_000);
		await db
			.update(testRuns)
			.set({
				status: "completed",
				outcome: "passed",
				costUsd,
				finishedAt,
				blockedReason: null,
			})
			.where(eq(testRuns.id, runId));
		return runId;
	};
	const claim = (now: number) =>
		claimNextRun(db, { pool, workerId: worker.workerId, now });
	return { ...fixture, pool, worker, request, read, spend, claim };
};

describe("daily model budget", () => {
	it("counts only runs that finished on the current UTC day", async () => {
		const env = await setup(10);
		await env.spend(4, NOON - DAY_MS);
		await env.spend(1.25, budgetDayStart(NOON));
		await env.spend(0.5, NOON - 1);
		expect(budgetDayStart(NOON)).toBe(Date.UTC(2026, 9, 3));
		expect(await modelSpendToday(env.db, env.orgId, NOON)).toBeCloseTo(1.75);
		expect(await modelSpendToday(env.db, env.orgId, NOON + DAY_MS)).toBeCloseTo(
			0,
		);
	});

	it("queues new runs as BUDGET_EXCEEDED once spend reaches the budget and releases them the next day", async () => {
		const env = await setup(1);
		const under = await env.request(NOON - 3 * 60_000);
		expect((await env.read(under)).blockedReason).not.toBe("BUDGET_EXCEEDED");
		await env.spend(1, NOON - 60_000);

		const over = await env.request(NOON);
		expect(await env.read(over)).toMatchObject({
			status: "queued",
			blockedReason: "BUDGET_EXCEEDED",
		});
		// The run requested before the budget ran out is still claimable; the blocked one is not.
		expect((await env.claim(NOON))?.run.id).toBe(under);
		expect(await env.claim(NOON)).toBeNull();
		await env.db
			.update(testRuns)
			.set({ status: "completed", outcome: "passed", finishedAt: NOON })
			.where(eq(testRuns.id, under));

		// Later the same day the sweep keeps it blocked.
		const sameDay = await sweepRunQueue(env.db, NOON + 60 * 60_000);
		expect(sameDay.budgetReleased).toEqual([]);
		expect((await env.read(over)).blockedReason).toBe("BUDGET_EXCEEDED");
		expect(await env.claim(NOON + 60 * 60_000)).toBeNull();

		// The next UTC day starts with no spend: the run becomes claimable.
		const nextDay = budgetDayStart(NOON) + DAY_MS + 1_000;
		const sweep = await sweepRunQueue(env.db, nextDay);
		expect(sweep.budgetReleased).toEqual([over]);
		expect((await env.read(over)).blockedReason).not.toBe("BUDGET_EXCEEDED");
		expect((await env.claim(nextDay))?.run.id).toBe(over);
	});

	it("never blocks runs without a budget", async () => {
		const env = await setup(null);
		await env.spend(500, NOON - 60_000);
		const runId = await env.request(NOON);
		expect((await env.read(runId)).blockedReason).not.toBe("BUDGET_EXCEEDED");
		expect((await env.claim(NOON))?.run.id).toBe(runId);
	});
});

describe("daily model budget routes", () => {
	it("shows BUDGET_EXCEEDED on the run and frees it when an admin raises the budget", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});
		const runner = await registerRunner(fixture, "devbox", 5);
		const putSettings = (dailyBudgetUsd: number | null) =>
			fixture.call("/test-run-settings", {
				method: "PUT",
				token: fixture.admin.token,
				body: roomySettings(dailyBudgetUsd),
			});
		expect((await putSettings(2)).status).toBe(200);
		const requestRun = async (role: string) => {
			const response = await fixture.call<CreateTestRunResponse>(
				`/test-cases/${testCase.id}/runs`,
				{ token: fixture.qa.token, body: { params: { role } } },
			);
			expect(response.status).toBe(201);
			return response.body.runId;
		};
		const getRun = async (runId: string) =>
			(
				await fixture.call<TestRunDetail>(`/test-runs/${runId}`, {
					token: fixture.qa.token,
				})
			).body;
		const claim = () =>
			fixture.call<{ run: ClaimedRun | null }>("/runner-pools/claim", {
				method: "POST",
				token: runner.workerToken,
			});

		const spent = await requestRun("spent");
		await fixture.db
			.update(testRuns)
			.set({
				status: "completed",
				outcome: "passed",
				costUsd: 2.5,
				finishedAt: Date.now(),
			})
			.where(eq(testRuns.id, spent));

		const waiting = await requestRun("waiting");
		const blocked = await getRun(waiting);
		expect(blocked).toMatchObject({
			status: "queued",
			blockedReason: "BUDGET_EXCEEDED",
			estimatedStartAt: null,
		});
		expect((await claim()).body.run).toBeNull();

		// Raising the budget above today's spend releases the run without waiting for a sweep.
		expect((await putSettings(5)).status).toBe(200);
		const released = await getRun(waiting);
		expect(released.blockedReason).toBeNull();
		expect(released.estimatedStartAt).toBeNumber();
		expect((await claim()).body.run?.runId).toBe(waiting);

		// Lowering it again blocks the next request; removing it releases.
		expect((await putSettings(1)).status).toBe(200);
		const next = await requestRun("next");
		expect((await getRun(next)).blockedReason).toBe("BUDGET_EXCEEDED");
		expect((await putSettings(null)).status).toBe(200);
		expect((await getRun(next)).blockedReason).toBeNull();
	});
});
