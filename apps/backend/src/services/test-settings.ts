import {
	defaultModelPrices,
	defaultPriceTableVersion,
	expandMacros,
	findModelProvider,
	type LinkedCase,
	type MacroDefinition,
	type ModelCostReport,
	type ModelPrice,
	type ModelSettings,
	macroParamSchema,
	modelIdProblem,
	parseTestCaseTranscript,
	resolveCredentialAlias,
	resolveLoginField,
	modelProviderOf as sharedModelProviderOf,
	type TestCredential,
	type TestEnvironment,
	type TestMacro,
	type TestRunConfig,
	type TestRunSettings,
	type TestTag,
	transcriptStepSchema,
	type updateModelSettingsRequestSchema,
	type upsertTestCredentialRequestSchema,
	type upsertTestEnvironmentRequestSchema,
	type upsertTestMacroRequestSchema,
} from "@jittle-lamp/shared";
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod/v4";

import {
	organizationAgentNotes,
	organizationModelSettings,
	testCases,
	testCredentials,
	testEnvironments,
	testMacros,
	testModelPrices,
	testRunSettings,
	testRunSteps,
	testRuns,
} from "../db/schema";
import { conflict, HttpError, notFound } from "../http/test-http";
import {
	assertOutboundUrl,
	defaultOutboundPolicy,
	OutboundBlockedError,
	type OutboundPolicy,
} from "./outbound-http";
import { parseJsonColumn, referencedCredentialProfiles } from "./test-cases";
import type { TestSecrets } from "./test-config";
import {
	loadLinkedCases,
	loadRunMacros,
	runTranscriptVersion,
	type TestRunRow,
} from "./test-runs";
import type { BackendDb } from "./user-provisioning";

// Organisation test configuration: environments, credential profiles (write-only secrets),
// macros, run and model settings, and the per-run config a runner fetches (design.md §9).

const stringRecord = z.record(z.string(), z.string());
const stringArray = z.array(z.string());

type UpsertTestEnvironmentRequest = z.output<
	typeof upsertTestEnvironmentRequestSchema
>;
type UpsertTestCredentialRequest = z.output<
	typeof upsertTestCredentialRequestSchema
>;
type UpsertTestMacroRequest = z.output<typeof upsertTestMacroRequestSchema>;
type UpdateModelSettingsRequest = z.output<
	typeof updateModelSettingsRequestSchema
>;

const isUniqueViolation = (error: unknown) =>
	/UNIQUE constraint failed/i.test(
		String((error as { cause?: unknown })?.cause ?? error),
	);

// ---------------------------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------------------------

export type EnvironmentRow = typeof testEnvironments.$inferSelect;

