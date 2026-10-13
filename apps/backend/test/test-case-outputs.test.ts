import { describe, expect, it } from "bun:test";
import type {
	ClaimedRun,
	CreateTestRunResponse,
	TestCaseDetail,
	TestRunConfig,
	TestRunDetail,
} from "@jittle-lamp/shared";
import { eq } from "drizzle-orm";

import { testCases } from "../src/db/schema";
import {
	createTestCaseFixture,
	FAKE_PASSWORD,
	loginTranscript,
} from "./test-case-fixtures";
import { registerRunner, seedRunnableCase } from "./test-run-fixtures";

// Roadmap 2026-10-13 §2.5, §2.6 and §5: Outputs:/Reuse: persistence, the execution-mode guard
// (decision 2), the claimed-run API configuration and postgres profiles in the run config.

const registrationTranscript = [
	"# Submit a registration",
	"Outputs: applicationId, student",
	"Reuse: within 30m",
	"",
	"[Open] /registrations/new",
	"[Query: PCF_UAT_DB] a K1 student with a pending registration -> {student}",
	"[Act] submit the form for {student.name}",
	"[Extract: applicationId] the application number in the banner",
	"",
	"## Checkpoint: Application exists",
	"[Query: PCF_UAT_DB] the application {applicationId} has status PENDING",
].join("\n");

