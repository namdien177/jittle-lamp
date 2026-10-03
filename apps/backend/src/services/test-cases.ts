import { Buffer } from "node:buffer";
import {
	computeTestCaseFingerprint,
	isFakeDataToken,
	type LintFinding,
	lintTestCase,
	loginProfileArg,
	type MacroParam,
	macroParamSchema,
	type ParsedTestCase,
	parseTestCaseTranscript,
	parseTranscriptDocument,
	resolveCredentialAlias,
	type SimilarTestCase,
	type StepScript,
	serializeTestCase,
	serializeTranscriptDocument,
	substituteVariables,
	type TestCaseDetail,
	type TestCaseListQuery,
	type TestCaseListResponse,
	type TestCaseStats,
	type TestCaseSummary,
	type TranscriptStep,
	testCaseLinkSchema,
	testCaseListQuerySchema,
	transcriptStepSchema,
	trigramSimilarity,
	type UpdateTestCaseRequest,
} from "@jittle-lamp/shared";
import {
	and,
	asc,
	count,
	desc,
	eq,
	inArray,
	isNull,
	like,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { z } from "zod/v4";

import {
	organizationTestCounters,
	testCaseDatasets,
	testCases,
	testCaseVersions,
	testCredentials,
	testEnvironments,
	testMacros,
	testRuns,
	testStepScripts,
	testSuiteMembers,
	type testSuites,
} from "../db/schema";
import { conflict, HttpError, notFound } from "../http/test-http";
import type { BackendDb } from "./user-provisioning";

// Test case storage on top of the shared transcript model (design.md §3, §4, §7; ADR 0002
// decisions 1 and 13). The transcript is the source of truth; columns are derived from it.

export type TestCaseRow = typeof testCases.$inferSelect;

export const parseJsonColumn = <T>(
	value: string | null | undefined,
	schema: z.ZodType<T>,
	fallback: T,
): T => {
	if (!value) return fallback;
	try {
		const parsed = schema.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : fallback;
	} catch {
		return fallback;
	}
};

// Each stored link is checked on its own: a row written before links were limited to http(s)
// loses only its bad entries, not the whole list.
export const parseLinksColumn = (
	value: string | null | undefined,
): Array<z.output<typeof testCaseLinkSchema>> =>
	parseJsonColumn(value, z.array(z.unknown()), []).flatMap((entry) => {
		const link = testCaseLinkSchema.safeParse(entry);
		return link.success ? [link.data] : [];
	});

const stringArray = z.array(z.string());
const stringRecord = z.record(z.string(), z.string());
const stepsArray = z.array(transcriptStepSchema);
const lintArray = z
	.array(z.unknown())
	.transform((items) => items as LintFinding[]);

export const caseSteps = (row: Pick<TestCaseRow, "stepsJson">) =>
	parseJsonColumn(row.stepsJson, stepsArray, []);
export const caseTags = (row: Pick<TestCaseRow, "tagsJson">) =>
	parseJsonColumn(row.tagsJson, stringArray, []);

// ---------------------------------------------------------------------------------------------
// Parsing and derived columns
// ---------------------------------------------------------------------------------------------

export const parseSingleCase = (
	transcript: string,
	previousSteps?: readonly Pick<TranscriptStep, "stepId" | "instructionKey">[],
): ParsedTestCase => {
	let parsed: ParsedTestCase;
	try {
		parsed = parseTestCaseTranscript(
			transcript,
			previousSteps ? { previousSteps } : {},
		).testCase;
	} catch (error) {
		throw new HttpError(
			422,
			"TRANSCRIPT_INVALID",
			error instanceof Error ? error.message : "Transcript could not be parsed",
		);
	}
	if (parsed.title.trim().length === 0) {
		throw new HttpError(
			422,
			"TRANSCRIPT_TITLE_REQUIRED",
			"A test case transcript starts with a '# Title' heading",
		);
	}
	return parsed;
};

export type LintContext = {
	macros: Array<{ name: string; params: MacroParam[] }>;
	// Keys a [Use: KEY] step may name.
	cases: Array<{ key: string }>;
	caseKey?: string;
	environmentVariables?: string[];
};

export const loadLintContext = async (
	db: BackendDb,
	orgId: string,
	environmentId: string | null,
): Promise<LintContext> => {
	const macros = await db.query.testMacros.findMany({
		where: and(eq(testMacros.orgId, orgId), isNull(testMacros.deletedAt)),
		columns: { name: true, paramsJson: true },
	});
	const cases = await db.query.testCases.findMany({
		where: and(eq(testCases.orgId, orgId), isNull(testCases.deletedAt)),
		columns: { key: true },
	});
	const context: LintContext = {
		cases,
		macros: macros.map((macro) => ({
			name: macro.name,
			params: parseJsonColumn(macro.paramsJson, z.array(macroParamSchema), []),
		})),
	};
	if (environmentId) {
		const environment = await db.query.testEnvironments.findFirst({
			where: eq(testEnvironments.id, environmentId),
			columns: { variablesJson: true },
		});
		if (environment) {
			context.environmentVariables = Object.keys(
				parseJsonColumn(environment.variablesJson, stringRecord, {}),
			);
		}
	}
	return context;
};

export const deriveCaseColumns = (
	parsed: ParsedTestCase,
	context: LintContext,
) => {
	const lint = lintTestCase(parsed, context);
	const links = parsed.metadata.links.flatMap((url) => {
		const link = testCaseLinkSchema.safeParse({ url, label: null });
		return link.success ? [link.data] : [];
	});
	const tags = Array.from(new Set(parsed.metadata.tags));
	return {
		title: parsed.title.trim(),
		description: parsed.metadata.description,
		linksJson: JSON.stringify(links),
		tagsJson: JSON.stringify(tags),
		tagsText: tags.join(" "),
		stepsJson: JSON.stringify(parsed.steps),
		paramsSchemaJson: JSON.stringify(parsed.metadata.params),
		datasetJson: parsed.dataset ? JSON.stringify(parsed.dataset) : null,
		lintJson: JSON.stringify(lint),
		lintErrors: lint.filter((finding) => finding.severity === "error").length,
		lintWarnings: lint.filter((finding) => finding.severity === "warning")
			.length,
		fingerprint: computeTestCaseFingerprint(parsed),
		retries: parsed.metadata.retries ?? 0,
		externalId: parsed.metadata.externalId,
	};
};

export const resolveEnvironmentId = async (
	db: BackendDb,
	orgId: string,
	input: { environmentId?: string | null | undefined; envName?: string | null },
): Promise<string | null> => {
	if (input.environmentId) {
		const environment = await db.query.testEnvironments.findFirst({
			where: and(
				eq(testEnvironments.id, input.environmentId),
				eq(testEnvironments.orgId, orgId),
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
		return environment.id;
	}
	if (input.environmentId === null) return null;
	if (input.envName) {
		const environment = await db.query.testEnvironments.findFirst({
			where: and(
				eq(testEnvironments.orgId, orgId),
				eq(testEnvironments.name, input.envName),
				isNull(testEnvironments.deletedAt),
			),
			columns: { id: true },
		});
		return environment?.id ?? null;
	}
	return null;
};

export const formatCaseKey = (number: number) =>
	`TC-${String(number).padStart(4, "0")}`;

export const nextCaseKey = async (
	db: BackendDb,
	orgId: string,
): Promise<string> => {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const [row] = await db
			.insert(organizationTestCounters)
			.values({ orgId, nextCaseNumber: 2 })
			.onConflictDoUpdate({
				target: organizationTestCounters.orgId,
				set: {
					nextCaseNumber: sql`${organizationTestCounters.nextCaseNumber} + 1`,
				},
			})
			.returning({ next: organizationTestCounters.nextCaseNumber });
		const key = formatCaseKey((row?.next ?? 2) - 1);
		const taken = await db.query.testCases.findFirst({
			where: and(eq(testCases.orgId, orgId), eq(testCases.key, key)),
			columns: { id: true },
		});
		if (!taken) return key;
	}
	throw new Error("Could not allocate a test case key");
};

// ---------------------------------------------------------------------------------------------
// Create and update
// ---------------------------------------------------------------------------------------------

export type CreateCaseInput = {
	orgId: string;
	userId: string | null;
	transcript: string;
	status: TestCaseRow["status"];
	environmentId?: string | null | undefined;
	source: TestCaseRow["source"];
	sourceRef?: string | null | undefined;
	duplicatedFromId?: string | null;
	previousSteps?: readonly Pick<TranscriptStep, "stepId" | "instructionKey">[];
	changeNote?: string | null;
};

export const createTestCase = async (
	db: BackendDb,
	input: CreateCaseInput,
): Promise<TestCaseRow> => {
	const parsed = parseSingleCase(input.transcript, input.previousSteps);
	const environmentId = await resolveEnvironmentId(db, input.orgId, {
		environmentId: input.environmentId,
		envName: parsed.metadata.env,
	});
	const columns = deriveCaseColumns(
		parsed,
		await loadLintContext(db, input.orgId, environmentId),
	);
	const key = await nextCaseKey(db, input.orgId);
	const now = Date.now();
	const [row] = await db
		.insert(testCases)
		.values({
			orgId: input.orgId,
			key,
			createdBy: input.userId,
			updatedBy: input.userId,
			...columns,
			environmentId,
			transcript: input.transcript,
			transcriptVersion: 1,
			status: input.status,
			source: input.source,
			sourceRef: input.sourceRef ?? null,
			duplicatedFromId: input.duplicatedFromId ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	if (!row) throw new Error("Failed to create test case");
	await db.insert(testCaseVersions).values({
		testCaseId: row.id,
		version: 1,
		transcript: input.transcript,
		stepsJson: columns.stepsJson,
		createdBy: input.userId,
		createdAt: now,
		changeNote: input.changeNote ?? null,
	});
	await syncDataset(db, row.id, parsed);
	return row;
};

const syncDataset = async (
	db: BackendDb,
	testCaseId: string,
	parsed: ParsedTestCase,
) => {
	await db
		.delete(testCaseDatasets)
		.where(eq(testCaseDatasets.testCaseId, testCaseId));
	if (!parsed.dataset) return;
	await db.insert(testCaseDatasets).values({
		testCaseId,
		name: parsed.dataset.name,
		columnsJson: JSON.stringify(parsed.dataset.columns),
		rowsJson: JSON.stringify(parsed.dataset.rows),
		enabled: true,
	});
};

export const getTestCaseRow = async (
	db: BackendDb,
	orgId: string,
	id: string,
): Promise<TestCaseRow> => {
	const row = await db.query.testCases.findFirst({
		where: and(
			eq(testCases.orgId, orgId),
			or(eq(testCases.id, id), eq(testCases.key, id)),
			isNull(testCases.deletedAt),
		),
	});
	if (!row) throw notFound("TEST_CASE_NOT_FOUND", "Test case not found");
	return row;
};

// Transcript edits re-parse against the stored steps so unchanged lines keep their step ids,
// bump transcript_version and store a version row (design.md §4 "Step identity", §14).
export const updateTestCase = async (
	db: BackendDb,
	input: {
		row: TestCaseRow;
		userId: string | null;
		request: UpdateTestCaseRequest;
		canApprove: boolean;
	},
): Promise<TestCaseRow> => {
	const { row, request } = input;
	if (
		request.expectedVersion !== undefined &&
		request.expectedVersion !== row.transcriptVersion
	) {
		throw conflict(
			"TEST_CASE_VERSION_CONFLICT",
			`Test case is at version ${row.transcriptVersion}, not ${request.expectedVersion}`,
			{ currentVersion: row.transcriptVersion },
		);
	}
	// Any way out of the review queue (active, draft, archived) is an approval decision.
	if (
		row.status === "review" &&
		request.status !== undefined &&
		request.status !== "review" &&
		!input.canApprove
	) {
		throw new HttpError(
			403,
			"TEST_PERMISSION_DENIED",
			"Moving a case out of the review queue needs test_case.approve",
			{ permission: "test_case.approve" },
		);
	}

	const now = Date.now();
	const set: Partial<typeof testCases.$inferInsert> = {
		updatedAt: now,
		updatedBy: input.userId,
	};
	if (request.status !== undefined) {
		set.status = request.status;
		if (request.status !== "archived") set.statusReason = null;
	}

	const transcriptChanged =
		request.transcript !== undefined && request.transcript !== row.transcript;
	let parsed: ParsedTestCase | null = null;
	if (transcriptChanged && request.transcript !== undefined) {
		parsed = parseSingleCase(request.transcript, caseSteps(row));
		set.transcript = request.transcript;
		set.transcriptVersion = row.transcriptVersion + 1;
	}
	if (request.environmentId !== undefined) {
		set.environmentId = await resolveEnvironmentId(db, row.orgId, {
			environmentId: request.environmentId,
		});
	} else if (parsed?.metadata.env) {
		set.environmentId =
			(await resolveEnvironmentId(db, row.orgId, {
				envName: parsed.metadata.env,
			})) ?? row.environmentId;
	}
	if (parsed) {
		Object.assign(
			set,
			deriveCaseColumns(parsed, {
				...(await loadLintContext(
					db,
					row.orgId,
					set.environmentId ?? row.environmentId,
				)),
				caseKey: row.key,
			}),
		);
	}

	const [updated] = await db
		.update(testCases)
		.set(set)
		.where(
			and(
				eq(testCases.id, row.id),
				eq(testCases.transcriptVersion, row.transcriptVersion),
			),
		)
		.returning();
	if (!updated) {
		throw conflict(
			"TEST_CASE_VERSION_CONFLICT",
			"Test case changed while it was being saved; reload and retry",
		);
	}
	if (parsed && set.transcript !== undefined) {
		await db.insert(testCaseVersions).values({
			testCaseId: row.id,
			version: updated.transcriptVersion,
			transcript: set.transcript,
			stepsJson: updated.stepsJson,
			createdBy: input.userId,
			createdAt: now,
			changeNote: request.changeNote ?? null,
		});
		await syncDataset(db, row.id, parsed);
	}
	return updated;
};

// Rewrites metadata lines of a stored transcript (tags, environment) and saves it as a new
// version, so the transcript stays the source of truth.
export const rewriteCaseMetadata = async (
	db: BackendDb,
	input: {
		row: TestCaseRow;
		userId: string | null;
		changeNote: string;
		edit: (testCase: ParsedTestCase) => ParsedTestCase;
		environmentId?: string | null;
	},
): Promise<TestCaseRow> => {
	const parsed = parseSingleCase(input.row.transcript, caseSteps(input.row));
	const transcript = serializeTestCase(input.edit(parsed));
	return updateTestCase(db, {
		row: input.row,
		userId: input.userId,
		canApprove: true,
		request: {
			transcript,
			changeNote: input.changeNote,
			...(input.environmentId !== undefined
				? { environmentId: input.environmentId }
				: {}),
		},
	});
};

export const withMetadataKey = (
	testCase: ParsedTestCase,
	key: keyof ParsedTestCase["metadata"],
	value: unknown,
): ParsedTestCase => {
	// A new Key line goes first, like the document format examples (design.md §7).
	const order = testCase.metadata.order.includes(key as never)
		? testCase.metadata.order
		: key === "key"
			? ["key" as const, ...testCase.metadata.order]
			: [...testCase.metadata.order, key as never];
	return {
		...testCase,
		metadata: { ...testCase.metadata, [key]: value, order },
	};
};

// ---------------------------------------------------------------------------------------------
// Stats, summaries, details
// ---------------------------------------------------------------------------------------------

const emptyStats = (): TestCaseStats => ({
	runs: 0,
	lastOutcome: null,
	lastRunAt: null,
	passRate: null,
	flakyRate: null,
	avgDurationMs: null,
	avgCostUsd: null,
	avgModelCalls: null,
	avgTokens: null,
	cachedSteps: 0,
	staleSteps: 0,
	derivedCases: 0,
});

const average = (values: Array<number | null>): number | null => {
	const present = values.filter(
		(value): value is number => value !== null && Number.isFinite(value),
	);
	if (present.length === 0) return null;
	return present.reduce((total, value) => total + value, 0) / present.length;
};

// Runs superseded by a retry attempt do not count; the retry carries the verdict.
const notSupersededRun = sql`not exists (select 1 from ${testRuns} as next_attempt where next_attempt.retry_of_run_id = ${testRuns.id})`;

// Ten-run averages per case (handover §6).
export const computeCaseStats = async (
	db: BackendDb,
	caseIds: readonly string[],
): Promise<Map<string, TestCaseStats>> => {
	const stats = new Map<string, TestCaseStats>();
	for (const id of caseIds) stats.set(id, emptyStats());
	if (caseIds.length === 0) return stats;

	const recent = await db.all<{
		test_case_id: string;
		outcome: "passed" | "failed" | "blocked";
		flaky: number;
		finished_at: number;
		duration_ms: number | null;
		cost_usd: number | null;
		model_calls: number;
		tokens: number;
	}>(sql`select * from (
		select ${testRuns.testCaseId} as test_case_id, ${testRuns.outcome} as outcome,
			${testRuns.flaky} as flaky, ${testRuns.finishedAt} as finished_at,
			${testRuns.durationMs} as duration_ms, ${testRuns.costUsd} as cost_usd,
			${testRuns.modelCalls} as model_calls,
			(${testRuns.inputTokens} + ${testRuns.cachedInputTokens} + ${testRuns.outputTokens} + ${testRuns.reasoningTokens}) as tokens,
			row_number() over (partition by ${testRuns.testCaseId} order by ${testRuns.finishedAt} desc) as rn
		from ${testRuns}
		where ${inArray(testRuns.testCaseId, [...caseIds])}
			and ${testRuns.finishedAt} is not null and ${testRuns.outcome} is not null
			and ${notSupersededRun}
	) where rn <= 10 order by test_case_id, finished_at desc`);
	const totals = await db
		.select({ testCaseId: testRuns.testCaseId, runs: count() })
		.from(testRuns)
		.where(
			and(
				inArray(testRuns.testCaseId, [...caseIds]),
				sql`${testRuns.finishedAt} is not null and ${testRuns.outcome} is not null`,
				notSupersededRun,
			),
		)
		.groupBy(testRuns.testCaseId);
	const scripts = await db
		.select({
			testCaseId: testStepScripts.testCaseId,
			status: testStepScripts.status,
			steps: sql<number>`count(distinct ${testStepScripts.stepId})`,
		})
		.from(testStepScripts)
		.where(inArray(testStepScripts.testCaseId, [...caseIds]))
		.groupBy(testStepScripts.testCaseId, testStepScripts.status);
	const derived = await db
		.select({ sourceId: testCases.duplicatedFromId, cases: count() })
		.from(testCases)
		.where(
			and(
				inArray(testCases.duplicatedFromId, [...caseIds]),
				isNull(testCases.deletedAt),
			),
		)
		.groupBy(testCases.duplicatedFromId);

	const byCase = new Map<string, typeof recent>();
	for (const run of recent) {
		const list = byCase.get(run.test_case_id) ?? [];
		list.push(run);
		byCase.set(run.test_case_id, list);
	}
	for (const [caseId, runs] of byCase) {
		const entry = stats.get(caseId);
		if (!entry) continue;
		const latest = runs[0];
		entry.lastOutcome = latest?.outcome ?? null;
		entry.lastRunAt = latest?.finished_at ?? null;
		// Blocked runs are excluded from pass rates (design.md §2 "Verdicts").
		const judged = runs.filter((run) => run.outcome !== "blocked");
		entry.passRate =
			judged.length > 0
				? judged.filter((run) => run.outcome === "passed").length /
					judged.length
				: null;
		entry.flakyRate =
			runs.length > 0
				? runs.filter((run) => Boolean(run.flaky)).length / runs.length
				: null;
		entry.avgDurationMs = average(runs.map((run) => run.duration_ms));
		entry.avgCostUsd = average(runs.map((run) => run.cost_usd));
		entry.avgModelCalls = average(runs.map((run) => run.model_calls));
		entry.avgTokens = average(runs.map((run) => run.tokens));
	}
	for (const total of totals) {
		const entry = stats.get(total.testCaseId);
		if (entry) entry.runs = total.runs;
	}
	for (const script of scripts) {
		const entry = stats.get(script.testCaseId);
		if (!entry) continue;
		if (script.status === "active") entry.cachedSteps = Number(script.steps);
		if (script.status === "stale") entry.staleSteps = Number(script.steps);
	}
	for (const row of derived) {
		const entry = row.sourceId ? stats.get(row.sourceId) : undefined;
		if (entry) entry.derivedCases = row.cases;
	}
	return stats;
};

export const toCaseSummary = (
	row: TestCaseRow,
	stats: TestCaseStats,
): TestCaseSummary => ({
	id: row.id,
	key: row.key,
	title: row.title,
	status: row.status,
	source: row.source,
	tags: caseTags(row),
	environmentId: row.environmentId,
	transcriptVersion: row.transcriptVersion,
	stepCount: caseSteps(row).filter((step) => !step.disabled).length,
	lintErrors: row.lintErrors,
	lintWarnings: row.lintWarnings,
	duplicatedFromId: row.duplicatedFromId,
	createdBy: row.createdBy,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
	stats,
});

// Credential profiles a case needs: login macro calls and {cred:PROFILE.field} references.
export const referencedCredentialProfiles = (
	steps: readonly TranscriptStep[],
	values: Readonly<Record<string, string>> = {},
): string[] => {
	const profiles = new Set<string>();
	for (const step of steps) {
		if (step.disabled) continue;
		if (step.type === "login") {
			const profile = loginProfileArg(step.args);
			if (profile) profiles.add(substituteVariables(profile, values));
		}
		for (const ref of step.credentialRefs) {
			const profile = substituteVariables(ref, values).split(".")[0];
			if (profile) profiles.add(profile);
		}
	}
	return [...profiles].filter((profile) => !/[{}]/.test(profile));
};

export const computeRequiredConfig = async (
	db: BackendDb,
	row: TestCaseRow,
	environmentId: string | null,
): Promise<TestCaseDetail["requiredConfig"]> => {
	const steps = caseSteps(row);
	const parsedParams = parseJsonColumn(
		row.paramsSchemaJson,
		z.array(z.object({ name: z.string() })),
		[],
	);
	const declared = new Set(parsedParams.map((param) => param.name));
	const dataset = parseJsonColumn(
		row.datasetJson,
		z.object({ columns: z.array(z.string()) }).nullable(),
		null,
	);
	for (const column of dataset?.columns ?? []) declared.add(column);
	for (const step of steps) {
		if (step.type === "extract") {
			const target = step.args[0]?.value;
			if (target) declared.add(target);
		}
	}
	const variables = Array.from(
		new Set(
			steps
				.filter((step) => !step.disabled)
				.flatMap((step) => step.variables)
				// {person.name} and friends are generated by the runner.
				.filter((name) => !declared.has(name) && !isFakeDataToken(name)),
		),
	).sort();
	const environment = environmentId
		? await db.query.testEnvironments.findFirst({
				where: eq(testEnvironments.id, environmentId),
				columns: { variablesJson: true },
			})
		: null;
	const envVariables = parseJsonColumn(
		environment?.variablesJson,
		stringRecord,
		{},
	);
	const credentials = referencedCredentialProfiles(steps, envVariables).sort();
	const stored = credentials.length
		? await db.query.testCredentials.findMany({
				where: and(
					eq(testCredentials.orgId, row.orgId),
					isNull(testCredentials.deletedAt),
				),
				columns: { profile: true, environmentId: true },
			})
		: [];
	const usable = new Set(
		stored
			.filter(
				(credential) =>
					credential.environmentId === null ||
					credential.environmentId === environmentId,
			)
			.map((credential) => credential.profile),
	);
	const available = new Set(
		credentials.filter(
			(profile) => resolveCredentialAlias(profile, usable) !== null,
		),
	);
	return {
		variables,
		credentials,
		unresolved: [
			...variables.filter((name) => envVariables[name] === undefined),
			...credentials.filter((profile) => !available.has(profile)),
		],
	};
};

export const toCaseDetail = async (
	db: BackendDb,
	row: TestCaseRow,
	stats?: TestCaseStats,
): Promise<TestCaseDetail> => {
	const resolvedStats =
		stats ?? (await computeCaseStats(db, [row.id])).get(row.id) ?? emptyStats();
	return {
		...toCaseSummary(row, resolvedStats),
		description: row.description,
		links: parseLinksColumn(row.linksJson),
		transcript: row.transcript,
		steps: caseSteps(row),
		params: parseJsonColumn(
			row.paramsSchemaJson,
			z.array(
				z.object({
					name: z.string().min(1),
					default: z.string().nullable(),
					required: z.boolean(),
				}),
			),
			[],
		),
		dataset: parseJsonColumn(
			row.datasetJson,
			z
				.object({
					name: z.string().nullable(),
					columns: z.array(z.string().min(1)),
					rows: z.array(z.record(z.string(), z.string())),
				})
				.nullable(),
			null,
		),
		lint: parseJsonColumn(row.lintJson, lintArray, []),
		externalId: row.externalId,
		sourceRef: row.sourceRef,
		fingerprint: row.fingerprint,
		retries: row.retries,
		requiredConfig: await computeRequiredConfig(db, row, row.environmentId),
	};
};

// ---------------------------------------------------------------------------------------------
// List with full-text search, filters, tag namespace counts and a cursor
// ---------------------------------------------------------------------------------------------

const ftsTerms = (text: string): string[] =>
	text
		.split(/\s+/)
		.map((term) => term.trim())
		.filter((term) => [...term].length >= 3)
		.slice(0, 12);

const ftsPhrase = (term: string) => `"${term.replace(/"/g, '""')}"`;

export const splitTag = (tag: string): { namespace: string; name: string } => {
	const index = tag.indexOf(":");
	if (index <= 0) return { namespace: "", name: tag };
	return { namespace: tag.slice(0, index), name: tag.slice(index + 1) };
};

const encodeCursor = (offset: number) =>
	Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
const decodeCursor = (cursor: string | undefined): number => {
	if (!cursor) return 0;
	try {
		const parsed = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		) as { o?: unknown };
		return typeof parsed.o === "number" && parsed.o >= 0 ? parsed.o : 0;
	} catch {
		throw new HttpError(422, "VALIDATION", "cursor: invalid cursor");
	}
};

const latestOutcomeSql = sql`(select r.outcome from ${testRuns} r where r.test_case_id = ${testCases.id} and r.finished_at is not null order by r.finished_at desc limit 1)`;

export const testCaseFilterConditions = (
	orgId: string,
	query: {
		[Key in keyof TestCaseListQuery]?: TestCaseListQuery[Key] | undefined;
	},
	options: { includeTags: boolean },
): SQL[] => {
	const conditions: SQL[] = [
		eq(testCases.orgId, orgId),
		isNull(testCases.deletedAt),
	];
	const q = query.q?.trim();
	if (q) {
		const terms = ftsTerms(q);
		if (terms.length > 0) {
			conditions.push(
				sql`${testCases.id} in (select test_case_id from test_cases_fts where test_cases_fts match ${terms.map(ftsPhrase).join(" ")} and org_id = ${orgId})`,
			);
		} else {
			const pattern = `%${q}%`;
			const textMatch = or(
				like(testCases.key, pattern),
				like(testCases.title, pattern),
			);
			if (textMatch) conditions.push(textMatch);
		}
	}
	if (query.status?.length)
		conditions.push(inArray(testCases.status, query.status));
	if (query.source?.length)
		conditions.push(inArray(testCases.source, query.source));
	if (query.environmentId)
		conditions.push(eq(testCases.environmentId, query.environmentId));
	if (query.createdBy)
		conditions.push(eq(testCases.createdBy, query.createdBy));
	if (options.includeTags) {
		for (const tag of query.tags ?? []) {
			conditions.push(
				sql`exists (select 1 from json_each(${testCases.tagsJson}) where value = ${tag})`,
			);
		}
	}
	if (query.lastOutcome?.length) {
		conditions.push(
			sql`${latestOutcomeSql} in (${sql.join(
				query.lastOutcome.map((outcome) => sql`${outcome}`),
				sql`, `,
			)})`,
		);
	}
	if (query.staleCache === true) {
		conditions.push(
			sql`exists (select 1 from ${testStepScripts} s where s.test_case_id = ${testCases.id} and s.status = 'stale')`,
		);
	}
	if (query.noRunsSinceDays) {
		const since = Date.now() - query.noRunsSinceDays * 24 * 60 * 60 * 1000;
		conditions.push(
			sql`not exists (select 1 from ${testRuns} r where r.test_case_id = ${testCases.id} and r.queued_at >= ${since})`,
		);
	}
	return conditions;
};

export const listTestCases = async (
	db: BackendDb,
	orgId: string,
	query: TestCaseListQuery,
): Promise<TestCaseListResponse> => {
	const where = and(
		...testCaseFilterConditions(orgId, query, { includeTags: true }),
	);
	const direction = query.order === "asc" ? asc : desc;
	const orderBy = (() => {
		switch (query.sort) {
			case "created":
				return [direction(testCases.createdAt)];
			case "key":
				return [
					direction(sql`length(${testCases.key})`),
					direction(testCases.key),
				];
			case "title":
				return [direction(sql`lower(${testCases.title})`)];
			case "last-run":
				return [
					direction(
						sql`coalesce((select max(r.queued_at) from ${testRuns} r where r.test_case_id = ${testCases.id}), 0)`,
					),
				];
			default:
				return [direction(testCases.updatedAt)];
		}
	})();
	const offset = decodeCursor(query.cursor);
	const rows = await db
		.select()
		.from(testCases)
		.where(where)
		.orderBy(...orderBy, asc(testCases.id))
		.limit(query.limit + 1)
		.offset(offset);
	const page = rows.slice(0, query.limit);
	const [total] = await db
		.select({ value: count() })
		.from(testCases)
		.where(where);
	const tagRows = await db.all<{ tag: string; n: number }>(
		sql`select j.value as tag, count(*) as n from ${testCases}, json_each(${testCases.tagsJson}) j where ${and(
			...testCaseFilterConditions(orgId, query, { includeTags: false }),
		)} group by j.value`,
	);
	const tagCounts: Record<string, Record<string, number>> = {};
	for (const entry of tagRows) {
		const { namespace, name } = splitTag(String(entry.tag));
		const group = tagCounts[namespace] ?? {};
		group[name] = Number(entry.n);
		tagCounts[namespace] = group;
	}
	const stats = await computeCaseStats(
		db,
		page.map((row) => row.id),
	);
	return {
		items: page.map((row) =>
			toCaseSummary(row, stats.get(row.id) ?? emptyStats()),
		),
		total: total?.value ?? 0,
		nextCursor:
			rows.length > query.limit ? encodeCursor(offset + query.limit) : null,
		tagCounts,
	};
};

// ---------------------------------------------------------------------------------------------
// Similarity: exact fingerprint plus FTS trigram candidates scored with trigramSimilarity
// ---------------------------------------------------------------------------------------------

const stepsText = (steps: readonly TranscriptStep[]) =>
	steps
		.filter((step) => !step.disabled)
		.map((step) => step.text)
		.join("\n");

export const SIMILARITY_THRESHOLD = 0.35;

export const findSimilarCases = async (
	db: BackendDb,
	orgId: string,
	input: {
		title?: string | undefined;
		transcript?: string | undefined;
		excludeIds?: readonly string[];
		limit?: number;
	},
): Promise<SimilarTestCase[]> => {
	let title = input.title?.trim() ?? "";
	let fingerprint: string | null = null;
	let text = "";
	if (input.transcript?.trim()) {
		const document = parseTranscriptDocument(input.transcript);
		const first = document.cases[0];
		if (first) {
			title = title || first.title;
			fingerprint = first.steps.length
				? computeTestCaseFingerprint(first)
				: null;
			text = stepsText(first.steps);
		}
	}
	if (!title && !text) return [];

	const exclude = new Set(input.excludeIds ?? []);
	const candidates = new Map<string, TestCaseRow>();
	if (fingerprint) {
		for (const row of await db.query.testCases.findMany({
			where: and(
				eq(testCases.orgId, orgId),
				eq(testCases.fingerprint, fingerprint),
				isNull(testCases.deletedAt),
			),
			limit: 50,
		})) {
			candidates.set(row.id, row);
		}
	}
	const terms = ftsTerms(`${title} ${text}`.slice(0, 2000));
	if (terms.length > 0) {
		for (const row of await db.query.testCases.findMany({
			where: and(
				eq(testCases.orgId, orgId),
				isNull(testCases.deletedAt),
				sql`${testCases.id} in (select test_case_id from test_cases_fts where test_cases_fts match ${terms.map(ftsPhrase).join(" OR ")} and org_id = ${orgId} order by rank limit 300)`,
			),
		})) {
			candidates.set(row.id, row);
		}
	}

	const scored: SimilarTestCase[] = [];
	for (const row of candidates.values()) {
		if (exclude.has(row.id)) continue;
		const exact = fingerprint !== null && row.fingerprint === fingerprint;
		const titleScore = title ? trigramSimilarity(title, row.title) : 0;
		const textScore = text
			? trigramSimilarity(text, stepsText(caseSteps(row)))
			: 0;
		const score = exact
			? 1
			: text && title
				? 0.4 * titleScore + 0.6 * textScore
				: Math.max(titleScore, textScore);
		if (!exact && score < SIMILARITY_THRESHOLD) continue;
		scored.push({
			id: row.id,
			key: row.key,
			title: row.title,
			score: Math.round(Math.min(1, score) * 1000) / 1000,
			exact,
		});
	}
	return scored
		.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score)
		.slice(0, input.limit ?? 10);
};

// ---------------------------------------------------------------------------------------------
// Export, scripts
// ---------------------------------------------------------------------------------------------

export const exportCasesDocument = (rows: readonly TestCaseRow[]): string =>
	serializeTranscriptDocument({
		cases: rows.map((row) => {
			const parsed = parseSingleCase(row.transcript, caseSteps(row));
			return withMetadataKey(parsed, "key", row.key);
		}),
	});

export const toStepScript = (
	row: typeof testStepScripts.$inferSelect,
): StepScript => ({
	id: row.id,
	testCaseId: row.testCaseId,
	stepId: row.stepId,
	instructionKey: row.instructionKey ?? row.stepId,
	environmentId: row.environmentId,
	keyHash: row.keyHash,
	version: row.version,
	renderedCode: row.renderedCode,
	status: row.status,
	staleReason: row.staleReason,
	verifiedCount: row.verifiedCount,
	recordedFromRunId: row.recordedFromRunId,
	lastReplayedAt: row.lastReplayedAt,
	createdAt: row.createdAt,
});

// Copies active scripts of unchanged instructions to a duplicate so it replays on its first run
// (ADR 0002 decision 13).
export const inheritStepScripts = async (
	db: BackendDb,
	input: { source: TestCaseRow; target: TestCaseRow },
): Promise<number> => {
	const targetSteps = caseSteps(input.target);
	const byInstruction = new Map<string, string[]>();
	for (const step of targetSteps) {
		const ids = byInstruction.get(step.instructionKey) ?? [];
		ids.push(step.stepId);
		byInstruction.set(step.instructionKey, ids);
	}
	const sourceSteps = new Map(
		caseSteps(input.source).map((step) => [step.stepId, step.instructionKey]),
	);
	const scripts = await db.query.testStepScripts.findMany({
		where: and(
			eq(testStepScripts.testCaseId, input.source.id),
			eq(testStepScripts.status, "active"),
		),
	});
	let inherited = 0;
	const now = Date.now();
	for (const script of scripts) {
		// Steps a macro call expanded into ("<parent>.<n>") follow their parent: an unchanged
		// call expands to the same steps, so their scripts carry over under the target's parent id.
		const dot = script.stepId.indexOf(".");
		if (dot > 0) {
			const parentKey = sourceSteps.get(script.stepId.slice(0, dot));
			const targetParents = parentKey
				? byInstruction.get(parentKey)
				: undefined;
			if (!targetParents?.length) continue;
			const suffix = script.stepId.slice(dot);
			const stepIds = targetParents.map((parent) => `${parent}${suffix}`);
			await db.insert(testStepScripts).values({
				orgId: input.target.orgId,
				testCaseId: input.target.id,
				stepId: stepIds[0] ?? script.stepId,
				stepIdsJson: JSON.stringify(stepIds),
				instructionKey: script.instructionKey,
				environmentId: script.environmentId,
				keyHash: script.keyHash,
				entryJson: script.entryJson,
				version: 1,
				actionsJson: script.actionsJson,
				endStateJson: script.endStateJson,
				renderedCode: script.renderedCode,
				recordedFromRunId: script.recordedFromRunId,
				inheritedFromScriptId: script.id,
				status: "active",
				verifiedCount: 0,
				createdAt: now,
				updatedAt: now,
			});
			inherited += 1;
			continue;
		}
		const instructionKey =
			script.instructionKey ?? sourceSteps.get(script.stepId) ?? null;
		const stepIds = instructionKey
			? byInstruction.get(instructionKey)
			: undefined;
		if (!instructionKey || !stepIds?.length) continue;
		await db.insert(testStepScripts).values({
			orgId: input.target.orgId,
			testCaseId: input.target.id,
			stepId: stepIds[0] ?? script.stepId,
			stepIdsJson: JSON.stringify(stepIds),
			instructionKey,
			environmentId: script.environmentId,
			keyHash: script.keyHash,
			entryJson: script.entryJson,
			version: 1,
			actionsJson: script.actionsJson,
			endStateJson: script.endStateJson,
			renderedCode: script.renderedCode,
			recordedFromRunId: script.recordedFromRunId,
			inheritedFromScriptId: script.id,
			status: "active",
			verifiedCount: 0,
			createdAt: now,
			updatedAt: now,
		});
		inherited += 1;
	}
	return inherited;
};

export const applyReplacements = (
	text: string,
	replacements: ReadonlyArray<{ find: string; replace: string }>,
): string =>
	replacements.reduce(
		(current, { find, replace }) => current.split(find).join(replace),
		text,
	);

export const loadCases = async (
	db: BackendDb,
	orgId: string,
	ids: readonly string[],
): Promise<TestCaseRow[]> => {
	const rows = await db.query.testCases.findMany({
		where: and(
			eq(testCases.orgId, orgId),
			inArray(testCases.id, [...ids]),
			isNull(testCases.deletedAt),
		),
	});
	const byId = new Map(rows.map((row) => [row.id, row]));
	return ids.flatMap((id) => {
		const row = byId.get(id);
		return row ? [row] : [];
	});
};

// Suites: static members plus, for smart suites, every case matching the saved filter.
export const suiteMembers = async (
	db: BackendDb,
	orgId: string,
	suite: Pick<typeof testSuites.$inferSelect, "id" | "filterJson">,
): Promise<TestCaseRow[]> => {
	const members = await db.query.testSuiteMembers.findMany({
		where: eq(testSuiteMembers.suiteId, suite.id),
		orderBy: asc(testSuiteMembers.position),
	});
	const ids = members.map((member) => member.testCaseId);
	const filter = parseJsonColumn(
		suite.filterJson,
		testCaseListQuerySchema.partial().nullable(),
		null,
	);
	if (filter) {
		const rows = await db
			.select({ id: testCases.id })
			.from(testCases)
			.where(
				and(...testCaseFilterConditions(orgId, filter, { includeTags: true })),
			)
			.orderBy(asc(testCases.key))
			.limit(1000);
		for (const row of rows) if (!ids.includes(row.id)) ids.push(row.id);
	}
	return loadCases(db, orgId, ids);
};
