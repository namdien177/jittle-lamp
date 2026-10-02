import { describe, expect, it } from "bun:test";
import { createTestRunRequestSchema } from "@jittle-lamp/shared";
import { eq, inArray } from "drizzle-orm";

import { createDb } from "../src/db";
import { runnerWorkers, testRuns } from "../src/db/schema";
import {
	createRunnerPool,
	recordHeartbeat,
	registerWorker,
} from "../src/services/runner-pools";
import { createTestCase } from "../src/services/test-cases";
import {
	claimNextRun,
	RUNNER_OFFLINE_MS,
	sweepRunQueue,
} from "../src/services/test-run-queue";
import {
	consumeRunRequestToken,
	defaultRunSettings,
	RUN_LEASE_MS,
	requestRuns,
} from "../src/services/test-runs";
import { saveRunSettings } from "../src/services/test-settings";
import { createTestCaseFixture } from "./test-case-fixtures";

const setupQueue = async (options: { maxConcurrentRuns: number }) => {
	const fixture = await createTestCaseFixture();
	const { db, orgId, qa } = fixture;
	await saveRunSettings(db, orgId, fixture.admin.userId, {
		...defaultRunSettings,
		maxQueuedRuns: 1000,
		maxQueuedPerCase: 1000,
		tokenBucketSize: 1000,
	});
	const environmentId = (
		await fixture.call<{ id: string }>("/test-environments", {
			token: fixture.admin.token,
			body: {
				name: "devbox-env",
				baseUrl: "https://uat.example.test",
				runnerPool: "self-hosted:devbox",
			},
		})
	).body.id;
	const { pool, registrationToken } = await createRunnerPool(db, {
		orgId,
		userId: fixture.admin.userId,
		name: "devbox",
		maxConcurrentRuns: options.maxConcurrentRuns,
	});
	const workers = [];
	for (let index = 0; index < 4; index += 1) {
		workers.push(
			await registerWorker(db, {
				registrationToken,
				request: {
					hostname: `devbox-${index}`,
					version: "1.8.2",
					capabilities: {
						browsers: ["chromium"],
						headed: false,
						liveView: false,
					},
				},
			}),
		);
	}
	const testCase = await createTestCase(db, {
		orgId,
		userId: qa.userId,
		transcript: "# Queue case\n\n[Act] do something",
		status: "active",
		environmentId,
		source: "manual",
	});
	const queueRuns = async (
		count: number,
		overrides: Partial<{ priority: number; trigger: "manual" | "ci" }> = {},
	) => {
		const ids: string[] = [];
		for (let index = 0; index < count; index += 1) {
			const { results } = await requestRuns(db, {
				orgId,
				requester: { userId: qa.userId, tokenId: null, kind: "session" },
				cases: [
					{
						row: testCase,
						request: createTestRunRequestSchema.parse({
							params: { n: crypto.randomUUID() },
							...overrides,
						}),
					},
				],
			});
			ids.push(results[0]?.runId ?? "");
		}
		return ids;
	};
	return { ...fixture, pool, workers, testCase, queueRuns };
};

