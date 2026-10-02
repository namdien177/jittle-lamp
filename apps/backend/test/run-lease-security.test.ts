import { describe, expect, it } from "bun:test";
import type { ClaimedRun, CreateTestRunResponse } from "@jittle-lamp/shared";
import { eq } from "drizzle-orm";

import { runnerWorkers, testRuns } from "../src/db/schema";
import { RUN_MAX_ATTEMPTS } from "../src/services/test-runs";
import {
	createTestCaseFixture,
	FAKE_MODEL_KEY,
	FAKE_PASSWORD,
	type TestCaseFixture,
} from "./test-case-fixtures";
import { registerRunner, seedRunnableCase } from "./test-run-fixtures";

// Review findings on run leases: a revoked worker kept its run token, and a claim extended
// the lease of whatever run the worker last reported.

const claimOne = async (fixture: TestCaseFixture) => {
	const { testCase } = await seedRunnableCase(fixture, {
		password: FAKE_PASSWORD,
		modelKey: FAKE_MODEL_KEY,
	});
	const requested = await fixture.call<CreateTestRunResponse>(
		`/test-cases/${testCase.id}/runs`,
		{ token: fixture.qa.token, body: {} },
	);
	if (requested.status !== 201) throw new Error(JSON.stringify(requested.body));
	const runner = await registerRunner(fixture);
	const claim = await fixture.call<{ run: ClaimedRun | null }>(
		"/runner-pools/claim",
		{ token: runner.workerToken, body: {} },
	);
	const claimed = claim.body.run;
	if (!claimed) throw new Error("Expected a claimed run");
	return { runner, claimed, runId: requested.body.runId };
};

describe("run lease security", () => {
	it("revoking a worker invalidates its run tokens and requeues its runs", async () => {
		const fixture = await createTestCaseFixture();
		const { runner, claimed, runId } = await claimOne(fixture);
		const before = await fixture.call(`/test-runs/${runId}/config`, {
			token: claimed.runToken,
		});
		expect(before.status).toBe(200);

		const revoke = await fixture.call<{ revoked: boolean }>(
			`/runner-pools/${runner.poolId}/workers/${runner.workerId}`,
			{ method: "DELETE", token: fixture.admin.token },
		);
		expect(revoke.body).toEqual({ revoked: true });

		for (const request of [
			fixture.call(`/test-runs/${runId}/config`, { token: claimed.runToken }),
			fixture.call(`/test-runs/${runId}/progress`, {
				method: "PATCH",
				token: claimed.runToken,
				body: { status: "running", steps: [] },
			}),
			fixture.call(`/test-runs/${runId}/cache/key-1`, {
				token: claimed.runToken,
			}),
		]) {
			expect((await request).status).toBe(401);
		}
		const row = await fixture.db.query.testRuns.findFirst({
			where: eq(testRuns.id, runId),
		});
		expect(row).toMatchObject({
			status: "queued",
			attempts: 1,
			runTokenHash: null,
			workerLeaseOwner: null,
		});
	});

	it("rejects a still-valid run token once its lease owner is revoked", async () => {
		const fixture = await createTestCaseFixture();
		const { runner, claimed, runId } = await claimOne(fixture);
		// Revocation written directly, without the route's lease cleanup.
		await fixture.db
			.update(runnerWorkers)
			.set({ revokedAt: Date.now() })
			.where(eq(runnerWorkers.id, runner.workerId));
		const config = await fixture.call(`/test-runs/${runId}/config`, {
			token: claimed.runToken,
		});
		expect(config.status).toBe(401);
	});

	it("fails a revoked worker's run as RUNNER_LOST on its last attempt", async () => {
		const fixture = await createTestCaseFixture();
		const { runner, runId } = await claimOne(fixture);
		await fixture.db
			.update(testRuns)
			.set({ attempts: RUN_MAX_ATTEMPTS - 1 })
			.where(eq(testRuns.id, runId));
		await fixture.call(
			`/runner-pools/${runner.poolId}/workers/${runner.workerId}`,
			{ method: "DELETE", token: fixture.admin.token },
		);
		const row = await fixture.db.query.testRuns.findFirst({
			where: eq(testRuns.id, runId),
		});
		expect(row).toMatchObject({
			status: "failed",
			blockedReason: "RUNNER_LOST",
			runTokenHash: null,
		});
	});
});
