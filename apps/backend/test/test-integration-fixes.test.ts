import { describe, expect, it } from "bun:test";
import type {
	ClaimedRun,
	CreateTestRunResponse,
	ModelPriceRow,
	TestRunDetail,
} from "@jittle-lamp/shared";

import { createTestCaseFixture, FAKE_PASSWORD } from "./test-case-fixtures";
import {
	buildEvidenceZip,
	buildRunReport,
	registerRunner,
	seedRunnableCase,
} from "./test-run-fixtures";

const runWithEvidence = async (
	fixture: Awaited<ReturnType<typeof createTestCaseFixture>>,
) => {
	const { testCase } = await seedRunnableCase(fixture, {
		password: FAKE_PASSWORD,
	});
	const runner = await registerRunner(fixture);
	await fixture.call(`/test-cases/${testCase.id}/runs`, {
		token: fixture.qa.token,
		body: {},
	});
	const claim = await fixture.call<{ run: ClaimedRun }>("/runner-pools/claim", {
		token: runner.workerToken,
		body: {},
	});
	const report = buildRunReport(claim.body.run);
	const upload = await fixture.call<{ evidenceId: string }>(
		`/test-runs/${claim.body.run.runId}/evidence`,
		{
			method: "POST",
			token: claim.body.run.runToken,
			raw: buildEvidenceZip(report),
			headers: { "content-type": "application/zip" },
		},
	);
	return {
		testCase,
		runner,
		claimed: claim.body.run,
		report,
		evidenceId: upload.body.evidenceId,
	};
};

