import { describe, expect, it } from "bun:test";
import type { DraftTestCaseResponse } from "@jittle-lamp/shared";

import {
	draftNotesTranscript,
	draftPlaceholderTitle,
} from "../src/services/test-cases";
import {
	createTestCaseFixture,
	FAKE_MODEL_KEY,
	FAKE_PASSWORD,
} from "./test-case-fixtures";
import { seedRunnableCase } from "./test-run-fixtures";

// POST /test-cases/draft (roadmap §3.2): plain language in, a parseable transcript out. The
// model sees the grammar, the environment, the agent notes, the credential profile names and
// the closest existing cases; nothing is stored.

const description = [
	"Sign out from the account menu as the HQ admin.",
	"The login form should be shown again with an empty Email field.",
].join("\n");

const goodDraft = [
	"# HQ admin signs out from the account menu",
	"",
	"[Open] /login",
	"[Login: PCF_HQ_ADMIN] sign in as the HQ admin",
	'[Act] open the account menu and choose "Sign out"',
	"",
	"## Checkpoint: Signed out",
	"[Assert] the login form is shown again",
	"[Assert] the Email field is empty",
].join("\n");

describe("draft helpers", () => {
	it("derives a placeholder title and a Note-only transcript from plain text", () => {
		expect(
			draftPlaceholderTitle("\n  # Approve a pending application\nthen more"),
		).toBe("Approve a pending application");
		expect(draftPlaceholderTitle("   \n ")).toBe("Untitled test");
		expect(
			draftNotesTranscript("Login as admin\n\nApprove the first application\n"),
		).toBe(
			"# Login as admin\n\n[Note] Login as admin\n[Note] Approve the first application\n",
		);
	});
});

