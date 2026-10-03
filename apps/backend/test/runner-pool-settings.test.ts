import { describe, expect, it } from "bun:test";
import type { CreateTestRunResponse } from "@jittle-lamp/shared";
import { and, eq } from "drizzle-orm";

import { runnerPools, testRateBuckets, testRuns } from "../src/db/schema";
import {
	AI_ACCESS_TOKEN_SCOPE,
	AI_MCP_TOKEN_SCOPE,
	createAiAccessToken,
} from "../src/services/ai-access-tokens";
import { defaultRunSettings, ensureCloudPool } from "../src/services/test-runs";
import { saveRunSettings } from "../src/services/test-settings";
import { createTestCaseFixture, loginTranscript } from "./test-case-fixtures";
import { registerRunner } from "./test-run-fixtures";

// Review findings: PATCH /runner-pools/:id stored maxConcurrentRuns on the cloud pool, which
// runs at the organisation setting and ignored it; and jl_ai_ tokens shared their owner's
// run-request bucket instead of getting their own (design.md §10.3).

describe("runner pool settings and per-token throttle", () => {
	it("rejects maxConcurrentRuns on the cloud pool and accepts it on self-hosted pools", async () => {
		const fixture = await createTestCaseFixture();
		const cloud = await ensureCloudPool(fixture.db, fixture.orgId);
		const rejected = await fixture.call<{ error: { code: string } }>(
			`/runner-pools/${cloud.id}`,
			{
				method: "PATCH",
				token: fixture.admin.token,
				body: { maxConcurrentRuns: 5 },
			},
		);
		expect(rejected.status).toBe(422);
		expect(rejected.body.error.code).toBe("RUNNER_POOL_CLOUD_CONCURRENCY");
		const stored = await fixture.db.query.runnerPools.findFirst({
			where: eq(runnerPools.id, cloud.id),
		});
		expect(stored?.maxConcurrentRuns).toBe(cloud.maxConcurrentRuns);

		const runner = await registerRunner(fixture);
		const accepted = await fixture.call<{ maxConcurrentRuns: number }>(
			`/runner-pools/${runner.poolId}`,
			{
				method: "PATCH",
				token: fixture.admin.token,
				body: { maxConcurrentRuns: 4 },
			},
		);
		expect(accepted.status).toBe(200);
		expect(accepted.body.maxConcurrentRuns).toBe(4);
	});

	it("gives an AI access token its own run-request bucket", async () => {
		const fixture = await createTestCaseFixture();
		await saveRunSettings(fixture.db, fixture.orgId, fixture.admin.userId, {
			...defaultRunSettings,
			tokenBucketSize: 1,
			maxQueuedRuns: 100,
			maxQueuedPerCase: 100,
		});
		const created = await fixture.call<{ id: string }>("/test-cases", {
			token: fixture.qa.token,
			body: { transcript: loginTranscript() },
		});
		const { token: aiToken, accessToken } = await createAiAccessToken(
			fixture.db,
			{
				userId: fixture.qa.userId,
				label: "MCP",
				expiresAt: null,
				scopes: [AI_ACCESS_TOKEN_SCOPE, AI_MCP_TOKEN_SCOPE],
			},
		);
		const run = (token: string, n: number) =>
			fixture.call<CreateTestRunResponse>(
				`/test-cases/${created.body.id}/runs`,
				{ token, body: { params: { n: String(n) }, force: true } },
			);
		expect((await run(fixture.qa.token, 1)).status).toBe(201);
		expect((await run(fixture.qa.token, 2)).status).toBe(429);
		// The owner's bucket is empty; the AI token has its own.
		const viaAi = await run(aiToken, 3);
		expect(viaAi.status).toBe(201);
		expect((await run(aiToken, 4)).status).toBe(429);

		const buckets = await fixture.db.query.testRateBuckets.findMany({
			where: eq(testRateBuckets.orgId, fixture.orgId),
		});
		expect(buckets.map((bucket) => bucket.bucketKey).sort()).toEqual(
			[`ai-token:${accessToken.id}`, `user:${fixture.qa.userId}`].sort(),
		);
		const aiRun = await fixture.db.query.testRuns.findFirst({
			where: and(eq(testRuns.id, viaAi.body.runId)),
		});
		expect(aiRun?.requestedByTokenId).toBe(accessToken.id);
	});
});
