import { describe, expect, it } from "bun:test";
import type {
	AgentNotes,
	ClaimedRun,
	TestRunConfig,
} from "@jittle-lamp/shared";
import { and, eq } from "drizzle-orm";

import { organizationActivityLogs } from "../src/db/schema";
import {
	createTestCaseFixture,
	FAKE_MODEL_KEY,
	FAKE_PASSWORD,
} from "./test-case-fixtures";
import { registerRunner, seedRunnableCase } from "./test-run-fixtures";

describe("agent notes per organisation", () => {
	it("saves notes with test_config.manage, caps them at 16 KB and logs the change", async () => {
		const fixture = await createTestCaseFixture();
		const empty = await fixture.call<AgentNotes>("/test-agent-notes", {
			token: fixture.developer.token,
		});
		expect(empty.status).toBe(200);
		expect(empty.body).toEqual({ notes: "", updatedBy: null, updatedAt: null });

		const denied = await fixture.call("/test-agent-notes", {
			method: "PUT",
			token: fixture.qa.token,
			body: { notes: "Prefer the E2E prefix." },
		});
		expect(denied.status).toBe(403);

		// 8 200 two-byte characters: under 16 384 characters, over 16 KB.
		const tooLarge = await fixture.call("/test-agent-notes", {
			method: "PUT",
			token: fixture.admin.token,
			body: { notes: "é".repeat(8_200) },
		});
		expect(tooLarge.status).toBe(422);

		const saved = await fixture.call<AgentNotes>("/test-agent-notes", {
			method: "PUT",
			token: fixture.admin.token,
			body: { notes: "Records created by tests start with E2E-." },
		});
		expect(saved.status).toBe(200);
		expect(saved.body.updatedBy).toBe(fixture.admin.userId);

		const read = await fixture.call<AgentNotes>("/test-agent-notes", {
			token: fixture.developer.token,
		});
		expect(read.body).toMatchObject({
			notes: "Records created by tests start with E2E-.",
			updatedBy: fixture.admin.userId,
		});
		expect(read.body.updatedAt).toBeNumber();

		const logs = await fixture.db.query.organizationActivityLogs.findMany({
			where: and(
				eq(organizationActivityLogs.organizationId, fixture.orgId),
				eq(organizationActivityLogs.action, "test_config.agent_notes_updated"),
			),
		});
		expect(logs).toHaveLength(1);
		// The log records lengths, never the notes themselves.
		expect(JSON.stringify(logs)).not.toContain("E2E-.");
	});

	it("hands the notes to the runner in the run configuration", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
			modelKey: FAKE_MODEL_KEY,
		});
		await fixture.call("/test-agent-notes", {
			method: "PUT",
			token: fixture.admin.token,
			body: { notes: "Dismiss the cookie banner first." },
		});
		const runner = await registerRunner(fixture);
		await fixture.call(`/test-cases/${testCase.id}/runs`, {
			token: fixture.qa.token,
			body: {},
		});
		const claim = await fixture.call<{ run: ClaimedRun | null }>(
			"/runner-pools/claim",
			{ token: runner.workerToken, body: {} },
		);
		const claimed = claim.body.run;
		if (!claimed) throw new Error("Expected a claimed run");
		const config = await fixture.call<TestRunConfig>(
			`/test-runs/${claimed.runId}/config`,
			{ token: claimed.runToken },
		);
		expect(config.status).toBe(200);
		expect(config.body.agentNotes).toBe("Dismiss the cookie banner first.");
		expect(config.body.environment.agentInstructions).toBe(
			"Never delete records.",
		);
	});
});
