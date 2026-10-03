import { describe, expect, it } from "bun:test";
import {
	type ClaimedRun,
	type CreateTestRunResponse,
	createTestRunRequestSchema,
} from "@jittle-lamp/shared";
import { and, eq } from "drizzle-orm";

import { createDb } from "../src/db";
import { testRuns } from "../src/db/schema";
import { createTestCase } from "../src/services/test-cases";
import {
	consumeRunRequestToken,
	defaultRunSettings,
	recordProgress,
	requestRuns,
	verifyRunToken,
} from "../src/services/test-runs";
import { saveRunSettings } from "../src/services/test-settings";
import {
	createTestCaseFixture,
	FAKE_MODEL_KEY,
	FAKE_PASSWORD,
	type TestCaseFixture,
} from "./test-case-fixtures";
import { registerRunner, seedRunnableCase } from "./test-run-fixtures";

// Review findings on concurrent writers: dedupe was check-then-insert, the token bucket was
// read-then-write, and progress could overwrite a run another request had already moved on.

const connections = (fixture: TestCaseFixture, count: number) =>
	Array.from({ length: count }, () => {
		const db = createDb(fixture.databaseUrl);
		if (!db) throw new Error("Expected database");
		return db;
	});

describe("run request concurrency", () => {
	it("opens one run for concurrent identical requests and attaches the rest", async () => {
		const fixture = await createTestCaseFixture();
		await saveRunSettings(fixture.db, fixture.orgId, fixture.admin.userId, {
			...defaultRunSettings,
			tokenBucketSize: 1000,
			dedupeWindowSeconds: 0,
		});
		const testCase = await createTestCase(fixture.db, {
			orgId: fixture.orgId,
			userId: fixture.qa.userId,
			transcript: "# Dedupe case\n\n[Act] do something",
			status: "active",
			source: "manual",
		});
		const request = createTestRunRequestSchema.parse({});
		const results = await Promise.all(
			connections(fixture, 8).map((db) =>
				requestRuns(db, {
					orgId: fixture.orgId,
					requester: {
						userId: fixture.qa.userId,
						tokenId: null,
						kind: "session",
					},
					cases: [{ row: testCase, request }],
				}),
			),
		);
		const runIds = results.map((result) => result.results[0]?.runId);
		expect(new Set(runIds).size).toBe(1);
		expect(
			results.filter((result) => result.results[0]?.attached === false),
		).toHaveLength(1);
		const rows = await fixture.db.query.testRuns.findMany({
			where: eq(testRuns.testCaseId, testCase.id),
		});
		expect(rows).toHaveLength(1);
	});

	it("enforces one open non-forced run per dedupe key in the database", async () => {
		const fixture = await createTestCaseFixture();
		const testCase = await createTestCase(fixture.db, {
			orgId: fixture.orgId,
			userId: fixture.qa.userId,
			transcript: "# Index case\n\n[Act] do something",
			status: "active",
			source: "manual",
		});
		const row = (dedupeExclusive: boolean, status: "queued" | "completed") => ({
			orgId: fixture.orgId,
			testCaseId: testCase.id,
			transcriptVersion: 1,
			paramsHash: "sha256:x",
			dedupeKey: "sha256:same",
			dedupeExclusive,
			status,
			queuedAt: Date.now(),
		});
		await fixture.db.insert(testRuns).values(row(true, "queued"));
		let duplicateError: unknown = null;
		try {
			await fixture.db.insert(testRuns).values(row(true, "queued"));
		} catch (error) {
			duplicateError = error;
		}
		expect(duplicateError).not.toBeNull();
		// Forced runs and finished runs do not take the slot.
		await fixture.db.insert(testRuns).values(row(false, "queued"));
		await fixture.db.insert(testRuns).values(row(true, "completed"));
		const forced = await requestRuns(fixture.db, {
			orgId: fixture.orgId,
			requester: { userId: fixture.qa.userId, tokenId: null, kind: "session" },
			cases: [
				{
					row: testCase,
					request: createTestRunRequestSchema.parse({ force: true }),
				},
			],
		});
		expect(forced.results[0]?.attached).toBe(false);
	});

	it("never spends one rate-limit token twice under concurrent requests", async () => {
		const fixture = await createTestCaseFixture();
		const settings = { ...defaultRunSettings, tokenBucketSize: 5 };
		const now = Date.now();
		const outcomes = await Promise.all(
			connections(fixture, 6).flatMap((db) =>
				Array.from({ length: 4 }, () =>
					consumeRunRequestToken(db, {
						orgId: fixture.orgId,
						bucketKey: "user:burst",
						settings,
						now,
					}),
				),
			),
		);
		expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(5);
		const rejected = outcomes.find((outcome) => !outcome.ok);
		expect(rejected).toMatchObject({ ok: false });
		expect(
			(rejected as { retryAfter: number } | undefined)?.retryAfter,
		).toBeGreaterThan(0);
	});

	it("progress does not revive a run that moved on after the token was checked", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
			modelKey: FAKE_MODEL_KEY,
		});
		const requested = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{ token: fixture.qa.token, body: {} },
		);
		const runner = await registerRunner(fixture);
		const claim = await fixture.call<{ run: ClaimedRun | null }>(
			"/runner-pools/claim",
			{ token: runner.workerToken, body: {} },
		);
		const claimed = claim.body.run;
		if (!claimed) throw new Error("Expected a claimed run");
		const runId = requested.body.runId;
		const snapshot = await verifyRunToken(fixture.db, {
			runId,
			token: claimed.runToken,
		});
		// Finalised by a concurrent request after this one passed the token check.
		await fixture.db
			.update(testRuns)
			.set({ status: "completed", outcome: "passed", runTokenHash: null })
			.where(eq(testRuns.id, runId));
		await expect(
			recordProgress(fixture.db, fixture.artifactStorage, snapshot, {
				status: "running",
				steps: [],
			}),
		).rejects.toMatchObject({ status: 409, code: "TEST_RUN_LEASE_LOST" });
		const row = await fixture.db.query.testRuns.findFirst({
			where: and(eq(testRuns.id, runId)),
		});
		expect(row?.status).toBe("completed");

		// Cancelled underneath: the runner is told to stop instead.
		await fixture.db
			.update(testRuns)
			.set({ status: "cancelled", outcome: null })
			.where(eq(testRuns.id, runId));
		expect(
			await recordProgress(fixture.db, fixture.artifactStorage, snapshot, {
				steps: [],
			}),
		).toMatchObject({ cancelRequested: true, leaseExpiresAt: null });
	});
});
