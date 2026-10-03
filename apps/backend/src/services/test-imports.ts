import {
	type CreateImportRequest,
	type ImportBatch,
	type ImportItem,
	lintFindingSchema,
	parseTranscriptDocument,
	type patchImportRequestSchema,
	serializeTestCase,
	similarTestCaseSchema,
} from "@jittle-lamp/shared";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod/v4";

import {
	testCases,
	testCredentials,
	testImportBatches,
	testImportItems,
} from "../db/schema";
import { HttpError, notFound } from "../http/test-http";
import { emitNotification, emitReviewPendingCount } from "./notifications";
import {
	defaultOutboundPolicy,
	guardedFetch,
	OutboundBlockedError,
	type OutboundPolicy,
} from "./outbound-http";
import {
	createTestCase,
	deriveCaseColumns,
	findSimilarCases,
	getTestCaseRow,
	loadLintContext,
	parseJsonColumn,
	parseSingleCase,
	resolveEnvironmentId,
	type TestCaseRow,
	updateTestCase,
	withMetadataKey,
} from "./test-cases";
import type { TestSecrets } from "./test-config";
import {
	buildCaseDocument,
	extractTranscript,
	type ImportCandidate,
	jiraGenerationPrompt,
	parseCsv,
	parseGherkin,
	parseXlsx,
	rowsToCandidates,
	searchJiraIssues,
} from "./test-import-parsers";
import { resolveModelKeys } from "./test-settings";
import type { BackendDb } from "./user-provisioning";
import { ZipTooLargeError } from "./zip-limits";

// Import pipeline (design.md §7): parse → per-item lint, exact and near-duplicate matches and a
// default decision → commit creates cases in `review`. Re-importing the same file is idempotent
// through External-id or Key.

type PatchImportRequest = z.output<typeof patchImportRequestSchema>;

export type ImportBatchRow = typeof testImportBatches.$inferSelect;
type ImportItemRow = typeof testImportItems.$inferSelect;

// Generates text with the organisation's model through the runner's resolver, so `mock:<fixture>`
// replays recorded turns in tests and no provider code lives in the backend.
export type TextGenerator = (input: {
	modelId: string;
	apiKeys: Record<string, string>;
	prompt: string;
	// Every provider request goes through it; the backend passes an SSRF-guarded fetch because an
	// OpenAI-compatible base URL is an address the organisation chose.
	fetch?: typeof fetch;
}) => Promise<string>;

export const defaultTextGenerator: TextGenerator = async (input) => {
	const { resolveModel } = await import("@jittle-lamp/e2e-runner/model");
	const resolved = await resolveModel(input.modelId, {
		keys: input.apiKeys,
		...(input.fetch ? { fetch: input.fetch } : {}),
	});
	const result = await resolved.model.doGenerate({
		prompt: [
			{
				role: "system",
				content:
					"You write end-to-end test transcripts for Jittle Lamp. Output only the transcript document.",
			},
			{ role: "user", content: [{ type: "text", text: input.prompt }] },
		],
	});
	return result.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("");
};

const splitTranscriptDocument = (content: string): ImportCandidate[] => {
	const document = parseTranscriptDocument(content);
	return document.cases.map((testCase, index) => ({
		title: testCase.title,
		externalId: testCase.metadata.externalId,
		transcript: `${serializeTestCase(testCase, { forceHeading: true })}\n`,
		source: { kind: "transcript-doc", case: index + 1, line: testCase.line },
	}));
};

const findExisting = async (
	db: BackendDb,
	orgId: string,
	candidate: { externalId: string | null; key: string | null },
): Promise<TestCaseRow | null> => {
	const conditions = [
		candidate.externalId
			? eq(testCases.externalId, candidate.externalId)
			: null,
		candidate.key ? eq(testCases.key, candidate.key) : null,
	].filter((condition) => condition !== null);
	if (conditions.length === 0) return null;
	return (
		(await db.query.testCases.findFirst({
			where: and(
				eq(testCases.orgId, orgId),
				isNull(testCases.deletedAt),
				or(...conditions),
			),
		})) ?? null
	);
};

type AnalysedItem = {
	title: string;
	transcript: string;
	externalId: string | null;
	lint: unknown[];
	similar: unknown[];
	decision: ImportItem["decision"];
	state: ImportItem["state"];
	error: string | null;
	parsedJson: string | null;
	existingId: string | null;
};

