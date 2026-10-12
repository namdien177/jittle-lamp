import {
	type CreateModelAccountRequest,
	findModelProvider,
	type ModelAccount,
	type ModelAccountEvent,
	type ModelProvider,
	modelAccountOverBudgetNow,
	modelAccountRemainingUsd,
	modelAccountStatus,
	modelProviders,
	type RunModelAccount,
	type RunModelAccountsReport,
	type UpdateModelAccountRequest,
} from "@jittle-lamp/shared";
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import {
	organizationModelAccounts,
	organizationModelSettings,
	testCredentials,
	testRunModelUsage,
} from "../db/schema";
import { createUuidV7 } from "../db/uuid";
import { HttpError, notFound } from "../http/test-http";
import {
	assertOutboundUrl,
	defaultOutboundPolicy,
	OutboundBlockedError,
	type OutboundPolicy,
} from "./outbound-http";
import type { TestSecrets } from "./test-config";
import { budgetDayStart } from "./test-run-budget";
import { credentialSubject, saveCredential } from "./test-settings";
import type { BackendDb } from "./user-provisioning";

// Model accounts (design.md §9.3, ADR 0002 amendment 2026-10-13): several keys per provider with
// a priority, daily and monthly budgets, an on/off switch and a pause. A run gets the usable
// accounts of its providers in priority order and the runner fails over between them; its
// report brings back per-account usage (test_run_model_usage) and the failures that set a
// cooldown here.

export type ModelAccountRow = typeof organizationModelAccounts.$inferSelect;

// Each account's key is a `model_key` credential with its own profile; credential lists hide it.
export const MODEL_ACCOUNT_PROFILE_PREFIX = "JL_MODEL_ACCOUNT_";
const accountProfile = (id: string) =>
	`${MODEL_ACCOUNT_PROFILE_PREFIX}${id.replace(/-/g, "_").toUpperCase()}`;

// How long the runner's failures keep an account at the back of the queue.
const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;
const QUOTA_COOLDOWN_MS = 60 * 60_000;
const AUTH_COOLDOWN_MS = 60 * 60_000;

