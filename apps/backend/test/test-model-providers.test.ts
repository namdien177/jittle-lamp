import { describe, expect, it } from "bun:test";
import {
	type ClaimedRun,
	type CreateTestRunResponse,
	defaultModelPrices,
	type ModelSettings,
	priceRunReport,
	type RunReport,
	type TestRunConfig,
	type TestRunDetail,
} from "@jittle-lamp/shared";
import { and, eq } from "drizzle-orm";

import {
	organizationActivityLogs,
	organizationModelSettings,
} from "../src/db/schema";
import {
	createTestCaseFixture,
	FAKE_MODEL_KEY,
	FAKE_PASSWORD,
} from "./test-case-fixtures";
import {
	buildRunReport,
	registerRunner,
	seedRunnableCase,
} from "./test-run-fixtures";

// Provider-neutral model settings (design.md §9.3, ADR 0002 amendment 2026-10-03): any AI SDK
// provider prefix the runner supports, an OpenAI-compatible base URL, and a separate judge key
// when the judge uses another provider.

const FAKE_JUDGE_KEY = "xai-fake-judge-key-9999";
type Fixture = Awaited<ReturnType<typeof createTestCaseFixture>>;
type ApiError = { error: { code: string; message: string } };

const putModel = (fixture: Fixture, body: Record<string, unknown>) =>
	fixture.call<ModelSettings & ApiError>("/test-model-settings", {
		method: "PUT",
		token: fixture.admin.token,
		body,
	});

// Queues a run of the seeded case and returns the config its runner receives.
const runConfig = async (fixture: Fixture, testCaseId: string) => {
	const requested = await fixture.call<CreateTestRunResponse>(
		`/test-cases/${testCaseId}/runs`,
		{ token: fixture.qa.token, body: { force: true } },
	);
	expect(requested.status).toBeLessThan(300);
	const runner = await registerRunner(fixture);
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
	return config.body;
};