describe("integration fixes for web, desktop and MCP clients", () => {
	it("plays run evidence from in-memory storage through dev-artifact URLs in dev auth", async () => {
		const fixture = await createTestCaseFixture({
			env: { JITTLE_LAMP_DEV_AUTH_ENABLED: "true" },
		});
		const { evidenceId } = await runWithEvidence(fixture);
		const playback = await fixture.call<{
			recording: { readUrl: string } | null;
			archive: { readUrl: string } | null;
		}>(`/evidences/${evidenceId}/playback`, { token: fixture.qa.token });
		expect(playback.status).toBe(200);
		const serialized = JSON.stringify(playback.body);
		const urls = [
			...serialized.matchAll(
				/http:\/\/127\.0\.0\.1:3001\/dev\/artifacts\/[^"]+/g,
			),
		].map((match) => match[0]);
		expect(urls.length).toBeGreaterThanOrEqual(2);
		for (const url of urls) {
			const response = await fixture.app.handle(
				new Request(`http://localhost${new URL(url).pathname}`),
			);
			expect(response.status).toBe(200);
		}
		const artifacts = await fixture.call<{
			artifacts: Array<{ id: string; kind: string }>;
		}>(`/evidences/${evidenceId}/artifacts`, { token: fixture.qa.token });
		const recording = artifacts.body.artifacts.find(
			(artifact) => artifact.kind === "recording",
		);
		const readUrl = await fixture.call<{ url: string }>(
			`/evidences/${evidenceId}/artifacts/${recording?.id}/read-url`,
			{ token: fixture.qa.token },
		);
		expect(readUrl.status).toBe(200);
		expect(JSON.stringify(readUrl.body)).toContain("/dev/artifacts/");
	});

	it("keeps playback unavailable on memory storage without dev auth", async () => {
		const fixture = await createTestCaseFixture();
		const { evidenceId } = await runWithEvidence(fixture);
		const playback = await fixture.call(`/evidences/${evidenceId}/playback`, {
			token: fixture.qa.token,
		});
		expect(playback.status).toBe(503);
		expect(playback.body).toMatchObject({
			error: { code: "ARTIFACT_STORAGE_NOT_CONFIGURED" },
		});
	});

	it("reports a 0-based queue position with the pool's queue depth", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});
		const first = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{ token: fixture.qa.token, body: { params: { n: "1" } } },
		);
		const second = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${testCase.id}/runs`,
			{ token: fixture.qa.token, body: { params: { n: "2" } } },
		);
		expect(first.body).toMatchObject({ queuePosition: 0, queueDepth: 1 });
		expect(second.body).toMatchObject({ queuePosition: 1, queueDepth: 2 });
		const detail = await fixture.call<TestRunDetail>(
			`/test-runs/${first.body.runId}`,
			{
				token: fixture.qa.token,
			},
		);
		expect(detail.body).toMatchObject({ queuePosition: 0, queueDepth: 2 });
		const list = await fixture.call<{ items: Array<{ id: string }> }>(
			`/test-runs?status=queued&testCaseId=${testCase.id}&limit=1`,
			{ token: fixture.qa.token },
		);
		expect(list.body.items).toHaveLength(1);
	});

	it("lets organisations override model prices used for run cost", async () => {
		const fixture = await createTestCaseFixture();
		const defaults = await fixture.call<ModelPriceRow[]>("/model-prices", {
			token: fixture.admin.token,
		});
		expect(defaults.status).toBe(200);
		expect(
			defaults.body.find(
				(price) => price.modelId === "anthropic/claude-opus-5-5",
			),
		).toEqual({
			modelId: "anthropic/claude-opus-5-5",
			inputUsdPerMtok: 4,
			cachedInputUsdPerMtok: 0.2,
			outputUsdPerMtok: 20,
			source: "default",
		});
		const denied = await fixture.call("/model-prices", {
			method: "PUT",
			token: fixture.qa.token,
			body: [],
		});
		expect(denied.status).toBe(403);
		const override = await fixture.call<ModelPriceRow[]>("/model-prices", {
			method: "PUT",
			token: fixture.admin.token,
			body: [
				{
					modelId: "anthropic/claude-opus-5-5",
					inputUsdPerMtok: 10,
					cachedInputUsdPerMtok: 1,
					outputUsdPerMtok: 50,
				},
				{
					modelId: "openrouter/acme/model-x",
					inputUsdPerMtok: 1,
					cachedInputUsdPerMtok: 0,
					outputUsdPerMtok: 2,
				},
			],
		});
		expect(override.status).toBe(200);
		expect(
			override.body.find(
				(price) => price.modelId === "anthropic/claude-opus-5-5",
			)?.inputUsdPerMtok,
		).toBe(10);
		expect(
			override.body.some(
				(price) => price.modelId === "openrouter/acme/model-x",
			),
		).toBe(true);
		// Each row says whether it is the organisation's own or a global default.
		const sources = Object.fromEntries(
			override.body.map((price) => [price.modelId, price.source]),
		);
		expect(sources).toMatchObject({
			"anthropic/claude-opus-5-5": "organization",
			"openrouter/acme/model-x": "organization",
			"anthropic/claude-sonnet-5-5": "default",
		});

		const { claimed, report } = await runWithEvidence(fixture);
		const finalized = await fixture.call<TestRunDetail>(
			`/test-runs/${claimed.runId}/finalize`,
			{ token: claimed.runToken, body: { report, evidenceId: null } },
		);
		expect(finalized.body.metrics.costUsd).toBe(0.02);

		const cleared = await fixture.call<ModelPriceRow[]>("/model-prices", {
			method: "PUT",
			token: fixture.admin.token,
			body: [],
		});
		expect(
			cleared.body.find(
				(price) => price.modelId === "anthropic/claude-opus-5-5",
			),
		).toMatchObject({ inputUsdPerMtok: 4, source: "default" });
	});

	it("accepts q as the title for similar-case search", async () => {
		const fixture = await createTestCaseFixture();
		await fixture.call("/test-cases", {
			token: fixture.qa.token,
			body: {
				transcript: "# Parent portal shows invoices\n\n[Open] /invoices",
			},
		});
		const similar = await fixture.call<{ items: Array<{ title: string }> }>(
			`/test-cases/similar?q=${encodeURIComponent("parent portal shows the invoices")}`,
			{ token: fixture.qa.token },
		);
		expect(similar.body.items.map((item) => item.title)).toEqual([
			"Parent portal shows invoices",
		]);
	});
});