describe("case outputs, reuse and execution modes", () => {
	it("persists Outputs: and Reuse: and returns them on the case detail", async () => {
		const fixture = await createTestCaseFixture();
		const created = await fixture.call<TestCaseDetail>("/test-cases", {
			token: fixture.qa.token,
			body: { transcript: registrationTranscript },
		});
		expect(created.status).toBe(201);
		expect(created.body.outputs).toEqual(["applicationId", "student"]);
		expect(created.body.reuse).toEqual({ kind: "within", ms: 30 * 60_000 });
		expect(created.body.steps.map((step) => step.binding)).toEqual([
			null,
			"student",
			null,
			null,
			null,
		]);
		// The [Query] profile is required configuration like a [Login] profile.
		expect(created.body.requiredConfig.credentials).toEqual(["PCF_UAT_DB"]);
		expect(
			created.body.lint.filter((finding) => finding.severity === "error"),
		).toEqual([]);

		const row = await fixture.db.query.testCases.findFirst({
			where: eq(testCases.id, created.body.id),
			columns: { outputsJson: true, reusePolicyJson: true },
		});
		expect(row).toEqual({
			outputsJson: '["applicationId","student"]',
			reusePolicyJson: '{"kind":"within","ms":1800000}',
		});

		const fetched = await fixture.call<TestCaseDetail>(
			`/test-cases/${created.body.key}`,
			{ token: fixture.developer.token },
		);
		expect(fetched.body.outputs).toEqual(["applicationId", "student"]);
		expect(fetched.body.reuse).toEqual({ kind: "within", ms: 30 * 60_000 });

		// `{alias.name}` is checked against the used case's outputs.
		const consumer = await fixture.call<TestCaseDetail>("/test-cases", {
			token: fixture.qa.token,
			body: {
				transcript: [
					"# Approve a registration",
					"",
					`[Use: ${created.body.key} as registration, mode=api]`,
					"[Open] /applications/{registration.applicationId}",
					"[Assert] the page shows {registration.nothing}",
				].join("\n"),
			},
		});
		expect(consumer.status).toBe(201);
		expect(
			consumer.body.lint
				.filter((finding) => finding.ruleId === "use-output-unknown")
				.map((finding) => finding.message),
		).toEqual([
			expect.stringContaining('registration does not output "nothing"'),
		]);
		expect(
			consumer.body.lint.some(
				(finding) => finding.ruleId === "undeclared-variable",
			),
		).toBe(false);

		// Dropping the lines resets both; a case without them reads as never.
		const updated = await fixture.call<TestCaseDetail>(
			`/test-cases/${created.body.id}`,
			{
				method: "PATCH",
				token: fixture.qa.token,
				body: {
					transcript: registrationTranscript
						.replace("Outputs: applicationId, student\n", "")
						.replace("Reuse: within 30m\n", ""),
					expectedVersion: 1,
				},
			},
		);
		expect(updated.status).toBe(200);
		expect(updated.body.outputs).toEqual([]);
		expect(updated.body.reuse).toEqual({ kind: "never" });
		const plain = await fixture.call<TestCaseDetail>("/test-cases", {
			token: fixture.qa.token,
			body: { transcript: loginTranscript("Plain case") },
		});
		expect(plain.body.outputs).toEqual([]);
		expect(plain.body.reuse).toEqual({ kind: "never" });
	});

	it("blocks hybrid and api runs with API_NOT_CONFIGURED until the environment has API origins", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase, environmentId } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});

		const blocked = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{ token: fixture.qa.token, body: { executionMode: "api" } },
		);
		expect(blocked.status).toBe(201);
		expect(blocked.body.status).toBe("completed");
		const blockedRun = await fixture.call<TestRunDetail>(
			`/test-runs/${blocked.body.runId}`,
			{ token: fixture.qa.token },
		);
		expect(blockedRun.body).toMatchObject({
			status: "completed",
			outcome: "blocked",
			blockedReason: "API_NOT_CONFIGURED",
			executionMode: "api",
			queuePosition: null,
		});
		expect(blockedRun.body.finishedAt).toBeNumber();

		// A full run of the same case is a different run and queues as before.
		const full = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{ token: fixture.qa.token, body: {} },
		);
		expect(full.body).toMatchObject({ attached: false, status: "queued" });
		const fullRun = await fixture.call<TestRunDetail>(
			`/test-runs/${full.body.runId}`,
			{ token: fixture.qa.token },
		);
		expect(fullRun.body).toMatchObject({
			executionMode: "full",
			blockedReason: "NO_RUNNER",
		});

		const configured = await fixture.call(
			`/test-environments/${environmentId}`,
			{
				method: "PATCH",
				token: fixture.admin.token,
				body: {
					apiOrigins: ["https://api.example.test"],
					openapiUrl: "https://api.example.test/openapi.json",
					apiPolicy: { allowedPaths: ["/api/**"], maxRequestsPerStep: 20 },
				},
			},
		);
		expect(configured.status).toBe(200);
		const hybrid = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{ token: fixture.qa.token, body: { executionMode: "hybrid" } },
		);
		expect(hybrid.body).toMatchObject({ attached: false, status: "queued" });
		const hybridRun = await fixture.call<TestRunDetail>(
			`/test-runs/${hybrid.body.runId}`,
			{ token: fixture.qa.token },
		);
		expect(hybridRun.body).toMatchObject({
			executionMode: "hybrid",
			status: "queued",
			blockedReason: "NO_RUNNER",
		});
		// Identical hybrid requests attach to the queued hybrid run, not the full one.
		const again = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{ token: fixture.developer.token, body: { executionMode: "hybrid" } },
		);
		expect(again.body).toMatchObject({
			attached: true,
			runId: hybrid.body.runId,
		});
	});

	it("hands the runner the execution mode, API configuration and only referenced postgres profiles", async () => {
		const fixture = await createTestCaseFixture();
		const { environmentId } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});
		await fixture.call(`/test-environments/${environmentId}`, {
			method: "PATCH",
			token: fixture.admin.token,
			body: {
				apiOrigins: ["https://api.example.test"],
				openapiUrl: "https://api.example.test/openapi.json",
				apiPolicy: { allowedPaths: ["/api/**"], rateLimitPerSecond: 5 },
			},
		});
		const database = await fixture.call("/test-credentials", {
			token: fixture.admin.token,
			body: {
				profile: "PCF_UAT_DB",
				kind: "postgres",
				environmentId,
				fields: { host: "db.example.test", database: "sv", user: "qa" },
				secretFields: { password: "fake-db-password" },
			},
		});
		expect(database.status).toBe(201);
		// A login profile that shares the database profile's name prefix must not leak into
		// a [Query] step, and the database must not satisfy a [Login].
		await fixture.call("/test-credentials", {
			token: fixture.admin.token,
			body: {
				profile: "OTHER_DB",
				kind: "postgres",
				fields: { host: "other.example.test", database: "x", user: "y" },
				secretFields: { password: "fake-other-password" },
			},
		});
		const withQuery = await fixture.call<TestCaseDetail>("/test-cases", {
			token: fixture.qa.token,
			body: {
				transcript: [
					loginTranscript("Approve with a database check"),
					"[Query: PCF_UAT_DB] the admin session row exists",
				].join("\n"),
				environmentId,
			},
		});
		expect(withQuery.status).toBe(201);
		expect(withQuery.body.requiredConfig).toEqual({
			variables: [],
			credentials: ["PCF_HQ_ADMIN", "PCF_UAT_DB"],
			unresolved: [],
		});

		const requested = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${withQuery.body.id}/runs`,
			{ token: fixture.qa.token, body: { executionMode: "hybrid" } },
		);
		expect(requested.status).toBe(201);
		// Two slots, so the login-only run below can be claimed while this one stays claimed.
		const runner = await registerRunner(fixture, "devbox", 2);
		const claim = await fixture.call<{ run: ClaimedRun | null }>(
			"/runner-pools/claim",
			{ token: runner.workerToken, body: {} },
		);
		const claimed = claim.body.run;
		if (!claimed) throw new Error("Expected a claimed run");
		expect(claimed).toMatchObject({
			runId: requested.body.runId,
			executionMode: "hybrid",
			apiOrigins: ["https://api.example.test"],
			openapiUrl: "https://api.example.test/openapi.json",
			apiPolicy: {
				allowedPaths: ["/api/**"],
				maxRequestsPerStep: 50,
				rateLimitPerSecond: 5,
			},
		});
		expect(claimed.steps.at(-1)).toMatchObject({
			type: "query",
			binding: null,
			credentialRefs: ["PCF_UAT_DB"],
		});

		const config = await fixture.call<TestRunConfig>(
			`/test-runs/${requested.body.runId}/config`,
			{ token: claimed.runToken },
		);
		expect(config.status).toBe(200);
		expect(
			config.body.credentials
				.map((credential) => [credential.profile, credential.kind ?? "login"])
				.sort(),
		).toEqual([
			["PCF_HQ_ADMIN", "login"],
			["PCF_UAT_DB", "postgres"],
		]);
		const databaseConfig = config.body.credentials.find(
			(credential) => credential.profile === "PCF_UAT_DB",
		);
		expect(databaseConfig).toEqual({
			profile: "PCF_UAT_DB",
			kind: "postgres",
			fields: { host: "db.example.test", database: "sv", user: "qa" },
			loginField: null,
			secretFields: { password: "fake-db-password" },
		});
		expect(JSON.stringify(config.body)).not.toContain("fake-other-password");

		// A case without a [Query] step never receives a postgres profile.
		const withoutQuery = await fixture.call<TestCaseDetail>("/test-cases", {
			token: fixture.qa.token,
			body: {
				transcript: loginTranscript("Login only"),
				environmentId,
			},
		});
		const plainRun = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${withoutQuery.body.id}/runs`,
			{ token: fixture.qa.token, body: {} },
		);
		const nextClaim = await fixture.call<{ run: ClaimedRun | null }>(
			"/runner-pools/claim",
			{ token: runner.workerToken, body: {} },
		);
		const plainClaimed = nextClaim.body.run;
		if (!plainClaimed) throw new Error("Expected the login-only run");
		expect(plainClaimed.runId).toBe(plainRun.body.runId);
		expect(plainClaimed.executionMode).toBe("full");
		const plainConfig = await fixture.call<TestRunConfig>(
			`/test-runs/${plainRun.body.runId}/config`,
			{ token: plainClaimed.runToken },
		);
		expect(
			plainConfig.body.credentials.map((credential) => credential.profile),
		).toEqual(["PCF_HQ_ADMIN"]);
	});
});
