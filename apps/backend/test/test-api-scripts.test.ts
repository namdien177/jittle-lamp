import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type {
	ApiRequestScript,
	ClaimedRun,
	CreateTestRunResponse,
	RecentOutputsResponse,
	StepScript,
	TestRunDetail,
} from "@jittle-lamp/shared";
import { eq } from "drizzle-orm";

import { testStepScripts } from "../src/db/schema";
import { createTestCaseFixture, FAKE_PASSWORD } from "./test-case-fixtures";
import {
	buildRunReport,
	registerRunner,
	seedRunnableCase,
} from "./test-run-fixtures";

// Roadmap 2026-10-13 §2.3, §2.4, §2.6: API scripts behind the run token (read, write, stale),
// the reviewer's fix through PATCH /test-cases/:id/scripts/:scriptId, run outputs on the run
// detail, and the reuse-window lookups.

const script = (stepId: string): ApiRequestScript => ({
	schemaVersion: "jl-api-1",
	stepId,
	instructionKey: null,
	recordedAt: "2026-10-13T10:00:00.000Z",
	auth: { "x-dev-domain": "pcf" },
	requests: [
		{
			seq: 1,
			method: "POST",
			origin: "https://api.example.test",
			pathTemplate: "/api/applications",
			query: {},
			headersTemplate: { cookie: "{{auth.cookie}}" },
			bodyKind: "json",
			bodyTemplate: { name: "Widget" },
			numericLeaves: [],
			mutation: true,
			check: true,
			captures: [],
			expect: { statusClass: "2xx", shape: { id: "string" } },
		},
		{
			seq: 2,
			method: "PUT",
			origin: "https://api.example.test",
			pathTemplate: "/api/applications/4f6c1c2a-3b1d-4e0f-9c7a-1234567890ab",
			query: {},
			headersTemplate: {},
			bodyKind: null,
			numericLeaves: [],
			mutation: true,
			check: true,
			captures: [],
			expect: { statusClass: "2xx", shape: null },
		},
	],
	reviewFlags: [
		{
			seq: 2,
			location: "path[3]",
			value: "4f6c1c2a-3b1d-4e0f-9c7a-1234567890ab",
			reason: "uuid value not found in an earlier response",
			candidates: [{ fromSeq: 1, path: "id", sample: "4f6c…" }],
		},
	],
});

const emptyParamsHash = `sha256:${createHash("sha256").update("{}", "utf8").digest("hex")}`;

