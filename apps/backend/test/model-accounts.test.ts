import { describe, expect, it } from "bun:test";
import type {
	ClaimedRun,
	CreateTestRunResponse,
	ModelAccount,
	ModelCostReport,
	ModelSettings,
	TestRunConfig,
	TestRunDetail,
} from "@jittle-lamp/shared";
import { createClient } from "@libsql/client";

import { eq } from "drizzle-orm";

import {
	organizationModelAccounts,
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

// Model accounts (design.md §9.3, ADR 0002 amendment 2026-10-13): several keys per provider in
// priority order, budgets, pauses and the runner's failover reports.

type Fixture = Awaited<ReturnType<typeof createTestCaseFixture>>;
type ApiError = { error: { code: string; message: string } };

const SECOND_KEY = "sk-ant-second-account-key-1111";
const THIRD_KEY = "sk-ant-third-account-key-2222";

const addAccount = async (fixture: Fixture, body: Record<string, unknown>) => {
	const response = await fixture.call<ModelAccount & ApiError>(
		"/test-model-accounts",
		{ token: fixture.admin.token, body },
	);
	if (response.status !== 201) throw new Error(JSON.stringify(response.body));
	return response.body;
};

const patchAccount = (
	fixture: Fixture,
	id: string,
	body: Record<string, unknown>,
) =>
	fixture.call<ModelAccount & ApiError>(`/test-model-accounts/${id}`, {
		method: "PATCH",
		token: fixture.admin.token,
		body,
	});

const listAccounts = async (fixture: Fixture) =>
	(
		await fixture.call<ModelAccount[]>("/test-model-accounts", {
			token: fixture.admin.token,
		})
	).body;

const requestRun = async (fixture: Fixture, testCaseId: string) => {
	const requested = await fixture.call<CreateTestRunResponse>(
		`/test-cases/${testCaseId}/runs`,
		{ token: fixture.qa.token, body: { force: true } },
	);
	expect(requested.status).toBeLessThan(300);
	return requested.body.runId;
};

const claimRun = async (fixture: Fixture, workerToken: string) => {
	const claim = await fixture.call<{ run: ClaimedRun | null }>(
		"/runner-pools/claim",
		{ token: workerToken, body: {} },
	);
	return claim.body.run;
};

const configOf = async (fixture: Fixture, claimed: ClaimedRun) => {
	const config = await fixture.call<TestRunConfig>(
		`/test-runs/${claimed.runId}/config`,
		{ token: claimed.runToken },
	);
	expect(config.status).toBe(200);
	return config.body;
};

describe("model accounts", () => {
	it("reads a key saved before accounts as the provider's first account, once", async () => {
		const fixture = await createTestCaseFixture();
		const account = await addAccount(fixture, {
			provider: "anthropic",
			label: "Temp",
			apiKey: FAKE_MODEL_KEY,
		});
		// What a row saved before model accounts holds: the key on the settings row.
		const [row] = await fixture.db
			.select()
			.from(organizationModelAccounts)
			.where(eq(organizationModelAccounts.id, account.id));
		await fixture.db
			.delete(organizationModelAccounts)
			.where(eq(organizationModelAccounts.id, account.id));
		await fixture.db.insert(organizationModelSettings).values({
			orgId: fixture.orgId,
			actModel: "anthropic/claude-opus-5-5",
			judgeModel: "anthropic/claude-sonnet-5-5",
			provider: "anthropic",
			keyCredentialId: row?.credentialId ?? null,
			keyLast4: "0000",
		});
		const migrated = await listAccounts(fixture);
		expect(migrated).toMatchObject([
			{ provider: "anthropic", label: "Default", keyLast4: "0000" },
		]);
		const [settings] = await fixture.db
			.select()
			.from(organizationModelSettings)
			.where(eq(organizationModelSettings.orgId, fixture.orgId));
		expect(settings?.keyCredentialId).toBeNull();
		// Deleting it does not bring the old key back.
		await fixture.call(`/test-model-accounts/${migrated[0]?.id}`, {
			method: "DELETE",
			token: fixture.admin.token,
		});
		expect(await listAccounts(fixture)).toEqual([]);
	});

	it("adds accounts per provider and never returns keys", async () => {
		const fixture = await createTestCaseFixture();
		await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
			modelKey: FAKE_MODEL_KEY,
		});
		const accounts = await listAccounts(fixture);
		expect(accounts).toHaveLength(1);
		expect(accounts[0]).toMatchObject({
			provider: "anthropic",
			label: "Default",
			keyConfigured: true,
			keyLast4: "0000",
			priority: 0,
			status: "active",
			usage: { todayUsd: 0, monthUsd: 0 },
		});

		const second = await addAccount(fixture, {
			provider: "anthropic",
			label: "Team B",
			apiKey: SECOND_KEY,
			dailyBudgetUsd: 5,
			monthlyBudgetUsd: 50,
			overBudget: "stop",
		});
		expect(second).toMatchObject({
			priority: 1,
			keyLast4: "1111",
			overBudget: "stop",
			dailyBudgetUsd: 5,
		});

		const raw = await createClient({ url: fixture.databaseUrl }).execute(
			"select * from test_credentials",
		);
		const credentials = JSON.stringify(
			(
				await fixture.call("/test-credentials", {
					token: fixture.admin.token,
				})
			).body,
		);
		const all = JSON.stringify([
			raw.rows,
			await listAccounts(fixture),
			credentials,
		]);
		expect(all).not.toContain(SECOND_KEY);
		expect(all).not.toContain(FAKE_MODEL_KEY);
		// Account keys are not credential profiles anyone can pick.
		expect(credentials).not.toContain("JL_MODEL_ACCOUNT_");
		expect(credentials).not.toContain("model_key");

		const denied = await fixture.call("/test-model-accounts", {
			token: fixture.qa.token,
			body: { provider: "anthropic", label: "QA", apiKey: THIRD_KEY },
		});
		expect(denied.status).toBe(403);

		const noKey = await fixture.call<ApiError>("/test-model-accounts", {
			token: fixture.admin.token,
			body: { provider: "anthropic", label: "Empty" },
		});
		expect(noKey.status).toBe(422);
		expect(noKey.body.error.code).toBe("MODEL_KEY_REQUIRED");
	});

	it("hands the runner every usable account in priority order and skips disabled, paused and over-budget ones", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
			modelKey: FAKE_MODEL_KEY,
		});
		const [first] = await listAccounts(fixture);
		if (!first) throw new Error("Expected the migrated account");
		const second = await addAccount(fixture, {
			provider: "anthropic",
			label: "Second",
			apiKey: SECOND_KEY,
		});
		const third = await addAccount(fixture, {
			provider: "anthropic",
			label: "Third",
			apiKey: THIRD_KEY,
			monthlyBudgetUsd: 10,
			overBudget: "stop",
		});

		// Third first, then Default; Second is paused.
		const reordered = await fixture.call<ModelAccount[]>(
			"/test-model-accounts/order",
			{
				method: "PUT",
				token: fixture.admin.token,
				body: { provider: "anthropic", ids: [third.id, first.id, second.id] },
			},
		);
		expect(reordered.status).toBe(200);
		const bad = await fixture.call<ApiError>("/test-model-accounts/order", {
			method: "PUT",
			token: fixture.admin.token,
			body: { provider: "anthropic", ids: [third.id] },
		});
		expect(bad.body.error.code).toBe("MODEL_ACCOUNT_ORDER_INVALID");
		const paused = await patchAccount(fixture, second.id, {
			pausedUntil: Date.now() + 3_600_000,
		});
		expect(paused.body.status).toBe("paused");

		await requestRun(fixture, testCase.id);
		const runner = await registerRunner(fixture);
		const claimed = await claimRun(fixture, runner.workerToken);
		if (!claimed) throw new Error("Expected a claimed run");
		const config = await configOf(fixture, claimed);
		expect(config.model?.accounts).toEqual([
			{
				id: third.id,
				provider: "anthropic",
				label: "Third",
				apiKey: THIRD_KEY,
				baseUrl: null,
				remainingUsd: 10,
				overBudget: "stop",
			},
			{
				id: first.id,
				provider: "anthropic",
				label: "Default",
				apiKey: FAKE_MODEL_KEY,
				baseUrl: null,
				remainingUsd: null,
				overBudget: "finish",
			},
		]);
		// Runners older than accounts get the first account.
		expect(config.model?.apiKeys).toEqual({ ANTHROPIC_API_KEY: THIRD_KEY });

		// The run hit a rate limit on Third and spent $12 on it: Third cools down and is over
		// its monthly budget; Default had a rejected key.
		const report = buildRunReport(claimed, { outcome: "passed" });
		const finalized = await fixture.call(
			`/test-runs/${claimed.runId}/finalize`,
			{
				token: claimed.runToken,
				body: {
					evidenceId: null,
					report: {
						...report,
						modelAccounts: {
							usage: [
								{
									accountId: third.id,
									modelId: "anthropic/claude-opus-5-5",
									calls: 3,
									inputTokens: 3000,
									cachedInputTokens: 0,
									outputTokens: 300,
									reasoningTokens: 0,
									costUsd: 12,
								},
							],
							events: [
								{
									accountId: third.id,
									kind: "rate_limited",
									at: new Date().toISOString(),
									retryAfterMs: 120_000,
									message: "429 Too Many Requests",
								},
								{
									accountId: first.id,
									kind: "auth_failed",
									at: new Date().toISOString(),
									retryAfterMs: null,
									message: "401 invalid x-api-key",
								},
							],
							stopped: false,
						},
					},
				},
			},
		);
		expect(finalized.status).toBe(200);
		const after = await listAccounts(fixture);
		const byId = new Map(after.map((account) => [account.id, account]));
		expect(byId.get(third.id)).toMatchObject({
			status: "over_budget",
			lastErrorCode: "rate_limited",
			usage: { todayUsd: 12, monthUsd: 12 },
		});
		expect(byId.get(third.id)?.cooldownUntil ?? 0).toBeGreaterThan(Date.now());
		expect(byId.get(first.id)).toMatchObject({
			status: "auth_error",
			lastErrorCode: "auth_failed",
		});

		// Default (key error) still serves, but after nothing better is left; Third is out.
		await requestRun(fixture, testCase.id);
		const next = await claimRun(fixture, runner.workerToken);
		if (!next) throw new Error("Expected a second claimed run");
		const nextConfig = await configOf(fixture, next);
		expect(nextConfig.model?.accounts.map((account) => account.id)).toEqual([
			first.id,
		]);

		const cleared = await patchAccount(fixture, first.id, {
			clearCooldown: true,
		});
		expect(cleared.body).toMatchObject({
			status: "active",
			lastErrorCode: null,
			cooldownUntil: null,
		});

		const costs = await fixture.call<ModelCostReport>("/test-model-costs", {
			token: fixture.admin.token,
		});
		expect(costs.body.byAccount).toEqual([
			{
				accountId: third.id,
				label: "Third",
				provider: "anthropic",
				keyLast4: "2222",
				costUsd: 12,
				calls: 3,
				tokens: 3300,
			},
		]);
		expect(costs.body.byDayAccount).toHaveLength(1);
	});

	it("queues runs as BUDGET_EXCEEDED while every account of a needed provider is over budget", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
			modelKey: FAKE_MODEL_KEY,
		});
		const [only] = await listAccounts(fixture);
		if (!only) throw new Error("Expected the migrated account");
		await patchAccount(fixture, only.id, { dailyBudgetUsd: 1 });

		await requestRun(fixture, testCase.id);
		const runner = await registerRunner(fixture);
		const claimed = await claimRun(fixture, runner.workerToken);
		if (!claimed) throw new Error("Expected a claimed run");
		await fixture.call(`/test-runs/${claimed.runId}/finalize`, {
			token: claimed.runToken,
			body: {
				evidenceId: null,
				report: {
					...buildRunReport(claimed, { outcome: "passed" }),
					modelAccounts: {
						usage: [
							{
								accountId: only.id,
								modelId: "anthropic/claude-opus-5-5",
								calls: 1,
								inputTokens: 10,
								cachedInputTokens: 0,
								outputTokens: 10,
								reasoningTokens: 0,
								costUsd: 2,
							},
						],
						events: [],
						stopped: false,
					},
				},
			},
		});

		const held = await requestRun(fixture, testCase.id);
		const detail = await fixture.call<TestRunDetail>(`/test-runs/${held}`, {
			token: fixture.qa.token,
		});
		expect(detail.body.blockedReason).toBe("BUDGET_EXCEEDED");
		expect(await claimRun(fixture, runner.workerToken)).toBeNull();

		// Raising the budget releases the queued run.
		await patchAccount(fixture, only.id, { dailyBudgetUsd: 10 });
		const released = await fixture.call<TestRunDetail>(`/test-runs/${held}`, {
			token: fixture.qa.token,
		});
		expect(released.body.blockedReason).toBeNull();

		const settings = await fixture.call<ModelSettings>("/test-model-settings", {
			token: fixture.admin.token,
		});
		expect(settings.body.keyConfigured).toBe(true);
	});

	it("deletes an account with its key", async () => {
		const fixture = await createTestCaseFixture();
		const account = await addAccount(fixture, {
			provider: "openrouter",
			label: "Router",
			apiKey: SECOND_KEY,
		});
		const removed = await fixture.call(`/test-model-accounts/${account.id}`, {
			method: "DELETE",
			token: fixture.admin.token,
		});
		expect(removed.status).toBe(200);
		expect(await listAccounts(fixture)).toEqual([]);
		const missing = await patchAccount(fixture, account.id, { label: "x" });
		expect(missing.status).toBe(404);
	});
});