describe("test run queue", () => {
	it("never hands one run to two workers under concurrent claims", async () => {
		const setup = await setupQueue({ maxConcurrentRuns: 50 });
		const runIds = await setup.queueRuns(12);
		// Separate connections to the same database, as separate backend instances would use.
		const connections = Array.from({ length: 6 }, () => {
			const db = createDb(setup.databaseUrl);
			if (!db) throw new Error("Expected database");
			return db;
		});
		const attempts = Array.from({ length: 30 }, (_, index) => {
			const db = connections[index % connections.length];
			const worker = setup.workers[index % setup.workers.length];
			if (!db || !worker) throw new Error("Expected connection and worker");
			return claimNextRun(db, { pool: setup.pool, workerId: worker.workerId });
		});
		const claims = (await Promise.all(attempts)).flatMap((claim) =>
			claim ? [claim] : [],
		);
		const claimedIds = claims.map((claim) => claim.run.id);
		expect(claimedIds).toHaveLength(12);
		expect(new Set(claimedIds).size).toBe(12);
		expect([...claimedIds].sort()).toEqual([...runIds].sort());
		expect(new Set(claims.map((claim) => claim.runToken)).size).toBe(12);
		const rows = await setup.db.query.testRuns.findMany({
			where: inArray(testRuns.id, runIds),
		});
		expect(rows.every((row) => row.status === "claimed")).toBe(true);
		for (const claim of claims) {
			const row = rows.find((entry) => entry.id === claim.run.id);
			expect(row?.workerLeaseOwner).toBe(claim.run.workerLeaseOwner ?? "");
		}
	});

	it("honours the pool's max_concurrent_runs and priority then queued_at", async () => {
		const setup = await setupQueue({ maxConcurrentRuns: 2 });
		const [ciRun] = await setup.queueRuns(1, { trigger: "ci" });
		const [manualA, manualB] = await setup.queueRuns(2);
		const [urgent] = await setup.queueRuns(1, { priority: 90 });
		const connections = Array.from({ length: 4 }, () =>
			createDb(setup.databaseUrl),
		);
		const claims = await Promise.all(
			connections.map((db, index) => {
				const worker = setup.workers[index];
				if (!db || !worker) throw new Error("Expected connection and worker");
				return claimNextRun(db, {
					pool: setup.pool,
					workerId: worker.workerId,
				});
			}),
		);
		const claimed = claims.flatMap((claim) => (claim ? [claim.run.id] : []));
		expect(claimed.sort()).toEqual([urgent ?? "", manualA ?? ""].sort());
		expect(claims.filter((claim) => claim === null)).toHaveLength(2);
		// Finishing one frees a slot; manual (30) beats CI (10).
		await setup.db
			.update(testRuns)
			.set({ status: "completed", outcome: "passed", finishedAt: Date.now() })
			.where(eq(testRuns.id, urgent ?? ""));
		const worker = setup.workers[0];
		if (!worker) throw new Error("Expected worker");
		const next = await claimNextRun(setup.db, {
			pool: setup.pool,
			workerId: worker.workerId,
		});
		expect(next?.run.id).toBe(manualB ?? "");
		expect(ciRun).toBeString();
	});

	it("requeues expired leases and fails the run as RUNNER_LOST after three attempts", async () => {
		const setup = await setupQueue({ maxConcurrentRuns: 1 });
		const [runId] = await setup.queueRuns(1);
		const worker = setup.workers[0];
		if (!worker || !runId) throw new Error("Expected worker and run");
		let now = Date.now();
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const claim = await claimNextRun(setup.db, {
				pool: setup.pool,
				workerId: worker.workerId,
				now,
			});
			expect(claim?.run.id).toBe(runId);
			expect(claim?.run.attempts).toBe(attempt - 1);
			now += RUN_LEASE_MS + 1;
			const sweep = await sweepRunQueue(setup.db, now);
			if (attempt < 3) {
				expect(sweep.requeued).toEqual([runId]);
				const row = await setup.db.query.testRuns.findFirst({
					where: eq(testRuns.id, runId),
				});
				expect(row).toMatchObject({
					status: "queued",
					attempts: attempt,
					runTokenHash: null,
					workerLeaseOwner: null,
				});
			} else {
				expect(sweep.lost.map((run) => run.id)).toEqual([runId]);
			}
		}
		const lost = await setup.db.query.testRuns.findFirst({
			where: eq(testRuns.id, runId),
		});
		expect(lost).toMatchObject({
			status: "failed",
			outcome: "blocked",
			blockedReason: "RUNNER_LOST",
			attempts: 3,
		});

		// A run whose cancel was requested is cancelled when its lease expires.
		const [second] = await setup.queueRuns(1);
		await claimNextRun(setup.db, {
			pool: setup.pool,
			workerId: worker.workerId,
			now,
		});
		await setup.db
			.update(testRuns)
			.set({ cancelRequestedAt: now })
			.where(eq(testRuns.id, second ?? ""));
		const sweep = await sweepRunQueue(setup.db, now + RUN_LEASE_MS + 1);
		expect(sweep.cancelled).toEqual([second ?? ""]);
	});

	it("keeps NO_RUNNER while no worker of the pool is live and reports offline runners once", async () => {
		const setup = await setupQueue({ maxConcurrentRuns: 1 });
		const [runId] = await setup.queueRuns(1);
		const read = async () =>
			(
				await setup.db.query.testRuns.findFirst({
					where: eq(testRuns.id, runId ?? ""),
				})
			)?.blockedReason;
		expect(await read()).toBeNull();
		const later = Date.now() + RUNNER_OFFLINE_MS + 1;
		const sweep = await sweepRunQueue(setup.db, later);
		expect(await read()).toBe("NO_RUNNER");
		expect(sweep.offlineWorkers).toHaveLength(setup.workers.length);
		expect(
			(await sweepRunQueue(setup.db, later + 1)).offlineWorkers,
		).toHaveLength(0);
		const worker = await setup.db.query.runnerWorkers.findFirst({
			where: eq(runnerWorkers.id, setup.workers[0]?.workerId ?? ""),
		});
		if (!worker) throw new Error("Expected worker");
		await recordHeartbeat(setup.db, {
			worker,
			request: { runId: null, load: 0 },
			now: later,
		});
		expect(await read()).toBeNull();
		await sweepRunQueue(setup.db, later + 1);
		expect(await read()).toBeNull();
	});

	it("refills the token bucket over its window", async () => {
		const setup = await setupQueue({ maxConcurrentRuns: 1 });
		const settings = {
			...defaultRunSettings,
			tokenBucketSize: 2,
			tokenBucketWindowSeconds: 10,
		};
		const now = 1_000_000;
		const take = (at: number, bucketKey = "user:a") =>
			consumeRunRequestToken(setup.db, {
				orgId: setup.orgId,
				bucketKey,
				settings,
				now: at,
			});
		expect(await take(now)).toEqual({ ok: true });
		expect(await take(now)).toEqual({ ok: true });
		expect(await take(now)).toEqual({ ok: false, retryAfter: 5 });
		expect(await take(now, "token:ci")).toEqual({ ok: true });
		expect(await take(now + 5_000)).toEqual({ ok: true });
		expect(await take(now + 5_000)).toMatchObject({ ok: false });
	});
});