describe("provider-neutral model settings", () => {
	it("defaults a new organisation to Qwen Flash through Gateway and supplies its own key and price to the runner", async () => {
		const fixture = await createTestCaseFixture();
		const initial = await fixture.call<ModelSettings>("/test-model-settings", {
			token: fixture.admin.token,
		});
		expect(initial.body).toMatchObject({
			actModel: "gateway/alibaba/qwen3.7-flash",
			judgeModel: "gateway/alibaba/qwen3.7-flash",
			provider: "gateway",
			keyConfigured: false,
			missing: ["key"],
		});
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});
		const saved = await putModel(fixture, {
			actModel: initial.body.actModel,
			judgeModel: initial.body.judgeModel,
			apiKey: FAKE_MODEL_KEY,
		});
		expect(saved.status).toBe(200);
		const config = await runConfig(fixture, testCase.id);
		expect(config.model).toEqual({
			act: "gateway/alibaba/qwen3.7-flash",
			judge: "gateway/alibaba/qwen3.7-flash",
			apiKeys: { AI_GATEWAY_API_KEY: FAKE_MODEL_KEY },
		});
		expect(config.prices).toContainEqual({
			modelId: "alibaba/qwen3.7-flash",
			inputUsdPerMtok: 0.03,
			cachedInputUsdPerMtok: 0.006,
			outputUsdPerMtok: 0.13,
		});
	});
	it("stores an OpenAI-compatible base URL and hands it to the runner as OPENAI_COMPATIBLE_BASE_URL", async () => {
		const fixture = await createTestCaseFixture({
			env: { JL_OUTBOUND_ALLOW_HOSTS: "vllm.internal" },
		});
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});

		const missing = await putModel(fixture, {
			actModel: "openai-compatible/llama-3.3-70b",
			judgeModel: "openai-compatible/llama-3.3-70b",
		});
		expect(missing.status).toBe(422);
		expect(missing.body.error.code).toBe("MODEL_BASE_URL_REQUIRED");

		const notHttp = await putModel(fixture, {
			actModel: "openai-compatible/llama-3.3-70b",
			judgeModel: "openai-compatible/llama-3.3-70b",
			baseUrl: "file:///etc/passwd",
		});
		expect(notHttp.status).toBe(422);

		// The backend calls this endpoint itself for Jira generation: private addresses are refused
		// unless JL_OUTBOUND_ALLOW_HOSTS names the host.
		for (const baseUrl of [
			"http://10.0.0.5:8000/v1",
			"http://169.254.169.254/v1",
			"http://127.0.0.1:11434/v1",
		]) {
			const blocked = await putModel(fixture, {
				actModel: "openai-compatible/llama-3.3-70b",
				judgeModel: "openai-compatible/llama-3.3-70b",
				baseUrl,
			});
			expect(blocked.status).toBe(422);
			expect(blocked.body.error.code).toBe("MODEL_BASE_URL_BLOCKED");
		}

		const saved = await putModel(fixture, {
			actModel: "openai-compatible/llama-3.3-70b",
			judgeModel: "openai-compatible/llama-3.3-70b",
			baseUrl: "http://vllm.internal:8000/v1",
		});
		expect(saved.status).toBe(200);
		expect(saved.body).toMatchObject({
			provider: "openai-compatible",
			baseUrl: "http://vllm.internal:8000/v1",
			keyConfigured: false,
			judgeKeyRequired: false,
			// The key is optional for a self-hosted server.
			missing: [],
		});

		// Omitted keeps the stored URL; a key can be added later.
		const withKey = await putModel(fixture, {
			actModel: "openai-compatible/llama-3.3-70b",
			judgeModel: "openai-compatible/llama-3.3-70b",
			apiKey: FAKE_MODEL_KEY,
		});
		expect(withKey.body).toMatchObject({
			baseUrl: "http://vllm.internal:8000/v1",
			keyConfigured: true,
			keyLast4: "0000",
		});

		const config = await runConfig(fixture, testCase.id);
		expect(config.model).toEqual({
			act: "openai-compatible/llama-3.3-70b",
			judge: "openai-compatible/llama-3.3-70b",
			apiKeys: {
				OPENAI_COMPATIBLE_API_KEY: FAKE_MODEL_KEY,
				OPENAI_COMPATIBLE_BASE_URL: "http://vllm.internal:8000/v1",
			},
		});

		// Switching away from openai-compatible drops the URL; switching back needs it again.
		const away = await putModel(fixture, {
			actModel: "openrouter/openai/gpt-5",
			judgeModel: "openrouter/openai/gpt-5",
		});
		expect(away.body.baseUrl).toBeNull();
		const back = await putModel(fixture, {
			actModel: "openrouter/openai/gpt-5",
			judgeModel: "openai-compatible/llama-3.3-70b",
		});
		expect(back.body.error.code).toBe("MODEL_BASE_URL_REQUIRED");
	});

	it("allows a loopback base URL only with JL_OUTBOUND_ALLOW_LOOPBACK", async () => {
		const fixture = await createTestCaseFixture({
			env: { JL_OUTBOUND_ALLOW_LOOPBACK: "true" },
		});
		const saved = await putModel(fixture, {
			actModel: "openai-compatible/qwen3",
			judgeModel: "openai-compatible/qwen3",
			baseUrl: "http://127.0.0.1:11434/v1",
		});
		expect(saved.status).toBe(200);
		expect(saved.body.baseUrl).toBe("http://127.0.0.1:11434/v1");
	});

	it("keeps a separate write-only judge key when the judge uses another provider", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});

		const saved = await putModel(fixture, {
			actModel: "openrouter/anthropic/claude-sonnet-5-5",
			judgeModel: "xai/grok-4",
			apiKey: FAKE_MODEL_KEY,
		});
		expect(saved.status).toBe(200);
		// Saving without the judge key is allowed; it is reported as missing.
		expect(saved.body).toMatchObject({
			provider: "openrouter",
			judgeProvider: "xai",
			keyConfigured: true,
			judgeKeyRequired: true,
			judgeKeyConfigured: false,
			missing: ["judgeKey"],
		});
		// The act key is never sent to the judge's provider.
		const withoutJudgeKey = await runConfig(fixture, testCase.id);
		expect(withoutJudgeKey.model?.apiKeys).toEqual({
			OPENROUTER_API_KEY: FAKE_MODEL_KEY,
		});

		const both = await putModel(fixture, {
			actModel: "openrouter/anthropic/claude-sonnet-5-5",
			judgeModel: "xai/grok-4",
			judgeApiKey: FAKE_JUDGE_KEY,
		});
		expect(both.body).toMatchObject({
			keyConfigured: true,
			keyLast4: "0000",
			judgeKeyConfigured: true,
			judgeKeyLast4: "9999",
			missing: [],
		});
		const raw = JSON.stringify(both.body);
		expect(raw).not.toContain(FAKE_MODEL_KEY);
		expect(raw).not.toContain(FAKE_JUDGE_KEY);
		// Both keys are internal credentials, not profiles.
		const credentials = await fixture.call<{ items: Array<{ kind: string }> }>(
			"/test-credentials",
			{ token: fixture.admin.token },
		);
		expect(
			credentials.body.items.filter((item) => item.kind === "model_key"),
		).toHaveLength(0);

		const activity = await fixture.db.query.organizationActivityLogs.findMany({
			where: and(
				eq(organizationActivityLogs.organizationId, fixture.orgId),
				eq(
					organizationActivityLogs.action,
					"test_config.model_settings_updated",
				),
			),
		});
		expect(
			activity.map((log) => JSON.parse(log.metadataJson).judgeKeyChanged),
		).toEqual([false, true]);
		expect(JSON.stringify(activity)).not.toContain(FAKE_JUDGE_KEY);
	});

	it("hands each provider only its own key in the run config", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});
		await putModel(fixture, {
			actModel: "openrouter/anthropic/claude-sonnet-5-5",
			judgeModel: "xai/grok-4",
			apiKey: FAKE_MODEL_KEY,
			judgeApiKey: FAKE_JUDGE_KEY,
		});
		const config = await runConfig(fixture, testCase.id);
		expect(config.model).toEqual({
			act: "openrouter/anthropic/claude-sonnet-5-5",
			judge: "xai/grok-4",
			apiKeys: {
				OPENROUTER_API_KEY: FAKE_MODEL_KEY,
				XAI_API_KEY: FAKE_JUDGE_KEY,
			},
		});

		// Moving the judge to the act provider removes the judge key.
		const same = await putModel(fixture, {
			actModel: "openrouter/anthropic/claude-sonnet-5-5",
			judgeModel: "openrouter/openai/gpt-5",
		});
		expect(same.body).toMatchObject({
			judgeKeyRequired: false,
			judgeKeyConfigured: false,
			missing: [],
		});
	});

	it("drops a stored key when its provider changes instead of sending it to another provider", async () => {
		const fixture = await createTestCaseFixture();
		await putModel(fixture, {
			actModel: "anthropic/claude-opus-5-5",
			judgeModel: "anthropic/claude-sonnet-5-5",
			apiKey: FAKE_MODEL_KEY,
		});
		const sameProvider = await putModel(fixture, {
			actModel: "anthropic/claude-sonnet-5-5",
			judgeModel: "anthropic/claude-sonnet-5-5",
		});
		expect(sameProvider.body.keyConfigured).toBe(true);
		const moved = await putModel(fixture, {
			actModel: "openai/gpt-5",
			judgeModel: "openai/gpt-5",
		});
		expect(moved.body).toMatchObject({
			provider: "openai",
			keyConfigured: false,
			keyLast4: null,
			missing: ["key"],
		});
	});

	it("rejects unknown provider prefixes at save time with the supported list", async () => {
		const fixture = await createTestCaseFixture();
		for (const actModel of ["mistral/large", "gpt-5", "openai/"]) {
			const response = await putModel(fixture, {
				actModel,
				judgeModel: "anthropic/claude-sonnet-5-5",
			});
			expect(response.status).toBe(422);
			expect(response.body.error.code).toBe("MODEL_PROVIDER_UNSUPPORTED");
			expect(response.body.error.message).toContain(
				"openrouter/, openai-compatible/, gateway/, openai/, anthropic/, google/, xai/",
			);
		}
		const judge = await putModel(fixture, {
			actModel: "anthropic/claude-sonnet-5-5",
			judgeModel: "bedrock/claude",
		});
		expect(judge.body.error.code).toBe("MODEL_PROVIDER_UNSUPPORTED");
		// Nothing was saved.
		const current = await fixture.call<ModelSettings>("/test-model-settings", {
			token: fixture.admin.token,
		});
		expect(current.body.actModel).toBe("gateway/alibaba/qwen3.7-flash");
		for (const accepted of [
			"google/gemini-2.5-pro",
			"gateway/openai/gpt-5",
			"mock:fixture.json",
		]) {
			const ok = await putModel(fixture, {
				actModel: accepted,
				judgeModel: accepted,
			});
			expect(ok.status).toBe(200);
		}
	});

	it("reads rows saved before the amendment: one key, no judge key and no base URL", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
			modelKey: FAKE_MODEL_KEY,
		});
		// Exactly what a pre-migration row holds: the new columns are null.
		const [row] = await fixture.db
			.select()
			.from(organizationModelSettings)
			.where(eq(organizationModelSettings.orgId, fixture.orgId));
		expect(row).toMatchObject({
			provider: "anthropic",
			judgeKeyCredentialId: null,
			judgeKeyLast4: null,
			baseUrl: null,
		});
		const settings = await fixture.call<ModelSettings>("/test-model-settings", {
			token: fixture.qa.token,
		});
		expect(settings.body).toMatchObject({
			keyConfigured: true,
			keyLast4: "0000",
			judgeKeyRequired: false,
			judgeKeyConfigured: false,
			judgeKeyLast4: null,
			baseUrl: null,
			missing: [],
		});
		const config = await runConfig(fixture, testCase.id);
		expect(config.model?.apiKeys).toEqual({
			ANTHROPIC_API_KEY: FAKE_MODEL_KEY,
		});

		// A legacy row whose judge used another provider: the single key stays with the act
		// provider and the judge key shows as missing (runs block with MODEL_KEY_MISSING).
		await fixture.db
			.update(organizationModelSettings)
			.set({ judgeModel: "openrouter/openai/gpt-5" })
			.where(eq(organizationModelSettings.orgId, fixture.orgId));
		const mixed = await fixture.call<ModelSettings>("/test-model-settings", {
			token: fixture.qa.token,
		});
		expect(mixed.body).toMatchObject({
			judgeKeyRequired: true,
			missing: ["judgeKey"],
		});
	});

	it("prices router ids like the vendor model unless the provider reported a cost", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
			modelKey: FAKE_MODEL_KEY,
		});
		const runner = await registerRunner(fixture);
		const claimNext = async () => {
			await fixture.call(`/test-cases/${testCase.id}/runs`, {
				token: fixture.qa.token,
				body: { force: true },
			});
			const claim = await fixture.call<{ run: ClaimedRun }>(
				"/runner-pools/claim",
				{ token: runner.workerToken, body: {} },
			);
			return claim.body.run;
		};
		// OpenRouter lists `claude-opus-5.5`; the price row is `anthropic/claude-opus-5-5`.
		const viaOpenRouter = (report: RunReport): RunReport =>
			JSON.parse(
				JSON.stringify(report).replace(
					/"anthropic\/(claude-[a-z]+)-5-5"/g,
					'"openrouter/anthropic/$1-5.5"',
				),
			) as RunReport;

		const first = await claimNext();
		const direct = buildRunReport(first);
		const pricedDirect = priceRunReport(direct, defaultModelPrices, "seed", {
			act: null,
			judge: null,
		});
		const expected =
			Math.round(
				((pricedDirect.totals.usage.costUsd ?? 0) +
					(pricedDirect.totals.judgeUsage.costUsd ?? 0)) *
					1e6,
			) / 1e6;
		expect(expected).toBeGreaterThan(0);
		const routed = viaOpenRouter(direct);
		expect(routed.totals.usage.modelId).toBe(
			"openrouter/anthropic/claude-opus-5.5",
		);
		const finalized = await fixture.call<TestRunDetail>(
			`/test-runs/${first.runId}/finalize`,
			{ token: first.runToken, body: { report: routed, evidenceId: null } },
		);
		expect(finalized.status).toBe(200);
		expect(finalized.body.metrics.costUsd).toBe(expected);
		expect(finalized.body.metrics.priceTableVersion).not.toBe("provider");

		// A cost OpenRouter reported is kept as is.
		const second = await claimNext();
		const reported = viaOpenRouter(
			buildRunReport(second, { providerCost: 0.5 }),
		);
		const kept = await fixture.call<TestRunDetail>(
			`/test-runs/${second.runId}/finalize`,
			{ token: second.runToken, body: { report: reported, evidenceId: null } },
		);
		expect(kept.body.metrics).toMatchObject({
			costUsd:
				(reported.totals.usage.costUsd ?? 0) +
				(reported.totals.judgeUsage.costUsd ?? 0),
			priceTableVersion: "provider",
		});
	});
});