describe("POST /test-cases/draft", () => {
	it("prompts the act model with the grammar, environment, notes, profiles and similar cases", async () => {
		const prompts: string[] = [];
		const fixture = await createTestCaseFixture({
			dependencies: {
				generateText: async ({ prompt, modelId }) => {
					prompts.push(prompt);
					expect(modelId).toBe("anthropic/claude-opus-5-5");
					return `\`\`\`\n${goodDraft}\n\`\`\``;
				},
			},
		});
		const { environmentId, testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
			modelKey: FAKE_MODEL_KEY,
		});
		const notes = await fixture.call("/test-agent-notes", {
			method: "PUT",
			token: fixture.admin.token,
			body: { notes: "Prefer the E2E prefix for new records." },
		});
		expect(notes.status).toBe(200);

		const response = await fixture.call<DraftTestCaseResponse>(
			"/test-cases/draft",
			{
				token: fixture.qa.token,
				body: { text: description, environmentId },
			},
		);
		expect(response.status).toBe(200);
		expect(response.body.title).toBe(
			"HQ admin signs out from the account menu",
		);
		expect(response.body.transcript.startsWith("# HQ admin signs out")).toBe(
			true,
		);
		expect(response.body.transcript).toContain("[Login: PCF_HQ_ADMIN]");
		expect(
			response.body.lint.filter((finding) => finding.severity === "error"),
		).toEqual([]);
		// The seeded login case is about the same sign-out flow.
		expect(response.body.similar.map((item) => item.key)).toEqual([
			testCase.key,
		]);

		expect(prompts).toHaveLength(1);
		const prompt = prompts[0] ?? "";
		expect(prompt).toContain("'# Title' line");
		expect(prompt).toContain("Environment: pcf-uat (https://uat.example.test)");
		expect(prompt).toContain("Never delete records.");
		expect(prompt).toContain("Prefer the E2E prefix for new records.");
		expect(prompt).toContain("{vars.NAME}: SCHOOL_CODE");
		expect(prompt).toContain(
			"credential profiles: PCF_HQ_ADMIN, UNUSED_PROFILE",
		);
		expect(prompt).not.toContain(FAKE_PASSWORD);
		expect(prompt).toContain(`--- ${testCase.key} ---`);
		expect(prompt).toContain("[Login: PCF_HQ_ADMIN] sign in as the HQ admin");
		expect(prompt).toContain(description);

		// Nothing was created.
		const list = await fixture.call<{ total: number }>("/test-cases", {
			token: fixture.qa.token,
		});
		expect(list.body.total).toBe(1);
	});

	it("starts the draft with [Use: KEY] when a start-from case is given", async () => {
		const prompts: string[] = [];
		const fixture = await createTestCaseFixture({
			dependencies: {
				generateText: async ({ prompt }) => {
					prompts.push(prompt);
					// The model ignored the instruction: the service inserts the Use step.
					return "# After login\n\n[Act] open the Reports page\n\n## Checkpoint: Reports\n[Assert] the attendance report is listed\n";
				},
			},
		});
		const { environmentId, testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
			modelKey: FAKE_MODEL_KEY,
		});
		const response = await fixture.call<DraftTestCaseResponse>(
			"/test-cases/draft",
			{
				token: fixture.qa.token,
				body: {
					text: "Open Reports and check the attendance report is listed.",
					environmentId,
					startFromCaseId: testCase.id,
				},
			},
		);
		expect(response.status).toBe(200);
		expect(prompts[0]).toContain(
			`the first step must be [Use: ${testCase.key}]`,
		);
		expect(response.body.transcript.split("\n").slice(0, 3)).toEqual([
			"# After login",
			"",
			`[Use: ${testCase.key}]`,
		]);
		expect(
			response.body.lint.filter((finding) => finding.severity === "error"),
		).toEqual([]);
		// The start-from case is not listed as a similar case of itself.
		expect(response.body.similar.map((item) => item.id)).not.toContain(
			testCase.id,
		);
	});

	it("retries once with the parse error, then answers 422 DRAFT_UNPARSEABLE with the raw text", async () => {
		const prompts: string[] = [];
		let calls = 0;
		const fixture = await createTestCaseFixture({
			dependencies: {
				generateText: async ({ prompt }) => {
					prompts.push(prompt);
					calls += 1;
					return calls === 1
						? "Sure! Here is a plan:\n1. open\n2. click"
						: goodDraft;
				},
			},
		});
		const { environmentId } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
			modelKey: FAKE_MODEL_KEY,
		});
		const recovered = await fixture.call<DraftTestCaseResponse>(
			"/test-cases/draft",
			{
				token: fixture.qa.token,
				body: { text: description, environmentId },
			},
		);
		expect(recovered.status).toBe(200);
		expect(calls).toBe(2);
		expect(prompts[1]).toContain("Your previous answer could not be parsed");
		expect(prompts[1]).toContain("missing the '# Title' line");

		calls = 0;
		const broken = await createTestCaseFixture({
			dependencies: {
				generateText: async () => "nothing useful",
			},
		});
		const seeded = await seedRunnableCase(broken, {
			password: FAKE_PASSWORD,
			modelKey: FAKE_MODEL_KEY,
		});
		const failed = await broken.call<{
			error: { code: string };
			raw: string;
		}>("/test-cases/draft", {
			token: broken.qa.token,
			body: { text: description, environmentId: seeded.environmentId },
		});
		expect(failed.status).toBe(422);
		expect(failed.body.error.code).toBe("DRAFT_UNPARSEABLE");
		expect(failed.body.raw).toBe("nothing useful");
	}, 20_000);

	it("validates the body and the environment, and needs test_config.use", async () => {
		const fixture = await createTestCaseFixture({
			dependencies: { generateText: async () => goodDraft },
		});
		const { environmentId } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
			modelKey: FAKE_MODEL_KEY,
		});
		const tooLong = await fixture.call("/test-cases/draft", {
			token: fixture.qa.token,
			body: { text: "x".repeat(8001), environmentId },
		});
		expect(tooLong.status).toBe(422);
		const unknownEnvironment = await fixture.call<{ error: { code: string } }>(
			"/test-cases/draft",
			{
				token: fixture.qa.token,
				body: { text: description, environmentId: "env_missing" },
			},
		);
		expect(unknownEnvironment.status).toBe(404);
		expect(unknownEnvironment.body.error.code).toBe(
			"TEST_ENVIRONMENT_NOT_FOUND",
		);
		const developer = await fixture.call("/test-cases/draft", {
			token: fixture.developer.token,
			body: { text: description, environmentId },
		});
		expect(developer.status).toBe(403);
	});
});