export const budgetMonthStart = (now: number): number => {
	const date = new Date(now);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

const unprocessable = (code: string, message: string) =>
	new HttpError(422, code, message);

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

// Providers an account can be added for: every one that takes a key or an endpoint.
export const accountProviders = (): ModelProvider[] =>
	modelProviders.filter(
		(provider) =>
			!provider.development && (provider.keyEnv || provider.baseUrlEnv),
	);

const providerByPrefix = (prefix: string): ModelProvider | null =>
	modelProviders.find((provider) => provider.prefix === prefix) ?? null;

// Providers the act and judge models need an account for.
export const providersForModels = (
	modelIds: readonly string[],
): ModelProvider[] => {
	const seen = new Map<string, ModelProvider>();
	for (const id of modelIds) {
		const provider = findModelProvider(id);
		if (provider && (provider.keyEnv || provider.baseUrlEnv)) {
			seen.set(provider.prefix, provider);
		}
	}
	return [...seen.values()];
};

// ---------------------------------------------------------------------------------------------
// Keys saved before model accounts
// ---------------------------------------------------------------------------------------------

// The single act key, judge key and base URL of organization_model_settings become the first
// accounts of their providers the first time anything reads the organisation's accounts. The old
// columns are cleared so a deleted account is never brought back.
export const migrateLegacyModelKeys = async (
	db: BackendDb,
	orgId: string,
): Promise<void> => {
	const row = await db.query.organizationModelSettings.findFirst({
		where: eq(organizationModelSettings.orgId, orgId),
	});
	if (!row) return;
	if (!row.keyCredentialId && !row.judgeKeyCredentialId && !row.baseUrl) {
		return;
	}
	const now = Date.now();
	const existing = await db.query.organizationModelAccounts.findMany({
		where: eq(organizationModelAccounts.orgId, orgId),
		columns: { provider: true, priority: true },
	});
	const nextPriority = (provider: string) =>
		existing
			.filter((account) => account.provider === provider)
			.reduce((max, account) => Math.max(max, account.priority + 1), 0);
	const add = async (input: {
		provider: string;
		label: string;
		credentialId: string | null;
		keyLast4: string | null;
		baseUrl: string | null;
	}) => {
		const priority = nextPriority(input.provider);
		await db.insert(organizationModelAccounts).values({
			orgId,
			...input,
			priority,
			updatedBy: row.updatedBy,
			createdAt: now,
			updatedAt: now,
		});
		existing.push({ provider: input.provider, priority });
	};
	const judgeProvider = findModelProvider(row.judgeModel)?.prefix ?? null;
	let baseUrlUsed = false;
	if (row.keyCredentialId) {
		const isCompatible = row.provider === "openai-compatible";
		baseUrlUsed ||= isCompatible && Boolean(row.baseUrl);
		await add({
			provider: row.provider,
			label: "Default",
			credentialId: row.keyCredentialId,
			keyLast4: row.keyLast4,
			baseUrl: isCompatible ? row.baseUrl : null,
		});
	}
	if (row.judgeKeyCredentialId && judgeProvider) {
		const isCompatible = judgeProvider === "openai-compatible";
		baseUrlUsed ||= isCompatible && Boolean(row.baseUrl);
		await add({
			provider: judgeProvider,
			label: "Judge",
			credentialId: row.judgeKeyCredentialId,
			keyLast4: row.judgeKeyLast4,
			baseUrl: isCompatible ? row.baseUrl : null,
		});
	}
	if (row.baseUrl && !baseUrlUsed) {
		await add({
			provider: "openai-compatible",
			label: "Default",
			credentialId: null,
			keyLast4: null,
			baseUrl: row.baseUrl,
		});
	}
	await db
		.update(organizationModelSettings)
		.set({
			keyCredentialId: null,
			keyLast4: null,
			judgeKeyCredentialId: null,
			judgeKeyLast4: null,
			baseUrl: null,
		})
		.where(eq(organizationModelSettings.orgId, orgId));
};

// ---------------------------------------------------------------------------------------------
// Reading accounts
// ---------------------------------------------------------------------------------------------

export type AccountSpend = { todayUsd: number; monthUsd: number };

// Spend of finished runs per account in the current UTC day and month.
export const accountSpend = async (
	db: BackendDb,
	orgId: string,
	now = Date.now(),
): Promise<Map<string, AccountSpend>> => {
	const dayStart = budgetDayStart(now);
	const rows = await db
		.select({
			accountId: testRunModelUsage.accountId,
			todayUsd: sql<number>`coalesce(sum(case when ${testRunModelUsage.finishedAt} >= ${dayStart} then ${testRunModelUsage.costUsd} else 0 end), 0)`,
			monthUsd: sql<number>`coalesce(sum(${testRunModelUsage.costUsd}), 0)`,
		})
		.from(testRunModelUsage)
		.where(
			and(
				eq(testRunModelUsage.orgId, orgId),
				gte(testRunModelUsage.finishedAt, budgetMonthStart(now)),
			),
		)
		.groupBy(testRunModelUsage.accountId);
	const spend = new Map<string, AccountSpend>();
	for (const row of rows) {
		if (!row.accountId) continue;
		spend.set(row.accountId, {
			todayUsd: round(Number(row.todayUsd)),
			monthUsd: round(Number(row.monthUsd)),
		});
	}
	return spend;
};

export const toModelAccount = (
	row: ModelAccountRow,
	spend: AccountSpend | undefined,
	now: number,
): ModelAccount => {
	const account = {
		id: row.id,
		provider: row.provider,
		label: row.label,
		keyConfigured: Boolean(row.credentialId),
		keyLast4: row.credentialId ? row.keyLast4 : null,
		baseUrl: row.baseUrl,
		priority: row.priority,
		enabled: row.enabled,
		pausedUntil: row.pausedUntil,
		dailyBudgetUsd: row.dailyBudgetUsd,
		monthlyBudgetUsd: row.monthlyBudgetUsd,
		overBudget: row.overBudget,
		cooldownUntil: row.cooldownUntil,
		lastErrorCode: (row.lastErrorCode ?? null) as ModelAccount["lastErrorCode"],
		lastErrorMessage: row.lastErrorMessage,
		lastErrorAt: row.lastErrorAt,
		lastUsedAt: row.lastUsedAt,
		usage: spend ?? { todayUsd: 0, monthUsd: 0 },
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
	return { ...account, status: modelAccountStatus(account, now) };
};

const accountRows = async (db: BackendDb, orgId: string) => {
	await migrateLegacyModelKeys(db, orgId);
	return db.query.organizationModelAccounts.findMany({
		where: eq(organizationModelAccounts.orgId, orgId),
		orderBy: [
			asc(organizationModelAccounts.provider),
			asc(organizationModelAccounts.priority),
			asc(organizationModelAccounts.createdAt),
		],
	});
};

export const listModelAccounts = async (
	db: BackendDb,
	orgId: string,
	now = Date.now(),
): Promise<ModelAccount[]> => {
	const rows = await accountRows(db, orgId);
	const spend = await accountSpend(db, orgId, now);
	return rows.map((row) => toModelAccount(row, spend.get(row.id), now));
};

const getAccountRow = async (
	db: BackendDb,
	orgId: string,
	id: string,
): Promise<ModelAccountRow> => {
	const row = await db.query.organizationModelAccounts.findFirst({
		where: and(
			eq(organizationModelAccounts.orgId, orgId),
			eq(organizationModelAccounts.id, id),
		),
	});
	if (!row) {
		throw notFound("MODEL_ACCOUNT_NOT_FOUND", "Model account not found");
	}
	return row;
};

export const getModelAccount = async (
	db: BackendDb,
	orgId: string,
	id: string,
	now = Date.now(),
): Promise<ModelAccount> => {
	const row = await getAccountRow(db, orgId, id);
	const spend = await accountSpend(db, orgId, now);
	return toModelAccount(row, spend.get(row.id), now);
};

// ---------------------------------------------------------------------------------------------
// Writing accounts
// ---------------------------------------------------------------------------------------------

export const assertModelBaseUrl = async (
	baseUrl: string,
	outbound: OutboundPolicy,
): Promise<void> => {
	if (!/^https?:\/\//i.test(baseUrl)) {
		throw unprocessable(
			"MODEL_BASE_URL_INVALID",
			"The base URL must be an http(s) URL.",
		);
	}
	// The backend calls this endpoint itself for Jira import generation, so it gets the same SSRF
	// check as webhook callbacks (JL_OUTBOUND_ALLOW_HOSTS admits an internal server).
	try {
		await assertOutboundUrl(outbound, baseUrl);
	} catch (error) {
		if (!(error instanceof OutboundBlockedError)) throw error;
		throw unprocessable(
			"MODEL_BASE_URL_BLOCKED",
			`The base URL is not allowed: ${error.message}.`,
		);
	}
};

const storeAccountKey = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: {
		orgId: string;
		userId: string;
		accountId: string;
		credentialId: string | null;
		apiKey: string;
	},
): Promise<string> => {
	const credential = await saveCredential(db, secrets, {
		orgId: input.orgId,
		userId: input.userId,
		...(input.credentialId ? { id: input.credentialId } : {}),
		request: {
			profile: accountProfile(input.accountId),
			kind: "model_key",
			environmentId: null,
			fields: {},
			secretFields: { api_key: input.apiKey },
		},
		replaceSecrets: true,
		reason: "model_key.update",
	});
	return credential.id;
};

const removeAccountKey = async (
	db: BackendDb,
	credentialId: string,
	userId: string,
) => {
	await db
		.update(testCredentials)
		.set({ deletedAt: Date.now(), deletedBy: userId })
		.where(eq(testCredentials.id, credentialId));
};

export const createModelAccount = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: {
		orgId: string;
		userId: string;
		request: CreateModelAccountRequest;
		outbound?: OutboundPolicy;
		now?: number;
	},
): Promise<ModelAccount> => {
	const { request } = input;
	const now = input.now ?? Date.now();
	const provider = providerByPrefix(request.provider);
	if (
		!provider ||
		provider.development ||
		(!provider.keyEnv && !provider.baseUrlEnv)
	) {
		throw unprocessable(
			"MODEL_PROVIDER_UNSUPPORTED",
			`Model accounts are for ${accountProviders()
				.map((entry) => entry.prefix)
				.join(", ")}.`,
		);
	}
	const apiKey = provider.keyEnv ? (request.apiKey ?? null) : null;
	if (provider.keyRequired && !apiKey) {
		throw unprocessable("MODEL_KEY_REQUIRED", `${provider.label} needs a key.`);
	}
	const baseUrl = provider.baseUrlEnv ? (request.baseUrl ?? null) : null;
	if (provider.baseUrlEnv && !baseUrl) {
		throw unprocessable(
			"MODEL_BASE_URL_REQUIRED",
			"openai-compatible/ accounts need the base URL of the endpoint, e.g. https://api.groq.com/openai/v1.",
		);
	}
	if (baseUrl)
		await assertModelBaseUrl(baseUrl, input.outbound ?? defaultOutboundPolicy);
	await migrateLegacyModelKeys(db, input.orgId);
	const siblings = await db.query.organizationModelAccounts.findMany({
		where: and(
			eq(organizationModelAccounts.orgId, input.orgId),
			eq(organizationModelAccounts.provider, provider.prefix),
		),
		columns: { priority: true },
	});
	const id = createUuidV7();
	const credentialId = apiKey
		? await storeAccountKey(db, secrets, {
				orgId: input.orgId,
				userId: input.userId,
				accountId: id,
				credentialId: null,
				apiKey,
			})
		: null;
	await db.insert(organizationModelAccounts).values({
		id,
		orgId: input.orgId,
		provider: provider.prefix,
		label: request.label,
		credentialId,
		keyLast4: apiKey ? apiKey.slice(-4) : null,
		baseUrl,
		priority: siblings.reduce(
			(max, sibling) => Math.max(max, sibling.priority + 1),
			0,
		),
		enabled: request.enabled,
		dailyBudgetUsd: request.dailyBudgetUsd ?? null,
		monthlyBudgetUsd: request.monthlyBudgetUsd ?? null,
		overBudget: request.overBudget,
		createdBy: input.userId,
		updatedBy: input.userId,
		createdAt: now,
		updatedAt: now,
	});
	return getModelAccount(db, input.orgId, id, now);
};

