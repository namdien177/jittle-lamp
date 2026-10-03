import { describe, expect, it } from "bun:test";
import type {
	ClaimedRun,
	CreateTestRunResponse,
	TestRunDetail,
} from "@jittle-lamp/shared";
import { eq } from "drizzle-orm";

import { evidences, testCaseEvidences } from "../src/db/schema";
import {
	createTestCaseFixture,
	FAKE_MODEL_KEY,
	FAKE_PASSWORD,
} from "./test-case-fixtures";
import {
	buildEvidenceZip,
	buildRunReport,
	registerRunner,
	seedRunnableCase,
} from "./test-run-fixtures";

// Review finding: finalize accepted any evidence id of the organisation and linked it to the
// run and case, so a runner could relabel someone else's recording as its run evidence.

describe("run evidence link", () => {
	it("links only the evidence uploaded for this run", async () => {
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

		const foreign = async (sourceType: string, sourceExternalId: string) => {
			const [row] = await fixture.db
				.insert(evidences)
				.values({
					orgId: fixture.orgId,
					createdBy: fixture.admin.userId,
					title: "Someone else's recording",
					sourceType,
					sourceExternalId,
				})
				.returning({ id: evidences.id });
			if (!row) throw new Error("Expected evidence");
			return row.id;
		};
		const report = buildRunReport(claimed);
		for (const evidenceId of [
			await foreign("automation-test", runId),
			await foreign("test-run", crypto.randomUUID()),
			await foreign("extension", "jl_session_1"),
		]) {
			const finalize = await fixture.call<{ error: { code: string } }>(
				`/test-runs/${runId}/finalize`,
				{ token: claimed.runToken, body: { report, evidenceId } },
			);
			expect(finalize.status).toBe(422);
			expect(finalize.body.error.code).toBe("TEST_RUN_EVIDENCE_INVALID");
			const links = await fixture.db.query.testCaseEvidences.findMany({
				where: eq(testCaseEvidences.evidenceId, evidenceId),
			});
			expect(links).toHaveLength(0);
		}

		const upload = await fixture.call<{ evidenceId: string }>(
			`/test-runs/${runId}/evidence`,
			{
				method: "POST",
				token: claimed.runToken,
				raw: Uint8Array.from(buildEvidenceZip(report)).buffer,
				headers: { "content-type": "application/zip" },
			},
		);
		expect(upload.status).toBe(201);
		const finalized = await fixture.call<TestRunDetail>(
			`/test-runs/${runId}/finalize`,
			{
				token: claimed.runToken,
				body: { report, evidenceId: upload.body.evidenceId },
			},
		);
		expect(finalized.status).toBe(200);
		expect(finalized.body.evidenceId).toBe(upload.body.evidenceId);
	});
});