const analyseCandidate = async (
	db: BackendDb,
	orgId: string,
	candidate: { title: string; transcript: string; externalId: string | null },
	environmentId: string | null,
): Promise<AnalysedItem> => {
	try {
		const parsed = parseSingleCase(candidate.transcript);
		const externalId = parsed.metadata.externalId ?? candidate.externalId;
		const columns = deriveCaseColumns(
			parsed,
			await loadLintContext(
				db,
				orgId,
				environmentId ??
					(await resolveEnvironmentId(db, orgId, {
						envName: parsed.metadata.env,
					})),
			),
		);
		const existing = await findExisting(db, orgId, {
			externalId,
			key: parsed.metadata.key,
		});
		const similar = await findSimilarCases(db, orgId, {
			title: parsed.title,
			transcript: candidate.transcript,
			...(existing ? { excludeIds: [existing.id] } : {}),
		});
		const decision: ImportItem["decision"] = existing
			? "update"
			: similar.some((match) => match.exact)
				? "skip"
				: "create";
		return {
			title: parsed.title,
			transcript: candidate.transcript,
			externalId,
			lint: JSON.parse(columns.lintJson) as unknown[],
			similar,
			decision,
			state: "ready",
			error: null,
			parsedJson: JSON.stringify({
				title: parsed.title,
				steps: parsed.steps.length,
				tags: parsed.metadata.tags,
				fingerprint: columns.fingerprint,
			}),
			existingId: existing?.id ?? null,
		};
	} catch (error) {
		return {
			title: candidate.title,
			transcript: candidate.transcript,
			externalId: candidate.externalId,
			lint: [],
			similar: [],
			decision: "skip",
			state: "error",
			error:
				error instanceof Error ? error.message : "Item could not be parsed",
			parsedJson: null,
			existingId: null,
		};
	}
};

const addDefaultTags = (transcript: string, tags: readonly string[]) => {
	if (tags.length === 0) return transcript;
	try {
		const parsed = parseSingleCase(transcript);
		return `${serializeTestCase(
			withMetadataKey(parsed, "tags", [
				...new Set([...parsed.metadata.tags, ...tags]),
			]),
		)}\n`;
	} catch {
		return transcript;
	}
};

// Jira imports generate one transcript per issue with a model call inside the request
// (design.md §7 plans a background job; until then the request makes at most this many calls).
export const JIRA_IMPORT_MAX_ISSUES = 20;