export const updateModelAccount = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: {
		orgId: string;
		userId: string;
		id: string;
		request: UpdateModelAccountRequest;
		outbound?: OutboundPolicy;
		now?: number;
	},
): Promise<{ account: ModelAccount; keyChanged: boolean }> => {
	const { request } = input;
	const now = input.now ?? Date.now();
	const row = await getAccountRow(db, input.orgId, input.id);
	const provider = providerByPrefix(row.provider);
	const values: Partial<typeof organizationModelAccounts.$inferInsert> = {
		updatedBy: input.userId,
		updatedAt: now,
	};
	if (request.label !== undefined) values.label = request.label;
	if (request.enabled !== undefined) values.enabled = request.enabled;
	if (request.pausedUntil !== undefined) {
		values.pausedUntil =
			request.pausedUntil !== null && request.pausedUntil > now
				? request.pausedUntil
				: null;
	}
	if (request.dailyBudgetUsd !== undefined) {
		values.dailyBudgetUsd = request.dailyBudgetUsd;
	}
	if (request.monthlyBudgetUsd !== undefined) {
		values.monthlyBudgetUsd = request.monthlyBudgetUsd;
	}
	if (request.overBudget !== undefined) values.overBudget = request.overBudget;
	if (request.clearCooldown) {
		values.cooldownUntil = null;
		values.lastErrorCode = null;
		values.lastErrorMessage = null;
		values.lastErrorAt = null;
	}
	if (request.baseUrl !== undefined && provider?.baseUrlEnv) {
		if (!request.baseUrl) {
			throw unprocessable(
				"MODEL_BASE_URL_REQUIRED",
				"openai-compatible/ accounts need the base URL of the endpoint.",
			);
		}
		await assertModelBaseUrl(
			request.baseUrl,
			input.outbound ?? defaultOutboundPolicy,
		);
		values.baseUrl = request.baseUrl;
	}
	let keyChanged = false;
	if (typeof request.apiKey === "string" && provider?.keyEnv) {
		values.credentialId = await storeAccountKey(db, secrets, {
			orgId: input.orgId,
			userId: input.userId,
			accountId: row.id,
			credentialId: row.credentialId,
			apiKey: request.apiKey,
		});
		values.keyLast4 = request.apiKey.slice(-4);
		// A new key starts without the old key's errors.
		if (row.lastErrorCode === "auth_failed") {
			values.cooldownUntil = null;
			values.lastErrorCode = null;
			values.lastErrorMessage = null;
			values.lastErrorAt = null;
		}
		keyChanged = true;
	} else if (request.apiKey === null && row.credentialId) {
		if (provider?.keyRequired) {
			throw unprocessable(
				"MODEL_KEY_REQUIRED",
				`${provider.label} accounts need a key; delete the account instead.`,
			);
		}
		await removeAccountKey(db, row.credentialId, input.userId);
		values.credentialId = null;
		values.keyLast4 = null;
		keyChanged = true;
	}
	await db
		.update(organizationModelAccounts)
		.set(values)
		.where(eq(organizationModelAccounts.id, row.id));
	return {
		account: await getModelAccount(db, input.orgId, row.id, now),
		keyChanged,
	};
};

