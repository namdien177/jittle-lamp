import { describe, expect, it } from "bun:test";
import type {
	ClaimedRun,
	CreateTestRunResponse,
	TestCaseDetail,
	TestRunConfig,
} from "@jittle-lamp/shared";

import { createTestCaseFixture, FAKE_PASSWORD } from "./test-case-fixtures";
import { registerRunner, seedRunnableCase } from "./test-run-fixtures";

// [Use: KEY] runs another case inline: the claim carries the linked case and the run config
// decrypts the credential profile the linked case logs in with.

const interestTranscript = (useKey: string) =>
	[
		"# Admin creates an interest",
		"",
		`[Use: ${useKey}] sign in as the HQ admin first`,
		"[Act] open Interests and click New interest",
		"",
		"## Checkpoint: The interest is saved",
		"[Assert] the new interest is listed",
	].join("\n");

describe("[Use: KEY] runs", () => {
	it("lints the key, ships the linked case with the claim and decrypts its login profile", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase: login, environmentId } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});
		expect(login.key).toBe("TC-0001");

		const unknown = await fixture.call<TestCaseDetail>("/test-cases", {
			token: fixture.qa.token,
			body: { transcript: interestTranscript("TC-0404"), environmentId },
		});
		expect(unknown.status).toBe(201);
		expect(
			unknown.body.lint
				.filter((finding) => finding.ruleId === "use-needs-case")
				.map((finding) => finding.message),
		).toEqual(["No test case TC-0404."]);

		const created = await fixture.call<TestCaseDetail>("/test-cases", {
			token: fixture.qa.token,
			body: { transcript: interestTranscript("TC-0001"), environmentId },
		});
		expect(created.status).toBe(201);
		expect(created.body.lintErrors).toBe(0);

		const requested = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${created.body.id}/runs`,
			{ token: fixture.qa.token, body: {} },
		);
		expect(requested.status).toBe(201);
		const runner = await registerRunner(fixture);
		const claim = await fixture.call<{ run: ClaimedRun | null }>(
			"/runner-pools/claim",
			{ token: runner.workerToken, body: {} },
		);
		const claimed = claim.body.run;
		if (!claimed) throw new Error("Expected a claimed run");
		expect(claimed.testCaseKey).toBe(created.body.key);
		expect(claimed.cases.map((linked) => [linked.key, linked.version])).toEqual(
			[["TC-0001", 1]],
		);
		expect(claimed.cases[0]?.transcript).toContain("[Login: PCF_HQ_ADMIN]");

		// The interest case never names PCF_HQ_ADMIN itself; the linked login does.
		const config = await fixture.call<TestRunConfig>(
			`/test-runs/${claimed.runId}/config`,
			{ token: claimed.runToken },
		);
		expect(config.status).toBe(200);
		expect(config.body.credentials.map((entry) => entry.profile)).toEqual([
			"PCF_HQ_ADMIN",
		]);
		expect(config.body.credentials[0]?.secretFields.password).toBe(
			FAKE_PASSWORD,
		);
	});
});
