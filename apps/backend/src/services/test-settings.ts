import {
	defaultModelPrices,
	defaultPriceTableVersion,
	expandMacros,
	type MacroDefinition,
	type ModelCostReport,
	type ModelPrice,
	type ModelSettings,
	macroParamSchema,
	parseTestCaseTranscript,
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
import { parseJsonColumn, referencedCredentialProfiles } from "./test-cases";
import type { TestSecrets } from "./test-config";
import {
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
			(row) => options.includeInternal || row.profile !== MODEL_KEY_PROFILE,
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

const credentialSubject = (row: Pick<CredentialRow, "id" | "profile">) => ({
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

export const DEFAULT_ACT_MODEL = "anthropic/claude-opus-5-5";
export const DEFAULT_JUDGE_MODEL = "anthropic/claude-sonnet-5-5";
// The BYOK key lives in a `model_key` credential with this profile (design.md §9.3).
export const MODEL_KEY_PROFILE = "JL_MODEL_KEY";

export const modelProviderOf = (modelId: string): string =>
	modelId.startsWith("mock:") ? "mock" : (modelId.split("/")[0] ?? modelId);

// Environment variable names the runner's model resolver reads, per provider.
const providerKeyNames: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	gateway: "AI_GATEWAY_API_KEY",
	xai: "XAI_API_KEY",
	google: "GOOGLE_GENERATIVE_AI_API_KEY",
	"openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
};

export const providerKeyName = (modelId: string): string | null =>
	providerKeyNames[modelProviderOf(modelId)] ?? null;

export const getModelSettings = async (
	db: BackendDb,
	orgId: string,
): Promise<ModelSettings & { keyCredentialId: string | null }> => {
	const row = await db.query.organizationModelSettings.findFirst({
		where: eq(organizationModelSettings.orgId, orgId),
	});
	const actModel = row?.actModel ?? DEFAULT_ACT_MODEL;
	return {
		actModel,
		judgeModel: row?.judgeModel ?? DEFAULT_JUDGE_MODEL,
		provider: row?.provider ?? modelProviderOf(actModel),
		keyConfigured: Boolean(row?.keyCredentialId),
		keyLast4: row?.keyCredentialId ? (row.keyLast4 ?? null) : null,
		keyCredentialId: row?.keyCredentialId ?? null,
	};
};

export const saveModelSettings = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: { orgId: string; userId: string; request: UpdateModelSettingsRequest },
): Promise<void> => {
	const current = await getModelSettings(db, input.orgId);
	let keyCredentialId = current.keyCredentialId;
	let keyLast4 = current.keyLast4;
	if (input.request.apiKey === null && keyCredentialId) {
		await db
			.update(testCredentials)
			.set({ deletedAt: Date.now(), deletedBy: input.userId })
			.where(eq(testCredentials.id, keyCredentialId));
		keyCredentialId = null;
		keyLast4 = null;
	} else if (typeof input.request.apiKey === "string") {
		const credential = await saveCredential(db, secrets, {
			orgId: input.orgId,
			userId: input.userId,
			...(keyCredentialId ? { id: keyCredentialId } : {}),
			request: {
				profile: MODEL_KEY_PROFILE,
				kind: "model_key",
				environmentId: null,
				fields: {},
				secretFields: { api_key: input.request.apiKey },
			},
			replaceSecrets: true,
			reason: "model_key.update",
		});
		keyCredentialId = credential.id;
		keyLast4 = input.request.apiKey.slice(-4);
	}
	const values = {
		actModel: input.request.actModel,
		judgeModel: input.request.judgeModel,
		provider: modelProviderOf(input.request.actModel),
		keyCredentialId,
		keyLast4,
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
};

// Decrypts the organisation model key as runner environment variables ({ ANTHROPIC_API_KEY }).
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
	if (settings.keyCredentialId) {
		const credential = await db.query.testCredentials.findFirst({
			where: and(
				eq(testCredentials.id, settings.keyCredentialId),
				isNull(testCredentials.deletedAt),
			),
		});
		if (credential?.secretFieldsEnc) {
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
			const key = value.api_key;
			if (key) {
				for (const modelId of [settings.actModel, settings.judgeModel]) {
					const name = providerKeyName(modelId);
					if (name) apiKeys[name] = key;
				}
			}
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
	for (const price of defaultModelPrices) {
		await db
			.insert(testModelPrices)
			.values({
				orgId: null,
				modelId: price.modelId,
				inputUsdPerMtok: price.inputUsdPerMtok,
				cachedInputUsdPerMtok: price.cachedInputUsdPerMtok,
				outputUsdPerMtok: price.outputUsdPerMtok,
				version: defaultPriceTableVersion,
				effectiveFrom: 0,
			})
			.onConflictDoNothing();
	}
};

export const resolvePriceTable = async (
	db: BackendDb,
	orgId: string,
	at = Date.now(),
): Promise<{ prices: ModelPrice[]; version: string }> => {
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
	};
};

// ---------------------------------------------------------------------------------------------
// Per-run config (design.md §9.3): environment plus decrypted credentials the case references
// ---------------------------------------------------------------------------------------------

const credentialProfilesForRun = (
	steps: z.infer<typeof transcriptStepSchema>[],
	macros: MacroDefinition[],
	values: Record<string, string>,
): string[] => {
	const expanded = expandMacros(steps, macros).steps;
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
	const profiles = credentialProfilesForRun(steps, macros, {
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
		const rows = await db.query.testCredentials.findMany({
			where: and(
				eq(testCredentials.orgId, run.orgId),
				eq(testCredentials.kind, "login"),
				inArray(testCredentials.profile, profiles),
				isNull(testCredentials.deletedAt),
			),
		});
		for (const profile of profiles) {
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
			baseUrl: environment?.baseUrl ?? "",
			variables,
			agentInstructions: environment?.agentInstructions ?? null,
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