const jiraCandidates = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: {
		orgId: string;
		userId: string;
		request: CreateImportRequest;
		generateText: TextGenerator;
		fetchImpl?: typeof fetch;
		outbound?: OutboundPolicy;
	},
): Promise<Array<ImportCandidate & { error?: string }>> => {
	const { request } = input;
	if (!request.jql || !request.jiraCredentialId) {
		throw new HttpError(
			422,
			"VALIDATION",
			"jql and jiraCredentialId are required for Jira imports",
		);
	}
	const credential = await db.query.testCredentials.findFirst({
		where: and(
			eq(testCredentials.id, request.jiraCredentialId),
			eq(testCredentials.orgId, input.orgId),
			eq(testCredentials.kind, "jira"),
			isNull(testCredentials.deletedAt),
		),
	});
	if (!credential?.secretFieldsEnc) {
		throw notFound(
			"TEST_CREDENTIAL_NOT_FOUND",
			"Jira credential not found (kind jira with fields base_url, email and secret api_token)",
		);
	}
	const fields = parseJsonColumn(
		credential.fieldsJson,
		z.record(z.string(), z.string()),
		{},
	);
	const secret = await secrets.decrypt(
		input.orgId,
		{ kind: "test_credential", id: credential.id, label: credential.profile },
		credential.secretFieldsEnc,
		{ actorUserId: input.userId, reason: "import.jira" },
	);
	const baseUrl = fields.base_url;
	const email = fields.email;
	const apiToken = secret.api_token ?? secret.token;
	if (!baseUrl || !email || !apiToken) {
		throw new HttpError(
			422,
			"JIRA_CREDENTIAL_INCOMPLETE",
			"The Jira credential needs fields base_url and email and the secret api_token",
		);
	}
	let issues: Awaited<ReturnType<typeof searchJiraIssues>>;
	try {
		issues = await searchJiraIssues({
			baseUrl,
			email,
			apiToken,
			jql: request.jql,
			maxResults: JIRA_IMPORT_MAX_ISSUES,
			...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
			...(input.outbound ? { outbound: input.outbound } : {}),
		});
	} catch (error) {
		if (error instanceof OutboundBlockedError) {
			throw new HttpError(
				422,
				"JIRA_URL_BLOCKED",
				`The Jira base_url is not allowed: ${error.message}. Add the host to JL_OUTBOUND_ALLOW_HOSTS if it is an internal Jira`,
			);
		}
		throw new HttpError(
			502,
			"JIRA_UNAVAILABLE",
			error instanceof Error ? error.message : "Jira search failed",
		);
	}
	const model = await resolveModelKeys(db, secrets, {
		orgId: input.orgId,
		actorUserId: input.userId,
		reason: "import.jira.generate",
	});
	const outbound = input.outbound ?? defaultOutboundPolicy;
	const modelFetch = ((url: string | URL | Request, init?: RequestInit) =>
		guardedFetch(
			fetch,
			outbound,
			url instanceof Request ? url.url : String(url),
			init ?? {},
		)) as typeof fetch;
	const out: Array<ImportCandidate & { error?: string }> = [];
	for (const issue of issues.slice(0, JIRA_IMPORT_MAX_ISSUES)) {
		const base = {
			title: issue.summary,
			externalId: issue.key,
			source: {
				kind: "jira",
				key: issue.key,
				url: issue.url,
				summary: issue.summary,
				description: issue.description,
			},
		};
		try {
			const generated = extractTranscript(
				await input.generateText({
					modelId: model.act,
					apiKeys: model.apiKeys,
					fetch: modelFetch,
					prompt: jiraGenerationPrompt(issue),
				}),
			);
			const parsed = parseSingleCase(generated);
			const transcript = `${serializeTestCase(
				withMetadataKey(
					withMetadataKey(
						withMetadataKey(parsed, "externalId", issue.key),
						"links",
						[...new Set([issue.url, ...parsed.metadata.links])],
					),
					"tags",
					[...new Set([...parsed.metadata.tags, ...issue.labels])],
				),
			)}\n`;
			out.push({ ...base, transcript });
		} catch (error) {
			out.push({
				...base,
				transcript: buildCaseDocument({
					title: issue.summary,
					externalId: issue.key,
					links: [issue.url],
					steps: [],
				}),
				error:
					error instanceof Error
						? `Generation failed: ${error.message}`
						: "Generation failed",
			});
		}
	}
	return out;
};

