import { describe, expect, it } from "bun:test";
import type { TestCaseDetail } from "@jittle-lamp/shared";
import { and, eq } from "drizzle-orm";

import { organizationRoles, testCases } from "../src/db/schema";
import {
	createTestCaseFixture,
	loginTranscript,
	type TestCaseFixture,
} from "./test-case-fixtures";

// Review finding: only review -> active needed test_case.approve, so an author without it could
// move a case from review to draft (runnable) or archive it, and a duplicate of a review case
// came out as a runnable draft.

// The developer role becomes an author without the approve permission.
const authorWithoutApprove = async (fixture: TestCaseFixture) => {
	await fixture.db
		.update(organizationRoles)
		.set({
			permissionsJson: JSON.stringify([
				"test_case.view",
				"test_case.create",
				"test_case.update",
				"test_run.create",
				"test_run.view",
				"test_config.use",
			]),
		})
		.where(
			and(
				eq(organizationRoles.organizationId, fixture.orgId),
				eq(organizationRoles.key, "developer"),
			),
		);
	return fixture.developer;
};

const reviewCase = async (fixture: TestCaseFixture) => {
	const created = await fixture.call<TestCaseDetail>("/test-cases", {
		token: fixture.qa.token,
		body: { transcript: loginTranscript(), status: "review", source: "ai" },
	});
	if (created.status !== 201) throw new Error(JSON.stringify(created.body));
	expect(created.body.status).toBe("review");
	return created.body;
};

describe("review approval gate", () => {
	it("needs test_case.approve for every transition out of review", async () => {
		const fixture = await createTestCaseFixture();
		const author = await authorWithoutApprove(fixture);
		const testCase = await reviewCase(fixture);
		for (const status of ["active", "draft", "archived"] as const) {
			const response = await fixture.call<{ error: { code: string } }>(
				`/test-cases/${testCase.id}`,
				{ method: "PATCH", token: author.token, body: { status } },
			);
			expect(response.status).toBe(403);
			expect(response.body.error.code).toBe("TEST_PERMISSION_DENIED");
		}
		// Editing the transcript without leaving review is still allowed.
		const edit = await fixture.call<TestCaseDetail>(
			`/test-cases/${testCase.id}`,
			{
				method: "PATCH",
				token: author.token,
				body: { transcript: loginTranscript("Edited in review") },
			},
		);
		expect(edit.status).toBe(200);
		expect(edit.body.status).toBe("review");

		const bulk = await fixture.call<{
			updated: number;
			errors: Array<{ id: string }>;
		}>("/test-cases/bulk", {
			token: author.token,
			body: { action: "archive", ids: [testCase.id] },
		});
		expect(bulk.body.updated).toBe(0);
		expect(bulk.body.errors.map((error) => error.id)).toEqual([testCase.id]);
		const row = await fixture.db.query.testCases.findFirst({
			where: eq(testCases.id, testCase.id),
		});
		expect(row?.status).toBe("review");

		// An approver may move it anywhere.
		const toDraft = await fixture.call<TestCaseDetail>(
			`/test-cases/${testCase.id}`,
			{ method: "PATCH", token: fixture.qa.token, body: { status: "draft" } },
		);
		expect(toDraft.status).toBe(200);
		expect(toDraft.body.status).toBe("draft");
	});

	it("keeps duplicates of a review case in review", async () => {
		const fixture = await createTestCaseFixture();
		const author = await authorWithoutApprove(fixture);
		const testCase = await reviewCase(fixture);
		const duplicate = await fixture.call<{ testCase: TestCaseDetail }>(
			`/test-cases/${testCase.id}/duplicate`,
			{ token: author.token, body: {} },
		);
		expect(duplicate.status).toBe(201);
		expect(duplicate.body.testCase.status).toBe("review");
		const run = await fixture.call(
			`/test-cases/${duplicate.body.testCase.id}/runs`,
			{ token: author.token, body: {} },
		);
		expect(run.status).not.toBe(201);

		// Duplicates of an approved case still start as drafts.
		const approved = await fixture.call<{ testCase: TestCaseDetail }>(
			`/test-cases/${testCase.id}/approve`,
			{ token: fixture.qa.token, body: {} },
		);
		expect(approved.status).toBe(200);
		const copy = await fixture.call<{ testCase: TestCaseDetail }>(
			`/test-cases/${testCase.id}/duplicate`,
			{ token: author.token, body: {} },
		);
		expect(copy.body.testCase.status).toBe("draft");
	});
});