export const deleteModelAccount = async (
	db: BackendDb,
	input: { orgId: string; userId: string; id: string },
): Promise<ModelAccountRow> => {
	const row = await getAccountRow(db, input.orgId, input.id);
	if (row.credentialId) {
		await removeAccountKey(db, row.credentialId, input.userId);
	}
	await db
		.delete(organizationModelAccounts)
		.where(eq(organizationModelAccounts.id, row.id));
	return row;
};

export const reorderModelAccounts = async (
	db: BackendDb,
	input: { orgId: string; userId: string; provider: string; ids: string[] },
): Promise<void> => {
	const rows = await db.query.organizationModelAccounts.findMany({
		where: and(
			eq(organizationModelAccounts.orgId, input.orgId),
			eq(organizationModelAccounts.provider, input.provider),
		),
		columns: { id: true },
	});
	const known = new Set(rows.map((row) => row.id));
	if (
		new Set(input.ids).size !== input.ids.length ||
		input.ids.length !== known.size ||
		input.ids.some((id) => !known.has(id))
	) {
		throw unprocessable(
			"MODEL_ACCOUNT_ORDER_INVALID",
			`List every ${input.provider} account exactly once.`,
		);
	}
	const now = Date.now();
	for (const [priority, id] of input.ids.entries()) {
		await db
			.update(organizationModelAccounts)
			.set({ priority, updatedBy: input.userId, updatedAt: now })
			.where(eq(organizationModelAccounts.id, id));
	}
};

