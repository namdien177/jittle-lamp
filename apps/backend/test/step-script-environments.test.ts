import { describe, expect, it } from "bun:test";
import type { ClaimedRun, CreateTestRunResponse } from "@jittle-lamp/shared";
import { and, eq } from "drizzle-orm";

import { testStepScripts } from "../src/db/schema";
import {
	createTestCaseFixture,
	FAKE_MODEL_KEY,
	FAKE_PASSWORD,
} from "./test-case-fixtures";
import { registerRunner, seedRunnableCase } from "./test-run-fixtures";

// Review finding: the runner cache read fell back to a script recorded in another environment,
// and a re-recording staled every environment's script for the key (design.md §9.5).

const setup = async () => {
	const fixture = await createTestCaseFixture();
	const { testCase, environmentId } = await seedRunnableCase(fixture, {
		password: FAKE_PASSWORD,
		modelKey: FAKE_MODEL_KEY,
	});
	const other = await fixture.call<{ id: string }>("/test-environments", {
		token: fixture.admin.token,
		body: { name: "staging", baseUrl: "https://staging.example.test" },
	});
	if (other.status !== 201) throw new Error(JSON.stringify(other.body));
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
	const insertScript = async (keyHash: string, envId: string | null) => {
		const [row] = await fixture.db
			.insert(testStepScripts)
			.values({
				orgId: fixture.orgId,
				testCaseId: testCase.id,
				stepId: "s1",
				environmentId: envId,
				keyHash,
				entryJson: JSON.stringify({ env: envId }),
				status: "active",
			})
			.returning();
		if (!row) throw new Error("Expected script");
		return row;
	};
	return {
		fixture,
		claimed,
		runEnvironmentId: environmentId,
		otherEnvironmentId: other.body.id,
		insertScript,
	};
};

describe("step scripts per environment", () => {
	it("never replays a script recorded in another environment", async () => {
		const { fixture, claimed, otherEnvironmentId, insertScript } =
			await setup();
		await insertScript("key-other", otherEnvironmentId);
		const miss = await fixture.call<{ status: string }>(
			`/test-runs/${claimed.runId}/cache/key-other`,
			{ token: claimed.runToken },
		);
		expect(miss.body).toEqual({ status: "miss" });

		await insertScript("key-shared", null);
		const shared = await fixture.call<{ status: string; entry: unknown }>(
			`/test-runs/${claimed.runId}/cache/key-shared`,
			{ token: claimed.runToken },
		);
		expect(shared.body).toEqual({ status: "hit", entry: { env: null } });
	});

	it("prefers the run's environment over an environment-agnostic script", async () => {
		const { fixture, claimed, runEnvironmentId, insertScript } = await setup();
		await insertScript("key-1", runEnvironmentId);
		await insertScript("key-1", null);
		const hit = await fixture.call<{ status: string; entry: unknown }>(
			`/test-runs/${claimed.runId}/cache/key-1`,
			{ token: claimed.runToken },
		);
		expect(hit.body).toEqual({
			status: "hit",
			entry: { env: runEnvironmentId },
		});
	});

	it("re-recording stales only the run's environment and shared scripts", async () => {
		const {
			fixture,
			claimed,
			runEnvironmentId,
			otherEnvironmentId,
			insertScript,
		} = await setup();
		const other = await insertScript("key-1", otherEnvironmentId);
		const own = await insertScript("key-1", runEnvironmentId);
		const shared = await insertScript("key-1", null);
		const write = await fixture.call(
			`/test-runs/${claimed.runId}/cache/key-1`,
			{
				method: "PUT",
				token: claimed.runToken,
				body: {
					entry: { schemaVersion: "trace-1", createdAt: "now", payload: {} },
					stepIds: ["s1"],
					instructionKey: "act:s1",
					renderedCode: "",
				},
			},
		);
		expect(write.body).toEqual({ ok: true });
		const status = async (id: string) =>
			(
				await fixture.db.query.testStepScripts.findFirst({
					where: eq(testStepScripts.id, id),
				})
			)?.status;
		expect(await status(other.id)).toBe("active");
		expect(await status(own.id)).toBe("stale");
		expect(await status(shared.id)).toBe("stale");
		const active = await fixture.db.query.testStepScripts.findMany({
			where: and(
				eq(testStepScripts.keyHash, "key-1"),
				eq(testStepScripts.status, "active"),
			),
		});
		expect(active.map((row) => row.environmentId).sort()).toEqual(
			[otherEnvironmentId, runEnvironmentId].sort(),
		);
	});
});