describe("API scripts, run outputs and reuse", () => {
	it("stores, versions, stales and fixes API scripts, and verifies them on replay", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase, environmentId } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});
		await fixture.call(`/test-environments/${environmentId}`, {
			method: "PATCH",
			token: fixture.admin.token,
			body: { apiOrigins: ["https://api.example.test"] },
		});
		const act = testCase.steps.find((step) => step.type === "act");
		if (!act) throw new Error("Expected an act step");
		const runner = await registerRunner(fixture, "devbox", 2);
		const claimRun = async (executionMode: "full" | "api") => {
			const requested = await fixture.call<CreateTestRunResponse>(
				`/test-cases/${testCase.id}/runs`,
				{ token: fixture.qa.token, body: { executionMode, force: true } },
			);
			expect(requested.status).toBe(201);
			const claim = await fixture.call<{ run: ClaimedRun | null }>(
				"/runner-pools/claim",
				{ token: runner.workerToken, body: {} },
			);
			if (!claim.body.run) throw new Error("Expected a claimed run");
			return claim.body.run;
		};
		const cacheUrl = (run: ClaimedRun) =>
			`/test-runs/${run.runId}/cache/api/${encodeURIComponent(act.stepId)}`;

		// Run A records the script; a second write bumps the version and stales the first.
		const runA = await claimRun("api");
		const miss = await fixture.call<{ status: string }>(cacheUrl(runA), {
			token: runA.runToken,
		});
		expect(miss.body).toEqual({ status: "miss" });
		const mismatch = await fixture.call(cacheUrl(runA), {
			method: "PUT",
			token: runA.runToken,
			body: { script: script("another-step") },
		});
		expect(mismatch.status).toBe(422);
		const written = await fixture.call<{ ok: boolean; scriptId: string }>(
			cacheUrl(runA),
			{
				method: "PUT",
				token: runA.runToken,
				body: { script: script(act.stepId) },
			},
		);
		expect(written.status).toBe(200);
		const hit = await fixture.call<{
			status: string;
			script: ApiRequestScript;
			version: number;
		}>(cacheUrl(runA), { token: runA.runToken });
		expect(hit.body.status).toBe("hit");
		expect(hit.body.version).toBe(1);
		expect(hit.body.script.requests).toHaveLength(2);
		await fixture.call(cacheUrl(runA), {
			method: "PUT",
			token: runA.runToken,
			body: { script: script(act.stepId) },
		});
		const rows = await fixture.db.query.testStepScripts.findMany({
			where: eq(testStepScripts.testCaseId, testCase.id),
		});
		expect(
			rows
				.map((row) => [row.kind, row.version, row.status, row.keyHash])
				.sort((a, b) => Number(a[1]) - Number(b[1])),
		).toEqual([
			["api-requests", 1, "stale", `api:${act.stepId}`],
			["api-requests", 2, "active", `api:${act.stepId}`],
		]);
		// A stale mark from the recording run itself is ignored: its recording keeps its status.
		const ownStale = await fixture.call<{ staled: boolean }>(cacheUrl(runA), {
			method: "PUT",
			token: runA.runToken,
			body: { stale: true, reason: "test" },
		});
		expect(ownStale.body.staled).toBe(false);

		// The reviewer sees the script with its flag and binds the literal to a field.
		const listed = await fixture.call<{ items: StepScript[] }>(
			`/test-cases/${testCase.id}/scripts`,
			{ token: fixture.qa.token },
		);
		const apiScript = listed.body.items.find(
			(item) => item.kind === "api-requests" && item.status === "active",
		);
		if (!apiScript) throw new Error("Expected the active API script");
		expect(apiScript.requests?.requests).toHaveLength(2);
		expect(apiScript.reviewFlags).toHaveLength(1);
		expect(apiScript.renderedCode).toContain("POST /api/applications");
		const badFix = await fixture.call(
			`/test-cases/${testCase.id}/scripts/${apiScript.id}`,
			{
				method: "PATCH",
				token: fixture.qa.token,
				body: {
					fixes: [{ seq: 2, location: "path[3]", fromSeq: 2, path: "id" }],
				},
			},
		);
		expect(badFix.status).toBe(422);
		const fixed = await fixture.call<StepScript>(
			`/test-cases/${testCase.id}/scripts/${apiScript.id}`,
			{
				method: "PATCH",
				token: fixture.qa.token,
				body: {
					fixes: [{ seq: 2, location: "path[3]", fromSeq: 1, path: "id" }],
				},
			},
		);
		expect(fixed.status).toBe(200);
		expect(fixed.body.reviewFlags).toEqual([]);
		expect(fixed.body.requests?.requests[1]).toMatchObject({
			pathTemplate: "/api/applications/{{v1}}",
			captures: [{ as: "v1", fromSeq: 1, path: "id" }],
		});
		// Developers view and run; they cannot rewrite scripts.
		const forbidden = await fixture.call(
			`/test-cases/${testCase.id}/scripts/${apiScript.id}`,
			{
				method: "PATCH",
				token: fixture.developer.token,
				body: {
					fixes: [{ seq: 2, location: "path[3]", fromSeq: 1, path: "id" }],
				},
			},
		);
		expect(forbidden.status).toBe(403);

		// Run A finalises with the step replayed through the API: the script is verified.
		const reportA = buildRunReport(runA);
		const replayedSteps = reportA.steps.map((step) =>
			step.stepId === act.stepId
				? {
						...step,
						mode: "api-replayed" as const,
						cacheReason: "hit" as const,
						requests: {
							count: 2,
							mutations: 2,
							items: [
								{
									seq: 1,
									method: "POST",
									path: "/api/applications",
									status: 201,
									durationMs: 40,
									mutation: true,
									error: null,
								},
							],
						},
					}
				: step,
		);
		const finalA = await fixture.call<TestRunDetail>(
			`/test-runs/${runA.runId}/finalize`,
			{
				token: runA.runToken,
				body: {
					report: { ...reportA, steps: replayedSteps },
					evidenceId: null,
				},
			},
		);
		expect(finalA.status).toBe(200);
		const detailA = finalA.body.steps.find(
			(step) => step.stepId === act.stepId,
		);
		expect(detailA?.mode).toBe("api-replayed");
		expect(detailA?.requests?.items?.[0]).toMatchObject({
			method: "POST",
			status: 201,
		});
		const verified = await fixture.db.query.testStepScripts.findFirst({
			where: eq(testStepScripts.id, apiScript.id),
		});
		expect(verified?.verifiedCount).toBe(1);

		// Run B hands the step off: the script goes stale and the next read misses.
		const runB = await claimRun("api");
		const hitB = await fixture.call<{ status: string }>(cacheUrl(runB), {
			token: runB.runToken,
		});
		expect(hitB.body.status).toBe("hit");
		const staled = await fixture.call<{ staled: boolean }>(cacheUrl(runB), {
			method: "PUT",
			token: runB.runToken,
			body: {
				stale: true,
				reason: "API replay stopped at request 1: status 500",
			},
		});
		expect(staled.body.staled).toBe(true);
		const missB = await fixture.call<{ status: string }>(cacheUrl(runB), {
			token: runB.runToken,
		});
		expect(missB.body.status).toBe("miss");
		const stale = await fixture.db.query.testStepScripts.findFirst({
			where: eq(testStepScripts.id, apiScript.id),
		});
		expect(stale?.status).toBe("stale");
		expect(stale?.staleReason).toContain("status 500");
	});

	it("exposes run outputs and reused runs, and answers reuse-window lookups", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});
		const runner = await registerRunner(fixture, "devbox", 2);
		const requested = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{ token: fixture.qa.token, body: {} },
		);
		const claim = await fixture.call<{ run: ClaimedRun | null }>(
			"/runner-pools/claim",
			{ token: runner.workerToken, body: {} },
		);
		const claimed = claim.body.run;
		if (!claimed) throw new Error("Expected a claimed run");

		// Nothing to reuse yet.
		const before = await fixture.call<RecentOutputsResponse>(
			`/test-cases/${testCase.id}/outputs/recent?withinMs=3600000`,
			{ token: fixture.qa.token },
		);
		expect(before.body).toEqual({ runId: null, finishedAt: null, outputs: {} });

		const report = buildRunReport(claimed);
		const [first, second] = report.steps;
		if (!first || !second) throw new Error("Expected two steps");
		const withOutputs = {
			...report,
			steps: report.steps.map((step) =>
				step.stepId === first.stepId
					? { ...step, outputs: { applicationId: "APP-1", shared: "old" } }
					: step.stepId === second.stepId
						? {
								...step,
								outputs: { "registration.studentId": "S-9", shared: "new" },
							}
						: step,
			),
			reusedFromRunIds: ["run_prev"],
		};
		const finalized = await fixture.call<TestRunDetail>(
			`/test-runs/${claimed.runId}/finalize`,
			{
				token: claimed.runToken,
				body: { report: withOutputs, evidenceId: null },
			},
		);
		expect(finalized.status).toBe(200);
		expect(finalized.body.outputs).toEqual({
			applicationId: "APP-1",
			"registration.studentId": "S-9",
			shared: "new",
		});
		expect(finalized.body.reusedFromRunIds).toEqual(["run_prev"]);
		const detail = await fixture.call<TestRunDetail>(
			`/test-runs/${requested.body.runId}`,
			{ token: fixture.qa.token },
		);
		expect(detail.body.outputs).toEqual(finalized.body.outputs);
		expect(detail.body.reusedFromRunIds).toEqual(["run_prev"]);

		// The passed run now answers the window: by the user route and by the runner route.
		const recent = await fixture.call<RecentOutputsResponse>(
			`/test-cases/${testCase.id}/outputs/recent?withinMs=3600000`,
			{ token: fixture.qa.token },
		);
		expect(recent.body).toMatchObject({
			runId: claimed.runId,
			outputs: finalized.body.outputs,
		});
		expect(recent.body.finishedAt).toBeNumber();
		const otherParams = await fixture.call<RecentOutputsResponse>(
			`/test-cases/${testCase.id}/outputs/recent?withinMs=3600000&paramsHash=sha256:other`,
			{ token: fixture.qa.token },
		);
		expect(otherParams.body.runId).toBeNull();

		const next = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{ token: fixture.qa.token, body: { force: true } },
		);
		expect(next.status).toBe(201);
		const nextClaim = await fixture.call<{ run: ClaimedRun | null }>(
			"/runner-pools/claim",
			{ token: runner.workerToken, body: {} },
		);
		const runB = nextClaim.body.run;
		if (!runB) throw new Error("Expected the second run");
		const reuse = await fixture.call<RecentOutputsResponse>(
			`/test-runs/${runB.runId}/reuse?caseKey=${encodeURIComponent(testCase.key)}&paramsHash=${encodeURIComponent(emptyParamsHash)}&withinMs=3600000`,
			{ token: runB.runToken },
		);
		expect(reuse.status).toBe(200);
		expect(reuse.body.runId).toBe(claimed.runId);
		expect(reuse.body.outputs).toEqual(finalized.body.outputs ?? {});
		// A window that excludes the run, or a bad token, finds nothing.
		const expired = await fixture.call<RecentOutputsResponse>(
			`/test-runs/${runB.runId}/reuse?caseKey=${encodeURIComponent(testCase.key)}&paramsHash=${encodeURIComponent(emptyParamsHash)}&withinMs=1`,
			{ token: runB.runToken },
		);
		expect(expired.body.runId).toBeNull();
		const unauthenticated = await fixture.call(
			`/test-runs/${runB.runId}/reuse?caseKey=${encodeURIComponent(testCase.key)}&paramsHash=x&withinMs=1000`,
			{ token: "not-a-run-token" },
		);
		expect(unauthenticated.status).toBeGreaterThanOrEqual(401);
	});
});