// ---------------------------------------------------------------------------------------------
// Run selection
// ---------------------------------------------------------------------------------------------

// Whether an account can serve a run at all: switched on, not paused, under budget, and holding
// the key its provider needs. A cooldown only moves it to the back.
const usable = (account: ModelAccount, now: number) => {
	const provider = providerByPrefix(account.provider);
	if (provider?.keyRequired && !account.keyConfigured) return false;
	if (provider?.baseUrlEnv && !account.baseUrl) return false;
	const status = modelAccountStatus(account, now);
	return (
		status !== "disabled" && status !== "paused" && status !== "over_budget"
	);
};

const cooling = (account: ModelAccount, now: number) =>
	account.cooldownUntil !== null && account.cooldownUntil > now;

// The accounts a provider can use now, in the order the runner should try them.
export const orderedUsableAccounts = (
	accounts: readonly ModelAccount[],
	provider: string,
	now: number,
): ModelAccount[] => {
	const candidates = accounts.filter(
		(account) => account.provider === provider && usable(account, now),
	);
	return [
		...candidates.filter((account) => !cooling(account, now)),
		...candidates
			.filter((account) => cooling(account, now))
			.sort((a, b) => (a.cooldownUntil ?? 0) - (b.cooldownUntil ?? 0)),
	];
};

