import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";

import { organizations, testRunBatches } from "../src/db/schema";
import { ensureDefaultOrganizationRoles } from "../src/services/organization-permissions";
import { toBatch } from "../src/services/test-runs";
import { createTestCaseFixture, loginTranscript } from "./test-case-fixtures";

// Review finding: toBatch refreshed (wrote) a batch before checking that it belongs to the
// caller's organisation, so any member could make the backend rewrite another org's batch.

describe("run batch scope", () => {
	it("does not touch another organisation's batch", async () => {
		const fixture = await createTestCaseFixture();
		const created = await fixture.call<{ id: string }>("/test-cases", {
			token: fixture.qa.token,
			body: { transcript: loginTranscript() },
		});
		const suite = await fixture.call<{ id: string }>("/test-suites", {
			token: fixture.qa.token,
			body: { name: "Smoke", memberIds: [created.body.id] },
		});
		const run = await fixture.call<{ batchId: string }>(
			`/test-suites/${suite.body.id}/runs`,
			{ token: fixture.qa.token, body: { trigger: "ci" } },
		);
		expect(run.status).toBe(201);
		const batchId = run.body.batchId;
		// Stale stored counts: a refresh would rewrite them.
		await fixture.db
			.update(testRunBatches)
			.set({ pending: 99, total: 99, updatedAt: 1 })
			.where(eq(testRunBatches.id, batchId));

		const [otherOrg] = await fixture.db
			.insert(organizations)
			.values({ name: "Other", isPersonal: false })
			.returning({ id: organizations.id });
		if (!otherOrg) throw new Error("Expected organization");
		await ensureDefaultOrganizationRoles(fixture.db, otherOrg.id);
		await expect(
			toBatch(fixture.db, batchId, otherOrg.id),
		).rejects.toMatchObject({ status: 404, code: "TEST_RUN_BATCH_NOT_FOUND" });
		const outsider = await fixture.member("admin", otherOrg.id);
		for (const path of [
			`/test-run-batches/${batchId}`,
			`/test-runs?batchId=${batchId}`,
		]) {
			const response = await fixture.call(path, { token: outsider.token });
			expect(response.status).toBe(404);
		}
		const untouched = await fixture.db.query.testRunBatches.findFirst({
			where: eq(testRunBatches.id, batchId),
		});
		expect(untouched).toMatchObject({ pending: 99, total: 99, updatedAt: 1 });

		// The owning organisation still gets a refreshed batch.
		const own = await toBatch(fixture.db, batchId, fixture.orgId);
		expect(own.counts.total).toBe(1);
	});
});