export const toEnvironment = (
	row: EnvironmentRow,
	usedByCases: number,
): TestEnvironment => ({
	id: row.id,
	name: row.name,
	baseUrl: row.baseUrl,
	variables: parseJsonColumn(row.variablesJson, stringRecord, {}),
	runnerPool: row.runnerPool,
	agentInstructions: row.agentInstructions,
	dataLocale: row.dataLocale,
	notes: row.notes,
	usedByCases,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

const environmentUsage = async (db: BackendDb, ids: string[]) => {
	if (ids.length === 0) return new Map<string, number>();
	const rows = await db
		.select({
			environmentId: testCases.environmentId,
			cases: sql<number>`count(*)`,
		})
		.from(testCases)
		.where(
			and(inArray(testCases.environmentId, ids), isNull(testCases.deletedAt)),
		)
		.groupBy(testCases.environmentId);
	return new Map(
		rows.flatMap((row) =>
			row.environmentId ? [[row.environmentId, Number(row.cases)]] : [],
		),
	);
};

export const listEnvironments = async (
	db: BackendDb,
	orgId: string,
): Promise<TestEnvironment[]> => {
	const rows = await db.query.testEnvironments.findMany({
		where: and(
			eq(testEnvironments.orgId, orgId),
			isNull(testEnvironments.deletedAt),
		),
		orderBy: testEnvironments.name,
	});
	const usage = await environmentUsage(
		db,
		rows.map((row) => row.id),
	);
	return rows.map((row) => toEnvironment(row, usage.get(row.id) ?? 0));
};

export const getEnvironmentRow = async (
	db: BackendDb,
	orgId: string,
	id: string,
): Promise<EnvironmentRow> => {
	const row = await db.query.testEnvironments.findFirst({
		where: and(
			eq(testEnvironments.orgId, orgId),
			or(eq(testEnvironments.id, id), eq(testEnvironments.name, id)),
			isNull(testEnvironments.deletedAt),
		),
	});
	if (!row) {
		throw notFound("TEST_ENVIRONMENT_NOT_FOUND", "Test environment not found");
	}
	return row;
};

export const environmentResponse = async (
	db: BackendDb,
	row: EnvironmentRow,
): Promise<TestEnvironment> =>
	toEnvironment(row, (await environmentUsage(db, [row.id])).get(row.id) ?? 0);

export const saveEnvironment = async (
	db: BackendDb,
	input: {
		orgId: string;
		userId: string;
		id?: string;
		request: UpsertTestEnvironmentRequest;
	},
): Promise<EnvironmentRow> => {
	const now = Date.now();
	const values = {
		name: input.request.name,
		baseUrl: input.request.baseUrl,
		variablesJson: JSON.stringify(input.request.variables),
		runnerPool: input.request.runnerPool,
		...(input.request.agentInstructions !== undefined
			? { agentInstructions: input.request.agentInstructions }
			: {}),
		...(input.request.dataLocale !== undefined
			? { dataLocale: input.request.dataLocale }
			: {}),
		...(input.request.notes !== undefined
			? { notes: input.request.notes }
			: {}),
		updatedAt: now,
	};
	try {
		if (input.id) {
			const existing = await getEnvironmentRow(db, input.orgId, input.id);
			const [row] = await db
				.update(testEnvironments)
				.set(values)
				.where(eq(testEnvironments.id, existing.id))
				.returning();
			if (!row) throw new Error("Failed to update environment");
			return row;
		}
		const [row] = await db
			.insert(testEnvironments)
			.values({
				orgId: input.orgId,
				createdBy: input.userId,
				createdAt: now,
				...values,
			})
			.returning();
		if (!row) throw new Error("Failed to create environment");
		return row;
	} catch (error) {
		if (isUniqueViolation(error)) {
			throw conflict(
				"TEST_ENVIRONMENT_EXISTS",
				`An environment named ${input.request.name} already exists`,
			);
		}
		throw error;
	}
};

// ---------------------------------------------------------------------------------------------
// Credentials (secret values are write-only)
// ---------------------------------------------------------------------------------------------

export type CredentialRow = typeof testCredentials.$inferSelect;

export const toCredential = (row: CredentialRow): TestCredential => ({
	id: row.id,
	profile: row.profile,
	kind: row.kind,
	environmentId: row.environmentId,
	fields: parseJsonColumn(row.fieldsJson, stringRecord, {}),
	secretFieldNames: parseJsonColumn(row.secretFieldNamesJson, stringArray, []),
	keyVersion: row.keyVersion,
	lastUsedAt: row.lastUsedAt,
	loginMacroId: row.loginMacroId,
	loginField: row.loginField,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

export const listCredentials = async (
	db: BackendDb,
	orgId: string,
	options: { includeInternal?: boolean } = {},
): Promise<TestCredential[]> => {
	const rows = await db.query.testCredentials.findMany({
		where: and(
			eq(testCredentials.orgId, orgId),
			isNull(testCredentials.deletedAt),
		),
		orderBy: testCredentials.profile,
	});
	return rows
		.filter(
			(row) =>
				options.includeInternal || !internalCredentialProfiles.has(row.profile),
		)
		.map(toCredential);
};

export const getCredentialRow = async (
	db: BackendDb,
	orgId: string,
	id: string,
): Promise<CredentialRow> => {
	const row = await db.query.testCredentials.findFirst({
		where: and(
			eq(testCredentials.orgId, orgId),
			eq(testCredentials.id, id),
			isNull(testCredentials.deletedAt),
		),
	});
	if (!row) throw notFound("TEST_CREDENTIAL_NOT_FOUND", "Credential not found");
	return row;
};

export const credentialSubject = (
	row: Pick<CredentialRow, "id" | "profile">,
) => ({
	kind: "test_credential",
	id: row.id,
	label: row.profile,
});

export const saveCredential = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: {
		orgId: string;
		userId: string;
		id?: string;
		request: UpsertTestCredentialRequest;
		// Rotation replaces every secret field instead of merging.
		replaceSecrets?: boolean;
		reason?: string;
	},
): Promise<CredentialRow> => {
	const now = Date.now();
	const { request } = input;
	const existingCredential = input.id
		? await getCredentialRow(db, input.orgId, input.id)
		: null;
	const loginField =
		request.kind === "login"
			? request.loginField !== undefined
				? request.loginField
				: (existingCredential?.loginField ?? null)
			: null;
	const secretNames = new Set(
		input.replaceSecrets
			? []
			: parseJsonColumn(
					existingCredential?.secretFieldNamesJson ?? "[]",
					stringArray,
					[],
				),
	);
	for (const [name, value] of Object.entries(request.secretFields)) {
		if (value === null) secretNames.delete(name);
		else secretNames.add(name);
	}
	if (Object.keys(request.fields).some((name) => secretNames.has(name)))
		throw new HttpError(
			422,
			"CREDENTIAL_FIELD_OVERLAP",
			"A field cannot be both public and secret",
		);
	const existingFields = parseJsonColumn(
		existingCredential?.fieldsJson ?? "{}",
		stringRecord,
		{},
	);
	const publicFieldsChanged =
		Object.keys(existingFields).length !== Object.keys(request.fields).length ||
		Object.entries(request.fields).some(
			([name, value]) => existingFields[name] !== value,
		);
	const loginSelectionChanged =
		!existingCredential ||
		existingCredential.kind !== request.kind ||
		loginField !== existingCredential.loginField ||
		publicFieldsChanged;
	if (
		request.kind === "login" &&
		loginSelectionChanged &&
		(loginField !== null || Object.keys(request.fields).length > 0)
	) {
		const selection = resolveLoginField(request.fields, loginField);
		if (selection.error)
			throw new HttpError(
				422,
				"CREDENTIAL_LOGIN_FIELD_INVALID",
				selection.error,
			);
	}

	if (Object.keys(request.secretFields).length > 0 || input.replaceSecrets) {
		secrets.assertAvailable();
	}
	if (request.environmentId) {
		const environment = await db.query.testEnvironments.findFirst({
			where: and(
				eq(testEnvironments.id, request.environmentId),
				eq(testEnvironments.orgId, input.orgId),
				isNull(testEnvironments.deletedAt),
			),
			columns: { id: true },
		});
		if (!environment) {
			throw notFound(
				"TEST_ENVIRONMENT_NOT_FOUND",
				"Test environment not found in this organisation",
			);
		}
	}
	let row: CredentialRow;
	try {
		if (input.id) {
			const existing = await getCredentialRow(db, input.orgId, input.id);
			const [updated] = await db
				.update(testCredentials)
				.set({
					profile: request.profile,
					kind: request.kind,
					...(request.environmentId !== undefined
						? { environmentId: request.environmentId }
						: {}),
					fieldsJson: JSON.stringify(request.fields),
					loginField,
					...(request.loginMacroId !== undefined
						? { loginMacroId: request.loginMacroId }
						: {}),
					updatedAt: now,
				})
				.where(eq(testCredentials.id, existing.id))
				.returning();
			if (!updated) throw new Error("Failed to update credential");
			row = updated;
		} else {
			const [created] = await db
				.insert(testCredentials)
				.values({
					orgId: input.orgId,
					profile: request.profile,
					kind: request.kind,
					environmentId: request.environmentId ?? null,
					fieldsJson: JSON.stringify(request.fields),
					loginField,
					loginMacroId: request.loginMacroId ?? null,
					createdBy: input.userId,
					createdAt: now,
					updatedAt: now,
				})
				.returning();
			if (!created) throw new Error("Failed to create credential");
			row = created;
		}
	} catch (error) {
		if (isUniqueViolation(error)) {
			throw conflict(
				"TEST_CREDENTIAL_EXISTS",
				`A credential profile ${request.profile} already exists for this environment`,
			);
		}
		throw error;
	}

	const changes = Object.entries(request.secretFields);
	if (changes.length === 0 && !input.replaceSecrets) return row;
	let current: Record<string, string> = {};
	if (!input.replaceSecrets && row.secretFieldsEnc) {
		current = await secrets.decrypt(
			input.orgId,
			credentialSubject(row),
			row.secretFieldsEnc,
			{
				actorUserId: input.userId,
				reason: input.reason ?? "credential.update",
			},
		);
	}
	for (const [name, value] of changes) {
		if (value === null) delete current[name];
		else current[name] = value;
	}
	const names = Object.keys(current).sort();
	const sealed =
		names.length > 0
			? await secrets.encrypt(input.orgId, credentialSubject(row), current)
			: null;
	const [saved] = await db
		.update(testCredentials)
		.set({
			secretFieldsEnc: sealed?.enc ?? null,
			keyVersion: sealed?.keyVersion ?? row.keyVersion,
			secretFieldNamesJson: JSON.stringify(names),
			updatedAt: Date.now(),
		})
		.where(eq(testCredentials.id, row.id))
		.returning();
	if (!saved) throw new Error("Failed to store credential secrets");
	return saved;
};

// ---------------------------------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------------------------------

export type MacroRow = typeof testMacros.$inferSelect;

export const toMacro = (row: MacroRow): TestMacro => ({
	id: row.id,
	name: row.name,
	params: parseJsonColumn(row.paramsJson, z.array(macroParamSchema), []),
	transcript: row.transcript,
	version: row.version,
	status: row.status,
	createdBy: row.createdBy,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

export const getMacroRow = async (
	db: BackendDb,
	orgId: string,
	id: string,
): Promise<MacroRow> => {
	const row = await db.query.testMacros.findFirst({
		where: and(
			eq(testMacros.orgId, orgId),
			eq(testMacros.id, id),
			isNull(testMacros.deletedAt),
		),
	});
	if (!row) throw notFound("TEST_MACRO_NOT_FOUND", "Macro not found");
	return row;
};

const parseMacroSteps = (transcript: string) => {
	try {
		return parseTestCaseTranscript(transcript).testCase.steps;
	} catch (error) {
		throw new HttpError(
			422,
			"TRANSCRIPT_INVALID",
			error instanceof Error ? error.message : "Macro body could not be parsed",
		);
	}
};

export const saveMacro = async (
	db: BackendDb,
	input: {
		orgId: string;
		userId: string;
		id?: string;
		request: UpsertTestMacroRequest;
		defaultStatus: "draft" | "active";
	},
): Promise<MacroRow> => {
	const now = Date.now();
	const steps = parseMacroSteps(input.request.transcript);
	const values = {
		name: input.request.name,
		paramsJson: JSON.stringify(input.request.params),
		transcript: input.request.transcript,
		stepsJson: JSON.stringify(steps),
		updatedAt: now,
	};
	try {
		if (input.id) {
			const existing = await getMacroRow(db, input.orgId, input.id);
			const bodyChanged =
				existing.transcript !== values.transcript ||
				existing.paramsJson !== values.paramsJson ||
				existing.name !== values.name;
			const [row] = await db
				.update(testMacros)
				.set({
					...values,
					...(input.request.status ? { status: input.request.status } : {}),
					// Editing a macro bumps its version, which changes the instructionKey of every
					// expanded step and invalidates only those scripts (design.md §3.1).
					version: bodyChanged ? existing.version + 1 : existing.version,
				})
				.where(eq(testMacros.id, existing.id))
				.returning();
			if (!row) throw new Error("Failed to update macro");
			return row;
		}
		const [row] = await db
			.insert(testMacros)
			.values({
				orgId: input.orgId,
				createdBy: input.userId,
				status: input.request.status ?? input.defaultStatus,
				createdAt: now,
				...values,
			})
			.returning();
		if (!row) throw new Error("Failed to create macro");
		return row;
	} catch (error) {
		if (isUniqueViolation(error)) {
			throw conflict(
				"TEST_MACRO_EXISTS",
				`A macro named ${input.request.name} already exists`,
			);
		}
		throw error;
	}
};

// ---------------------------------------------------------------------------------------------
// Tags with counts
// ---------------------------------------------------------------------------------------------

export const tagCountsForOrg = async (
	db: BackendDb,
	orgId: string,
): Promise<Map<string, number>> => {
	const rows = await db.all<{ tag: string; n: number }>(
		sql`select j.value as tag, count(*) as n from ${testCases}, json_each(${testCases.tagsJson}) j where ${testCases.orgId} = ${orgId} and ${testCases.deletedAt} is null group by j.value`,
	);
	return new Map(rows.map((row) => [String(row.tag), Number(row.n)]));
};

export const toTag = (
	row: {
		id: string;
		namespace: string;
		name: string;
		color: string;
		description: string | null;
	},
	counts: Map<string, number>,
): TestTag => ({
	id: row.id,
	namespace: row.namespace,
	name: row.name,
	color: row.color,
	description: row.description,
	count:
		counts.get(row.namespace ? `${row.namespace}:${row.name}` : row.name) ?? 0,
});

// ---------------------------------------------------------------------------------------------
// Run and model settings
// ---------------------------------------------------------------------------------------------

export const saveRunSettings = async (
	db: BackendDb,
	orgId: string,
	userId: string,
	settings: TestRunSettings,
): Promise<void> => {
	const values = {
		maxConcurrentRuns: settings.maxConcurrentRuns,
		dedupeWindowSeconds: settings.dedupeWindowSeconds,
		maxQueuedRuns: settings.maxQueuedRuns,
		maxQueuedPerCase: settings.maxQueuedPerCase,
		tokenBucketSize: settings.tokenBucketSize,
		tokenBucketWindowSeconds: settings.tokenBucketWindowSeconds,
		dailyBudgetUsd: settings.dailyBudgetUsd,
		retentionFailedDays: settings.retention.failedDays,
		retentionPassedDays: settings.retention.passedDays,
		updatedBy: userId,
		updatedAt: Date.now(),
	};
	await db
		.insert(testRunSettings)
		.values({ orgId, ...values })
		.onConflictDoUpdate({ target: testRunSettings.orgId, set: values });
};

export const DEFAULT_ACT_MODEL = "gateway/alibaba/qwen3.7-flash";
export const DEFAULT_JUDGE_MODEL = DEFAULT_ACT_MODEL;
// BYOK keys live in `model_key` credentials with these profiles (design.md §9.3): one for the act
// model's provider and, when the judge uses another provider, one for the judge's.
export const MODEL_KEY_PROFILE = "JL_MODEL_KEY";
export const JUDGE_MODEL_KEY_PROFILE = "JL_JUDGE_MODEL_KEY";
const internalCredentialProfiles = new Set([
	MODEL_KEY_PROFILE,
	JUDGE_MODEL_KEY_PROFILE,
]);

export const modelProviderOf = sharedModelProviderOf;

// Environment variable name the runner's model resolver reads the key from, per provider.
export const providerKeyName = (modelId: string): string | null =>
	findModelProvider(modelId)?.keyEnv ?? null;

type ModelSettingsState = ModelSettings & {
	keyCredentialId: string | null;
	judgeKeyCredentialId: string | null;
};

// Which providers a pair of models needs keys and a base URL for, and what is still missing.
const modelRequirements = (input: {
	actModel: string;
	judgeModel: string;
	keyConfigured: boolean;
	judgeKeyConfigured: boolean;
	baseUrl: string | null;
}) => {
	const act = findModelProvider(input.actModel);
	const judge = findModelProvider(input.judgeModel);
	const judgeKeyRequired = Boolean(
		judge?.keyEnv && judge.prefix !== act?.prefix,
	);
	const missing: ModelSettings["missing"] = [];
	if (act?.keyRequired && !input.keyConfigured) missing.push("key");
	if (judgeKeyRequired && judge?.keyRequired && !input.judgeKeyConfigured) {
		missing.push("judgeKey");
	}
	if ((act?.baseUrlEnv || judge?.baseUrlEnv) && !input.baseUrl) {
		missing.push("baseUrl");
	}
	return { judgeKeyRequired, missing };
};

export const getModelSettings = async (
	db: BackendDb,
	orgId: string,
): Promise<ModelSettingsState> => {
	const row = await db.query.organizationModelSettings.findFirst({
		where: eq(organizationModelSettings.orgId, orgId),
	});
	const actModel = row?.actModel ?? DEFAULT_ACT_MODEL;
	const judgeModel = row?.judgeModel ?? DEFAULT_JUDGE_MODEL;
	const keyConfigured = Boolean(row?.keyCredentialId);
	const judgeKeyConfigured = Boolean(row?.judgeKeyCredentialId);
	const baseUrl = row?.baseUrl ?? null;
	return {
		actModel,
		judgeModel,
		provider: row?.provider ?? modelProviderOf(actModel),
		judgeProvider: modelProviderOf(judgeModel),
		keyConfigured,
		keyLast4: row?.keyCredentialId ? (row.keyLast4 ?? null) : null,
		judgeKeyConfigured,
		judgeKeyLast4: row?.judgeKeyCredentialId
			? (row.judgeKeyLast4 ?? null)
			: null,
		baseUrl,
		...modelRequirements({
			actModel,
			judgeModel,
			keyConfigured,
			judgeKeyConfigured,
			baseUrl,
		}),
		keyCredentialId: row?.keyCredentialId ?? null,
		judgeKeyCredentialId: row?.judgeKeyCredentialId ?? null,
	};
};

const unprocessable = (code: string, message: string) =>
	new HttpError(422, code, message);

// Rejects what a run could never use: unknown provider prefixes, and an openai-compatible model
// without an endpoint. Missing keys are allowed and reported in `missing` instead.
const assertModelSettings = async (
	request: UpdateModelSettingsRequest,
	current: ModelSettingsState,
	outbound: OutboundPolicy,
): Promise<string | null> => {
	for (const modelId of [request.actModel, request.judgeModel]) {
		const problem = modelIdProblem(modelId);
		if (problem) throw unprocessable("MODEL_PROVIDER_UNSUPPORTED", problem);
	}
	const baseUrl =
		request.baseUrl === undefined ? current.baseUrl : request.baseUrl;
	const needsBaseUrl = [request.actModel, request.judgeModel].some((id) =>
		Boolean(findModelProvider(id)?.baseUrlEnv),
	);
	if (needsBaseUrl && !baseUrl) {
		throw unprocessable(
			"MODEL_BASE_URL_REQUIRED",
			"openai-compatible/ models need the base URL of the endpoint, e.g. https://api.groq.com/openai/v1.",
		);
	}
	if (baseUrl && request.baseUrl !== undefined) {
		// The backend calls this endpoint itself for Jira import generation, so it gets the same
		// SSRF check as webhook callbacks (JL_OUTBOUND_ALLOW_HOSTS admits an internal server).
		try {
			await assertOutboundUrl(outbound, baseUrl);
		} catch (error) {
			if (!(error instanceof OutboundBlockedError)) throw error;
			throw unprocessable(
				"MODEL_BASE_URL_BLOCKED",
				`The base URL is not allowed: ${error.message}.`,
			);
		}
	}
	return baseUrl;
};

const removeModelKey = async (
	db: BackendDb,
	credentialId: string,
	userId: string,
) => {
	await db
		.update(testCredentials)
		.set({ deletedAt: Date.now(), deletedBy: userId })
		.where(eq(testCredentials.id, credentialId));
};

// Applies one key field of the request: a string replaces the key, null removes it, and an omitted
// key is kept only while the provider it was saved for stays the same.
const applyModelKey = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: {
		orgId: string;
		userId: string;
		profile: string;
		value: string | null | undefined;
		credentialId: string | null;
		last4: string | null;
		keep: boolean;
	},
): Promise<{ credentialId: string | null; last4: string | null }> => {
	if (typeof input.value === "string") {
		const credential = await saveCredential(db, secrets, {
			orgId: input.orgId,
			userId: input.userId,
			...(input.credentialId ? { id: input.credentialId } : {}),
			request: {
				profile: input.profile,
				kind: "model_key",
				environmentId: null,
				fields: {},
				secretFields: { api_key: input.value },
			},
			replaceSecrets: true,
			reason: "model_key.update",
		});
		return { credentialId: credential.id, last4: input.value.slice(-4) };
	}
	if (input.credentialId && (input.value === null || !input.keep)) {
		await removeModelKey(db, input.credentialId, input.userId);
		return { credentialId: null, last4: null };
	}
	return { credentialId: input.credentialId, last4: input.last4 };
};

export const saveModelSettings = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: {
		orgId: string;
		userId: string;
		request: UpdateModelSettingsRequest;
		outbound?: OutboundPolicy;
	},
): Promise<{ keyChanged: boolean; judgeKeyChanged: boolean }> => {
	const { request } = input;
	const current = await getModelSettings(db, input.orgId);
	const baseUrl = await assertModelSettings(
		request,
		current,
		input.outbound ?? defaultOutboundPolicy,
	);
	const actProvider = modelProviderOf(request.actModel);
	const judgeProvider = modelProviderOf(request.judgeModel);
	const judgeNeedsOwnKey =
		judgeProvider !== actProvider &&
		Boolean(findModelProvider(request.judgeModel)?.keyEnv);
	const key = await applyModelKey(db, secrets, {
		orgId: input.orgId,
		userId: input.userId,
		profile: MODEL_KEY_PROFILE,
		value: request.apiKey,
		credentialId: current.keyCredentialId,
		last4: current.keyLast4,
		// A stored key belongs to the provider of the act model it was saved with.
		keep: modelProviderOf(current.actModel) === actProvider,
	});
	const judgeKey = await applyModelKey(db, secrets, {
		orgId: input.orgId,
		userId: input.userId,
		profile: JUDGE_MODEL_KEY_PROFILE,
		// Without a provider of its own the judge uses the act key; a judge key is then removed.
		value: judgeNeedsOwnKey ? request.judgeApiKey : null,
		credentialId: current.judgeKeyCredentialId,
		last4: current.judgeKeyLast4,
		keep: modelProviderOf(current.judgeModel) === judgeProvider,
	});
	const values = {
		actModel: request.actModel,
		judgeModel: request.judgeModel,
		provider: actProvider,
		keyCredentialId: key.credentialId,
		keyLast4: key.last4,
		judgeKeyCredentialId: judgeKey.credentialId,
		judgeKeyLast4: judgeKey.last4,
		// Kept only while a model needs it.
		baseUrl: [request.actModel, request.judgeModel].some((id) =>
			Boolean(findModelProvider(id)?.baseUrlEnv),
		)
			? baseUrl
			: null,
		updatedBy: input.userId,
		updatedAt: Date.now(),
	};
	await db
		.insert(organizationModelSettings)
		.values({ orgId: input.orgId, ...values })
		.onConflictDoUpdate({
			target: organizationModelSettings.orgId,
			set: values,
		});
	return {
		keyChanged:
			key.credentialId !== current.keyCredentialId ||
			request.apiKey !== undefined,
		judgeKeyChanged:
			judgeKey.credentialId !== current.judgeKeyCredentialId ||
			request.judgeApiKey !== undefined,
	};
};

const decryptModelKey = async (
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

// The organisation's models as runner environment variables: the act provider's key under its
// name ({ OPENROUTER_API_KEY }), the judge provider's key under its own, and the
// OpenAI-compatible base URL. A key is only ever filled in for the provider it was saved for, so a
// missing judge key blocks the run with MODEL_KEY_MISSING instead of sending the act key elsewhere.
export const resolveModelKeys = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: {
		orgId: string;
		actorUserId: string | null;
		runId?: string | null;
		reason: string;
	},
): Promise<{
	act: string;
	judge: string;
	provider: string;
	apiKeys: Record<string, string>;
}> => {
	const settings = await getModelSettings(db, input.orgId);
	const apiKeys: Record<string, string> = {};
	const act = findModelProvider(settings.actModel);
	const judge = findModelProvider(settings.judgeModel);
	const actKey = act?.keyEnv
		? await decryptModelKey(db, secrets, settings.keyCredentialId, input)
		: null;
	if (act?.keyEnv && actKey) apiKeys[act.keyEnv] = actKey;
	if (judge?.keyEnv && judge.prefix === act?.prefix && actKey) {
		apiKeys[judge.keyEnv] = actKey;
	} else if (judge?.keyEnv) {
		const judgeKey = await decryptModelKey(
			db,
			secrets,
			settings.judgeKeyCredentialId,
			input,
		);
		if (judgeKey) apiKeys[judge.keyEnv] = judgeKey;
	}
	for (const provider of [act, judge]) {
		if (provider?.baseUrlEnv && settings.baseUrl) {
			apiKeys[provider.baseUrlEnv] = settings.baseUrl;
		}
	}
	return {
		act: settings.actModel,
		judge: settings.judgeModel,
		provider: settings.provider,
		apiKeys,
	};
};

// ---------------------------------------------------------------------------------------------
// Model prices: organisation rows override the global defaults (org_id null)
// ---------------------------------------------------------------------------------------------

export const ensureGlobalModelPrices = async (db: BackendDb) => {
	const existing = await db.query.testModelPrices.findFirst({
		where: and(
			isNull(testModelPrices.orgId),
			eq(testModelPrices.version, defaultPriceTableVersion),
		),
		columns: { id: true },
	});
	if (existing) return;
	// One statement publishes the whole version atomically, so concurrent readers cannot
	// mistake a partially seeded table for a complete version.
	await db
		.insert(testModelPrices)
		.values(
			defaultModelPrices.map((price) => ({
				orgId: null,
				modelId: price.modelId,
				inputUsdPerMtok: price.inputUsdPerMtok,
				cachedInputUsdPerMtok: price.cachedInputUsdPerMtok,
				outputUsdPerMtok: price.outputUsdPerMtok,
				version: defaultPriceTableVersion,
				effectiveFrom: Date.UTC(2026, 9, 3),
			})),
		)
		.onConflictDoNothing();
};

export const resolvePriceTable = async (
	db: BackendDb,
	orgId: string,
	at = Date.now(),
): Promise<{
	prices: ModelPrice[];
	version: string;
	// Model ids priced by an organisation row rather than a global default.
	organizationModelIds: Set<string>;
}> => {
	await ensureGlobalModelPrices(db);
	const rows = await db.query.testModelPrices.findMany({
		where: and(
			or(isNull(testModelPrices.orgId), eq(testModelPrices.orgId, orgId)),
			lte(testModelPrices.effectiveFrom, at),
		),
		orderBy: desc(testModelPrices.effectiveFrom),
	});
	const chosen = new Map<string, (typeof rows)[number]>();
	// Organisation rows win over global rows; within a scope the latest effective row wins.
	for (const row of rows) {
		const current = chosen.get(row.modelId);
		if (!current || (current.orgId === null && row.orgId !== null)) {
			chosen.set(row.modelId, row);
		}
	}
	const prices = [...chosen.values()].map((row) => ({
		modelId: row.modelId,
		inputUsdPerMtok: row.inputUsdPerMtok,
		cachedInputUsdPerMtok: row.cachedInputUsdPerMtok,
		outputUsdPerMtok: row.outputUsdPerMtok,
	}));
	const versions = new Set(
		[...chosen.values()].map((row) =>
			row.orgId === null ? row.version : `org:${row.version}`,
		),
	);
	return {
		prices,
		version: [...versions].sort().join("+") || defaultPriceTableVersion,
		organizationModelIds: new Set(
			[...chosen.values()]
				.filter((row) => row.orgId !== null)
				.map((row) => row.modelId),
		),
	};
};

// ---------------------------------------------------------------------------------------------
// Per-run config (design.md §9.3): environment plus decrypted credentials the case references
// ---------------------------------------------------------------------------------------------

const credentialProfilesForRun = (
	steps: z.infer<typeof transcriptStepSchema>[],
	macros: MacroDefinition[],
	cases: LinkedCase[],
	values: Record<string, string>,
): string[] => {
	// Linked cases count: a [Use: TC-0001] that logs in needs that profile too.
	const expanded = expandMacros(steps, macros, cases).steps;
	const profiles = new Set(referencedCredentialProfiles(expanded, values));
	// Macro parameters of kind "credential" carry profile names.
	const byName = new Map(
		macros.map((macro) => [macro.name.toLowerCase(), macro]),
	);
	for (const step of expanded) {
		const macro = step.macro ? byName.get(step.macro.toLowerCase()) : undefined;
		if (!macro) continue;
		macro.params.forEach((param, index) => {
			if (param.kind !== "credential") return;
			const arg =
				step.args.find(
					(candidate) =>
						candidate.name?.toLowerCase() === param.name.toLowerCase(),
				) ?? step.args.filter((candidate) => candidate.name === null)[index];
			const value = arg?.value ?? param.default;
			if (value) {
				const resolved = Object.entries(values).reduce(
					(text, [name, replacement]) =>
						text.split(`{${name}}`).join(replacement),
					value,
				);
				if (!/[{}]/.test(resolved)) profiles.add(resolved);
			}
		});
	}
	return [...profiles];
};

export const resolveRunConfig = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: { run: TestRunRow; ipAddress?: string | null },
): Promise<TestRunConfig> => {
	const { run } = input;
	const environment = run.environmentId
		? await db.query.testEnvironments.findFirst({
				where: eq(testEnvironments.id, run.environmentId),
			})
		: null;
	const variables = parseJsonColumn(
		environment?.variablesJson,
		stringRecord,
		{},
	);
	const params = parseJsonColumn(run.paramsJson, stringRecord, {});
	const version = await runTranscriptVersion(db, run);
	const steps = parseJsonColumn(
		version?.stepsJson,
		z.array(transcriptStepSchema),
		[],
	);
	const macros: MacroDefinition[] = (await loadRunMacros(db, run.orgId)).map(
		(macro) => ({ ...macro, status: "active" as const }),
	);
	const cases = await loadLinkedCases(db, run.orgId, steps);
	const profiles = credentialProfilesForRun(steps, macros, cases, {
		...variables,
		...params,
	});
	const audit = {
		actorUserId: run.createdBy,
		runId: run.id,
		reason: "run.config",
		ipAddress: input.ipAddress ?? null,
	};
	const credentials: TestRunConfig["credentials"] = [];
	if (profiles.length > 0) {
		// Usable here: scoped to the run's environment or shared.
		const rows = (
			await db.query.testCredentials.findMany({
				where: and(
					eq(testCredentials.orgId, run.orgId),
					eq(testCredentials.kind, "login"),
					isNull(testCredentials.deletedAt),
				),
			})
		).filter(
			(row) =>
				row.environmentId === null || row.environmentId === run.environmentId,
		);
		const resolvedProfiles = new Set(
			profiles.flatMap((name) => {
				const profile = resolveCredentialAlias(
					name,
					new Set(rows.map((row) => row.profile)),
				);
				return profile ? [profile] : [];
			}),
		);
		for (const profile of resolvedProfiles) {
			const candidates = rows.filter((row) => row.profile === profile);
			const row =
				candidates.find(
					(candidate) => candidate.environmentId === run.environmentId,
				) ?? candidates.find((candidate) => candidate.environmentId === null);
			if (!row) continue;
			const secretFields = row.secretFieldsEnc
				? await secrets.decrypt(
						run.orgId,
						credentialSubject(row),
						row.secretFieldsEnc,
						audit,
					)
				: {};
			await db
				.update(testCredentials)
				.set({ lastUsedAt: Date.now() })
				.where(eq(testCredentials.id, row.id));
			credentials.push({
				profile,
				fields: parseJsonColumn(row.fieldsJson, stringRecord, {}),
				loginField: row.loginField,
				secretFields,
			});
		}
	}
	const model = await resolveModelKeys(db, secrets, {
		orgId: run.orgId,
		actorUserId: run.createdBy,
		runId: run.id,
		reason: "run.config",
	});
	const notes = await db.query.organizationAgentNotes.findFirst({
		where: eq(organizationAgentNotes.orgId, run.orgId),
	});
	const priceTable = await resolvePriceTable(db, run.orgId);
	return {
		environment: {
			name: environment?.name ?? "default",
			baseUrl: run.baseUrlOverride ?? environment?.baseUrl ?? "",
			variables,
			agentInstructions: environment?.agentInstructions ?? null,
			dataLocale: environment?.dataLocale ?? null,
		},
		credentials,
		model: { act: model.act, judge: model.judge, apiKeys: model.apiKeys },
		agentNotes: notes?.notes ? notes.notes : null,
		prices: priceTable.prices,
		priceTableVersion: priceTable.version,
	};
};

// ---------------------------------------------------------------------------------------------
// `jl-e2e env pull`: JL_* lines for an environment (design.md §9.2, §9.4)
// ---------------------------------------------------------------------------------------------

const envName = (value: string) =>
	value.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
const quoteEnv = (value: string) =>
	`"${value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"')}"`;

export const renderEnvironmentFile = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: {
		environment: EnvironmentRow;
		withSecrets: boolean;
		actorUserId: string;
		ipAddress?: string | null;
	},
): Promise<string> => {
	const { environment } = input;
	const lines = [
		`# Jittle Lamp environment ${environment.name}`,
		input.withSecrets
			? "# Contains secrets. Keep this file chmod 600 and out of version control."
			: "# Secret fields are empty placeholders; fill them locally or pull with secrets.",
		`JL_ENV_NAME=${quoteEnv(environment.name)}`,
		`JL_ENV_BASE_URL=${quoteEnv(environment.baseUrl)}`,
	];
	for (const [key, value] of Object.entries(
		parseJsonColumn(environment.variablesJson, stringRecord, {}),
	)) {
		lines.push(`JL_VAR_${envName(key)}=${quoteEnv(value)}`);
	}
	const rows = await db.query.testCredentials.findMany({
		where: and(
			eq(testCredentials.orgId, environment.orgId),
			eq(testCredentials.kind, "login"),
			isNull(testCredentials.deletedAt),
			or(
				eq(testCredentials.environmentId, environment.id),
				isNull(testCredentials.environmentId),
			),
		),
		orderBy: testCredentials.profile,
	});
	const chosen = new Map<string, CredentialRow>();
	for (const row of rows) {
		const current = chosen.get(row.profile);
		if (
			!current ||
			(current.environmentId === null && row.environmentId !== null)
		) {
			chosen.set(row.profile, row);
		}
	}
	for (const row of chosen.values()) {
		const prefix = `JL_CRED_${envName(row.profile)}`;
		if (row.loginField)
			lines.push(
				`JL_CREDENTIAL_${row.profile}_LOGIN_FIELD=${quoteEnv(row.loginField)}`,
			);
		lines.push(
			`JL_CREDENTIAL_${row.profile}_PUBLIC_FIELDS=${quoteEnv(
				Object.keys(parseJsonColumn(row.fieldsJson, stringRecord, {}))
					.sort()
					.join(","),
			)}`,
		);
		lines.push(
			`JL_CREDENTIAL_${row.profile}_SECRET_FIELDS=${quoteEnv(parseJsonColumn(row.secretFieldNamesJson, stringArray, []).join(","))}`,
		);
		for (const [field, value] of Object.entries(
			parseJsonColumn(row.fieldsJson, stringRecord, {}),
		)) {
			lines.push(`${prefix}_${envName(field)}=${quoteEnv(value)}`);
		}
		const names = parseJsonColumn(row.secretFieldNamesJson, stringArray, []);
		const values =
			input.withSecrets && row.secretFieldsEnc
				? await secrets.decrypt(
						environment.orgId,
						credentialSubject(row),
						row.secretFieldsEnc,
						{
							actorUserId: input.actorUserId,
							reason: "env-file.pull",
							ipAddress: input.ipAddress ?? null,
						},
					)
				: {};
		for (const name of names) {
			lines.push(`${prefix}_${envName(name)}=${quoteEnv(values[name] ?? "")}`);
		}
	}
	return `${lines.join("\n")}\n`;
};

// ---------------------------------------------------------------------------------------------
// Model cost report per organisation, user, model and day
// ---------------------------------------------------------------------------------------------

export const buildCostReport = async (
	db: BackendDb,
	orgId: string,
	range: { from: number; to: number },
): Promise<ModelCostReport> => {
	const where = and(
		eq(testRuns.orgId, orgId),
		gte(testRuns.finishedAt, range.from),
		lte(testRuns.finishedAt, range.to),
	);
	const byUser = await db
		.select({
			userId: testRuns.createdBy,
			costUsd: sql<number>`coalesce(sum(${testRuns.costUsd}), 0)`,
			runs: sql<number>`count(*)`,
		})
		.from(testRuns)
		.where(where)
		.groupBy(testRuns.createdBy);
	const byDay = await db
		.select({
			day: sql<string>`strftime('%Y-%m-%d', ${testRuns.finishedAt} / 1000, 'unixepoch')`,
			costUsd: sql<number>`coalesce(sum(${testRuns.costUsd}), 0)`,
		})
		.from(testRuns)
		.where(where)
		.groupBy(sql`1`)
		.orderBy(sql`1`);
	const byModel = await db
		.select({
			modelId: testRunSteps.modelId,
			costUsd: sql<number>`coalesce(sum(${testRunSteps.costUsd}), 0)`,
			tokens: sql<number>`coalesce(sum(${testRunSteps.inputTokens} + ${testRunSteps.cachedInputTokens} + ${testRunSteps.outputTokens} + ${testRunSteps.reasoningTokens}), 0)`,
		})
		.from(testRunSteps)
		.innerJoin(testRuns, eq(testRunSteps.runId, testRuns.id))
		.where(and(where, sql`${testRunSteps.modelId} is not null`))
		.groupBy(testRunSteps.modelId);
	const total = byUser.reduce((sum, row) => sum + Number(row.costUsd), 0);
	const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
	return {
		from: range.from,
		to: range.to,
		totalCostUsd: round(total),
		runs: byUser.reduce((sum, row) => sum + Number(row.runs), 0),
		byUser: byUser.map((row) => ({
			userId: row.userId,
			name: null,
			costUsd: round(Number(row.costUsd)),
			runs: Number(row.runs),
		})),
		byModel: byModel.flatMap((row) =>
			row.modelId
				? [
						{
							modelId: row.modelId,
							costUsd: round(Number(row.costUsd)),
							tokens: Number(row.tokens),
						},
					]
				: [],
		),
		byDay: byDay.map((row) => ({
			day: String(row.day),
			costUsd: round(Number(row.costUsd)),
		})),
	};
};

// Organisation price overrides replace the previous override set; models without an override
// fall back to the global defaults (org_id null).
export const saveOrganizationModelPrices = async (
	db: BackendDb,
	orgId: string,
	prices: readonly ModelPrice[],
	now = Date.now(),
): Promise<void> => {
	const models = new Set<string>();
	for (const price of prices) {
		if (models.has(price.modelId)) {
			throw new HttpError(
				422,
				"VALIDATION",
				`Duplicate price for ${price.modelId}`,
			);
		}
		models.add(price.modelId);
	}
	await db.delete(testModelPrices).where(eq(testModelPrices.orgId, orgId));
	const version = `org-${new Date(now).toISOString().slice(0, 10)}-${now}`;
	for (const price of prices) {
		await db.insert(testModelPrices).values({
			orgId,
			modelId: price.modelId,
			inputUsdPerMtok: price.inputUsdPerMtok,
			cachedInputUsdPerMtok: price.cachedInputUsdPerMtok,
			outputUsdPerMtok: price.outputUsdPerMtok,
			version,
			effectiveFrom: 0,
			createdAt: now,
		});
	}
};