export type ModelAccountAvailability = "ok" | "over_budget";

// Blocks a run only when budgets are the reason no account is left: every account of a needed
// provider that is switched on and not paused is over budget. A provider without accounts, or
// with only disabled or paused ones, is left to the runner, which blocks with MODEL_KEY_MISSING.
export const modelAccountAvailability = async (
	db: BackendDb,
	orgId: string,
	modelIds: readonly string[],
	now = Date.now(),
): Promise<ModelAccountAvailability> => {
	const accounts = await listModelAccounts(db, orgId, now);
	for (const provider of providersForModels(modelIds)) {
		const own = accounts.filter(
			(account) => account.provider === provider.prefix,
		);
		if (orderedUsableAccounts(own, provider.prefix, now).length > 0) continue;
		const overBudget = own.some(
			(account) =>
				account.enabled &&
				!(account.pausedUntil !== null && account.pausedUntil > now) &&
				modelAccountOverBudgetNow(account),
		);
		if (overBudget) return "over_budget";
	}
	return "ok";
};

const decryptAccountKey = async (
	db: BackendDb,
	secrets: TestSecrets,
	credentialId: string | null,
	input: {
		orgId: string;
		actorUserId: string | null;
		runId?: string | null;
		reason: string;
	},
): Promise<string | null> => {
	if (!credentialId) return null;
	const credential = await db.query.testCredentials.findFirst({
		where: and(
			eq(testCredentials.id, credentialId),
			isNull(testCredentials.deletedAt),
		),
	});
	if (!credential?.secretFieldsEnc) return null;
	const value = await secrets.decrypt(
		input.orgId,
		credentialSubject(credential),
		credential.secretFieldsEnc,
		{
			actorUserId: input.actorUserId,
			runId: input.runId ?? null,
			reason: input.reason,
		},
	);
	return value.api_key || null;
};

// The decrypted accounts of the providers the models need, each provider in priority order.
export const resolveRunAccounts = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: {
		orgId: string;
		modelIds: readonly string[];
		actorUserId: string | null;
		runId?: string | null;
		reason: string;
		now?: number;
	},
): Promise<RunModelAccount[]> => {
	const now = input.now ?? Date.now();
	const accounts = await listModelAccounts(db, input.orgId, now);
	const rows = new Map(
		(await accountRows(db, input.orgId)).map((row) => [row.id, row]),
	);
	const resolved: RunModelAccount[] = [];
	for (const provider of providersForModels(input.modelIds)) {
		for (const account of orderedUsableAccounts(
			accounts,
			provider.prefix,
			now,
		)) {
			const apiKey = provider.keyEnv
				? await decryptAccountKey(
						db,
						secrets,
						rows.get(account.id)?.credentialId ?? null,
						input,
					)
				: null;
			if (provider.keyRequired && !apiKey) continue;
			resolved.push({
				id: account.id,
				provider: account.provider,
				label: account.label,
				apiKey,
				baseUrl: provider.baseUrlEnv ? account.baseUrl : null,
				remainingUsd: modelAccountRemainingUsd(account),
				overBudget: account.overBudget,
			});
		}
	}
	return resolved;
};

// ---------------------------------------------------------------------------------------------
// What runs report back
// ---------------------------------------------------------------------------------------------