export const createImportBatch = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: {
		orgId: string;
		userId: string;
		request: CreateImportRequest;
		generateText: TextGenerator;
		fetchImpl?: typeof fetch;
		// SSRF guard for Jira imports: the Jira API and the model requests.
		outbound?: OutboundPolicy;
	},
): Promise<ImportBatchRow> => {
	const { request } = input;
	const content = request.content ?? "";
	let candidates: Array<ImportCandidate & { error?: string }>;
	try {
		switch (request.sourceKind) {
			case "transcript-doc":
			case "ai-generation":
				candidates = splitTranscriptDocument(content);
				break;
			case "gherkin":
				candidates = parseGherkin(content, request.fileName);
				break;
			case "csv":
				candidates = rowsToCandidates(
					parseCsv(content),
					request.mapping,
					"csv",
				);
				break;
			case "xlsx":
				candidates = rowsToCandidates(
					parseXlsx(content),
					request.mapping,
					"xlsx",
				);
				break;
			case "jira":
				candidates = await jiraCandidates(db, secrets, input);
				break;
		}
	} catch (error) {
		if (error instanceof HttpError) throw error;
		if (error instanceof ZipTooLargeError) {
			throw new HttpError(413, "IMPORT_TOO_LARGE", `.xlsx ${error.message}`);
		}
		throw new HttpError(
			422,
			"IMPORT_PARSE_FAILED",
			error instanceof Error
				? error.message
				: "Import content could not be parsed",
		);
	}
	if (candidates.length === 0) {
		throw new HttpError(
			422,
			"IMPORT_EMPTY",
			"The import contains no test cases",
		);
	}
	if (candidates.length > 5000) {
		throw new HttpError(
			413,
			"IMPORT_TOO_LARGE",
			"An import batch holds at most 5000 cases",
		);
	}
	const environmentId = await resolveEnvironmentId(db, input.orgId, {
		environmentId: request.environmentId,
	});
	const now = Date.now();
	const [batch] = await db
		.insert(testImportBatches)
		.values({
			orgId: input.orgId,
			createdBy: input.userId,
			sourceKind: request.sourceKind,
			fileName: request.fileName ?? null,
			mappingJson: JSON.stringify(request.mapping ?? {}),
			optionsJson: JSON.stringify({
				defaultTags: request.defaultTags,
				environmentId,
				...(request.jql ? { jql: request.jql } : {}),
			}),
			status: "parsing",
			total: candidates.length,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	if (!batch) throw new Error("Failed to create import batch");
	let errors = 0;
	for (const [ordinal, candidate] of candidates.entries()) {
		const transcript = addDefaultTags(
			candidate.transcript,
			request.defaultTags,
		);
		const analysed = await analyseCandidate(
			db,
			input.orgId,
			{ ...candidate, transcript },
			environmentId,
		);
		const failed = candidate.error ?? analysed.error;
		if (failed) errors += 1;
		await db.insert(testImportItems).values({
			batchId: batch.id,
			ordinal,
			externalId: analysed.externalId,
			title: analysed.title,
			transcript: analysed.transcript,
			sourceJson: JSON.stringify(candidate.source),
			parsedJson: analysed.parsedJson,
			lintJson: JSON.stringify(analysed.lint),
			similarJson: JSON.stringify(analysed.similar),
			decision: failed ? "skip" : analysed.decision,
			state: failed ? "error" : analysed.state,
			resultTestCaseId: analysed.existingId,
			error: failed ?? null,
			createdAt: now,
			updatedAt: now,
		});
	}
	const [ready] = await db
		.update(testImportBatches)
		.set({ status: "ready", errors, updatedAt: Date.now() })
		.where(eq(testImportBatches.id, batch.id))
		.returning();
	return ready ?? batch;
};

const toImportItem = (row: ImportItemRow): ImportItem => ({
	id: row.id,
	ordinal: row.ordinal,
	externalId: row.externalId,
	title: row.title,
	transcript: row.transcript,
	lint: parseJsonColumn(row.lintJson, z.array(lintFindingSchema), []),
	similar: parseJsonColumn(row.similarJson, z.array(similarTestCaseSchema), []),
	decision: row.decision,
	resultTestCaseId: row.resultTestCaseId,
	error: row.error,
	state: row.state,
});

export const getImportBatchRow = async (
	db: BackendDb,
	orgId: string,
	batchId: string,
): Promise<ImportBatchRow> => {
	const batch = await db.query.testImportBatches.findFirst({
		where: and(
			eq(testImportBatches.id, batchId),
			eq(testImportBatches.orgId, orgId),
		),
	});
	if (!batch)
		throw notFound("IMPORT_BATCH_NOT_FOUND", "Import batch not found");
	return batch;
};

export const toImportBatch = async (
	db: BackendDb,
	batch: ImportBatchRow,
): Promise<ImportBatch> => {
	const items = await db.query.testImportItems.findMany({
		where: eq(testImportItems.batchId, batch.id),
		orderBy: asc(testImportItems.ordinal),
	});
	return {
		id: batch.id,
		sourceKind: batch.sourceKind,
		status: batch.status,
		counts: {
			total: batch.total,
			created: batch.created,
			updated: batch.updated,
			skipped: batch.skipped,
			errors: batch.errors,
		},
		createdBy: batch.createdBy,
		createdAt: batch.createdAt,
		items: items.map(toImportItem),
	};
};

// Applies decision edits and, with `commit`, creates or updates the cases.
export const patchImportBatch = async (
	db: BackendDb,
	input: {
		orgId: string;
		userId: string;
		batch: ImportBatchRow;
		request: PatchImportRequest;
	},
): Promise<{ batch: ImportBatchRow; committed: boolean }> => {
	const { batch, request } = input;
	if (batch.status === "done" || batch.status === "committing") {
		throw new HttpError(
			409,
			"IMPORT_BATCH_COMMITTED",
			"This import batch was already committed",
		);
	}
	const options = parseJsonColumn(
		batch.optionsJson,
		z.object({ environmentId: z.string().nullable().optional() }),
		{},
	);
	for (const change of request.decisions) {
		const item = await db.query.testImportItems.findFirst({
			where: and(
				eq(testImportItems.id, change.itemId),
				eq(testImportItems.batchId, batch.id),
			),
		});
		if (!item) {
			throw notFound(
				"IMPORT_ITEM_NOT_FOUND",
				`Import item ${change.itemId} not found`,
			);
		}
		const transcript = change.transcript ?? item.transcript;
		const analysed =
			change.transcript !== undefined
				? await analyseCandidate(
						db,
						input.orgId,
						{
							title: item.title,
							transcript,
							externalId: item.externalId,
						},
						options.environmentId ?? null,
					)
				: null;
		await db
			.update(testImportItems)
			.set({
				decision: change.decision,
				transcript,
				...(analysed
					? {
							title: analysed.title,
							externalId: analysed.externalId,
							lintJson: JSON.stringify(analysed.lint),
							similarJson: JSON.stringify(analysed.similar),
							parsedJson: analysed.parsedJson,
							state: analysed.state,
							error: analysed.error,
							resultTestCaseId: analysed.existingId,
						}
					: {}),
				updatedAt: Date.now(),
			})
			.where(eq(testImportItems.id, item.id));
	}
	if (!request.commit) {
		const refreshed = await getImportBatchRow(db, input.orgId, batch.id);
		return { batch: refreshed, committed: false };
	}

	await db
		.update(testImportBatches)
		.set({ status: "committing", updatedAt: Date.now() })
		.where(eq(testImportBatches.id, batch.id));
	const items = await db.query.testImportItems.findMany({
		where: eq(testImportItems.batchId, batch.id),
		orderBy: asc(testImportItems.ordinal),
	});
	const counts = { created: 0, updated: 0, skipped: 0, errors: 0 };
	for (const item of items) {
		if (item.state === "error") {
			counts.errors += 1;
			continue;
		}
		if (item.decision === "skip") {
			counts.skipped += 1;
			await db
				.update(testImportItems)
				.set({ state: "skipped", updatedAt: Date.now() })
				.where(eq(testImportItems.id, item.id));
			continue;
		}
		try {
			let resultId: string;
			const similar = parseJsonColumn(
				item.similarJson,
				z.array(similarTestCaseSchema),
				[],
			);
			const targetId =
				item.decision === "merge"
					? (item.resultTestCaseId ?? similar[0]?.id ?? null)
					: item.decision === "update"
						? item.resultTestCaseId
						: null;
			if (targetId) {
				const existing = await getTestCaseRow(db, input.orgId, targetId);
				const updated = await updateTestCase(db, {
					row: existing,
					userId: input.userId,
					canApprove: false,
					request: {
						transcript: item.transcript,
						changeNote: `Import ${batch.id}`,
						...(existing.status === "draft" ? { status: "review" } : {}),
					},
				});
				resultId = updated.id;
				counts.updated += 1;
			} else if (item.decision === "update" || item.decision === "merge") {
				throw new Error("No existing case to update");
			} else {
				const created = await createTestCase(db, {
					orgId: input.orgId,
					userId: input.userId,
					transcript: item.transcript,
					status: "review",
					environmentId: options.environmentId ?? undefined,
					source:
						batch.sourceKind === "jira" || batch.sourceKind === "ai-generation"
							? "ai"
							: "import",
					sourceRef: batch.id,
					changeNote: `Import ${batch.id}`,
				});
				resultId = created.id;
				counts.created += 1;
			}
			await db
				.update(testImportItems)
				.set({
					state: "committed",
					resultTestCaseId: resultId,
					error: null,
					updatedAt: Date.now(),
				})
				.where(eq(testImportItems.id, item.id));
		} catch (error) {
			counts.errors += 1;
			await db
				.update(testImportItems)
				.set({
					state: "error",
					error: error instanceof Error ? error.message : "Commit failed",
					updatedAt: Date.now(),
				})
				.where(eq(testImportItems.id, item.id));
		}
	}
	const now = Date.now();
	const [done] = await db
		.update(testImportBatches)
		.set({
			status: "done",
			...counts,
			updatedAt: now,
			finishedAt: now,
		})
		.where(eq(testImportBatches.id, batch.id))
		.returning();
	await emitNotification(db, {
		orgId: input.orgId,
		kind: "import.finished",
		subjectType: "test_import_batch",
		subjectId: batch.id,
		actorId: input.userId,
		recipients: [batch.createdBy, input.userId],
		payload: { sourceKind: batch.sourceKind, ...counts },
	});
	if (counts.created + counts.updated > 0) {
		await emitReviewPendingCount(db, input.orgId, input.userId);
	}
	return { batch: done ?? batch, committed: true };
};