const cooldownFor = (event: ModelAccountEvent): number | null => {
	switch (event.kind) {
		case "rate_limited":
			return Math.min(
				MAX_RATE_LIMIT_COOLDOWN_MS,
				Math.max(event.retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS, 10_000),
			);
		case "quota_exhausted":
			return QUOTA_COOLDOWN_MS;
		case "auth_failed":
			return AUTH_COOLDOWN_MS;
		case "budget_exhausted":
			return null;
	}
};

// Rate limits, exhausted quotas and rejected keys the runner (or the backend's own model calls)
// hit: the account moves to the back of the queue until its cooldown ends.
export const applyModelAccountEvents = async (
	db: BackendDb,
	orgId: string,
	events: readonly ModelAccountEvent[],
	now = Date.now(),
): Promise<void> => {
	if (events.length === 0) return;
	const rows = await db.query.organizationModelAccounts.findMany({
		where: and(
			eq(organizationModelAccounts.orgId, orgId),
			inArray(organizationModelAccounts.id, [
				...new Set(events.map((event) => event.accountId)),
			]),
		),
	});
	for (const row of rows) {
		const own = events.filter((event) => event.accountId === row.id);
		const last = own.at(-1);
		if (!last) continue;
		const at = Number.isNaN(Date.parse(last.at)) ? now : Date.parse(last.at);
		const until = own.reduce<number | null>((latest, event) => {
			const ms = cooldownFor(event);
			if (ms === null) return latest;
			const eventAt = Number.isNaN(Date.parse(event.at))
				? now
				: Date.parse(event.at);
			return Math.max(latest ?? 0, eventAt + ms);
		}, null);
		await db
			.update(organizationModelAccounts)
			.set({
				lastErrorCode: last.kind,
				lastErrorMessage: last.message.slice(0, 1000) || null,
				lastErrorAt: at,
				...(until !== null
					? { cooldownUntil: Math.max(until, row.cooldownUntil ?? 0) }
					: {}),
			})
			.where(eq(organizationModelAccounts.id, row.id));
	}
};

// Stores a finished run's per-account usage (budgets and the cost report read it) and applies
// the failures it ran into. Unknown account ids (deleted meanwhile) keep their spend unattributed.
export const recordRunModelAccounts = async (
	db: BackendDb,
	input: {
		orgId: string;
		runId: string;
		report: RunModelAccountsReport | undefined;
		finishedAt: number;
	},
): Promise<void> => {
	const report = input.report;
	if (!report) return;
	const ids = [...new Set(report.usage.map((usage) => usage.accountId))];
	const known = new Set(
		ids.length === 0
			? []
			: (
					await db.query.organizationModelAccounts.findMany({
						where: and(
							eq(organizationModelAccounts.orgId, input.orgId),
							inArray(organizationModelAccounts.id, ids),
						),
						columns: { id: true },
					})
				).map((row) => row.id),
	);
	await db
		.delete(testRunModelUsage)
		.where(eq(testRunModelUsage.runId, input.runId));
	for (const usage of report.usage) {
		if (usage.calls === 0) continue;
		await db.insert(testRunModelUsage).values({
			runId: input.runId,
			orgId: input.orgId,
			accountId: known.has(usage.accountId) ? usage.accountId : null,
			modelId: usage.modelId,
			calls: usage.calls,
			inputTokens: usage.inputTokens,
			cachedInputTokens: usage.cachedInputTokens,
			outputTokens: usage.outputTokens,
			reasoningTokens: usage.reasoningTokens,
			costUsd: usage.costUsd ?? 0,
			finishedAt: input.finishedAt,
		});
	}
	for (const id of known) {
		await db
			.update(organizationModelAccounts)
			.set({ lastUsedAt: input.finishedAt })
			.where(eq(organizationModelAccounts.id, id));
	}
	await applyModelAccountEvents(
		db,
		input.orgId,
		report.events,
		input.finishedAt,
	);
};
