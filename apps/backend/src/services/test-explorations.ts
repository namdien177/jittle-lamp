import {
	type ClaimedExploration,
	type ExplorationConfig,
	type ExplorationRecord,
	type ExplorationResultRequest,
	explorationFallbackTranscript,
	explorationGoal,
	explorationRecordSchema,
	explorationTranscriptPrompt,
	type ImportItemExploration,
	parseTranscriptDocument,
	resolveCredentialAlias,
	serializeTestCase,
	summarizeExploration,
} from "@jittle-lamp/shared";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod/v4";

import {
	testCredentials,
	testEnvironments,
	testExplorations,
	testImportBatches,
	testImportItems,
} from "../db/schema";

import { HttpError, notFound } from "../http/test-http";
import { withBusyRetry } from "./db-busy";
import {
	defaultOutboundPolicy,
	guardedFetch,
	type OutboundPolicy,
} from "./outbound-http";
import { parseJsonColumn } from "./test-cases";
import type { TestSecrets } from "./test-config";
import { extractTranscript } from "./test-import-parsers";
import { analyseCandidate, type TextGenerator } from "./test-imports";
import { type RunnerPoolRow, resolvePoolReference } from "./test-runs";
import { credentialSubject, resolveModelKeys } from "./test-settings";
import type { BackendDb } from "./user-provisioning";

// Explorations (design.md §7 "General instructions"): an import item waits in `pending` while a
// runner of its environment's pool follows the instructions with `e2e explore`; the result is
// written into the item as a transcript and the item goes to review like any other.

export type ExplorationRow = typeof testExplorations.$inferSelect;

export const EXPLORATION_MAX_STEPS = 8;
export const EXPLORATION_TIMEOUT_MS = 10 * 60_000;
// One lease covers the whole exploration plus the conversion; e2e stops itself at the timeout.
export const EXPLORATION_LEASE_MS = EXPLORATION_TIMEOUT_MS + 5 * 60_000;
export const EXPLORATION_MAX_ATTEMPTS = 2;

export const queueExploration = async (
	db: BackendDb,
	input: {
		orgId: string;
		batchId: string;
		itemId: string;
		environmentId: string;
		title: string;
		instructions: string;
		now?: number;
	},
): Promise<ExplorationRow> => {
	const environment = await db.query.testEnvironments.findFirst({
		where: and(
			eq(testEnvironments.id, input.environmentId),
			eq(testEnvironments.orgId, input.orgId),
		),
		columns: { runnerPool: true },
	});
	const pool = environment
		? await resolvePoolReference(db, input.orgId, environment.runnerPool)
		: null;
	const now = input.now ?? Date.now();
	const [row] = await db
		.insert(testExplorations)
		.values({
			orgId: input.orgId,
			batchId: input.batchId,
			itemId: input.itemId,
			environmentId: input.environmentId,
			runnerPool: environment?.runnerPool ?? "cloud",
			runnerPoolId: pool?.id ?? null,
			title: input.title,
			instructions: input.instructions,
			goal: explorationGoal(input),
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	if (!row) throw new Error("Failed to queue exploration");
	return row;
};

// Expired leases go back to the queue; after the last attempt the item is reviewed unexplored.
export const sweepExplorations = async (
	db: BackendDb,
	secrets: TestSecrets,
	now = Date.now(),
) => {
	const expired = await db.query.testExplorations.findMany({
		where: and(
			eq(testExplorations.status, "running"),
			lt(testExplorations.leaseExpiresAt, now),
		),
	});
	for (const row of expired) {
		if (row.attempts >= EXPLORATION_MAX_ATTEMPTS) {
			await completeExploration(db, secrets, {
				row,
				request: {
					status: "failed",
					explore: null,
					error: "The runner stopped responding during the exploration",
				},
				generateText: null,
			});
			continue;
		}
		await db
			.update(testExplorations)
			.set({
				status: "queued",
				workerId: null,
				leaseExpiresAt: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(testExplorations.id, row.id),
					eq(testExplorations.status, "running"),
				),
			);
	}
};

export const claimNextExploration = async (
	db: BackendDb,
	input: { pool: RunnerPoolRow; workerId: string; now?: number },
): Promise<ClaimedExploration | null> => {
	const now = input.now ?? Date.now();
	const leaseExpiresAt = now + EXPLORATION_LEASE_MS;
	const claimed = await withBusyRetry(() =>
		db.all<{ id: string }>(sql`
			update test_explorations set
				status = 'running',
				worker_id = ${input.workerId},
				lease_expires_at = ${leaseExpiresAt},
				attempts = attempts + 1,
				updated_at = ${now}
			where id = (
				select candidate.id from test_explorations candidate
				where candidate.runner_pool_id = ${input.pool.id}
					and candidate.status = 'queued'
				order by candidate.created_at asc, candidate.id asc
				limit 1
			)
			and status = 'queued'
			returning id`),
	);
	const id = claimed[0]?.id;
	if (!id) return null;
	const row = await db.query.testExplorations.findFirst({
		where: eq(testExplorations.id, id),
	});
	if (!row) return null;
	return {
		explorationId: row.id,
		goal: row.goal,
		maxSteps: EXPLORATION_MAX_STEPS,
		timeoutMs: EXPLORATION_TIMEOUT_MS,
		leaseExpiresAt,
	};
};

// Only the worker holding the lease reads the config or posts the result.
export const requireExplorationLease = async (
	db: BackendDb,
	input: { explorationId: string; workerId: string; now?: number },
): Promise<ExplorationRow> => {
	const row = await db.query.testExplorations.findFirst({
		where: eq(testExplorations.id, input.explorationId),
	});
	if (!row) throw notFound("EXPLORATION_NOT_FOUND", "Exploration not found");
	const now = input.now ?? Date.now();
	if (
		row.status !== "running" ||
		row.workerId !== input.workerId ||
		(row.leaseExpiresAt ?? 0) < now
	) {
		throw new HttpError(
			409,
			"EXPLORATION_LEASE_LOST",
			"This worker no longer holds the exploration",
		);
	}
	return row;
};

const mentions = (text: string, name: string) =>
	new RegExp(
		`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`,
		"i",
	).test(text);

// The environment, the model and the login profiles the instructions name (by profile or by a
// unique prefix, as [Login: PCF] does). Nothing else is decrypted.
export const explorationConfig = async (
	db: BackendDb,
	secrets: TestSecrets,
	row: ExplorationRow,
): Promise<ExplorationConfig> => {
	const environment = row.environmentId
		? await db.query.testEnvironments.findFirst({
				where: eq(testEnvironments.id, row.environmentId),
			})
		: null;
	if (!environment) {
		throw new HttpError(
			409,
			"EXPLORATION_ENVIRONMENT_MISSING",
			"The exploration's environment was deleted",
		);
	}
	const rows = (
		await db.query.testCredentials.findMany({
			where: and(
				eq(testCredentials.orgId, row.orgId),
				eq(testCredentials.kind, "login"),
				isNull(testCredentials.deletedAt),
			),
		})
	).filter(
		(credential) =>
			credential.environmentId === null ||
			credential.environmentId === environment.id,
	);
	const profiles = new Set(rows.map((credential) => credential.profile));
	const named = new Set<string>();
	for (const word of row.instructions.match(/[A-Za-z][A-Za-z0-9_]{1,}/g) ??
		[]) {
		const profile = resolveCredentialAlias(word, profiles);
		if (profile && mentions(row.instructions, word)) named.add(profile);
	}
	const credentials: ExplorationConfig["credentials"] = [];
	for (const profile of named) {
		const candidates = rows.filter(
			(credential) => credential.profile === profile,
		);
		const credential =
			candidates.find(
				(candidate) => candidate.environmentId === environment.id,
			) ?? candidates[0];
		if (!credential) continue;
		credentials.push({
			profile,
			fields: parseJsonColumn(
				credential.fieldsJson,
				z.record(z.string(), z.string()),
				{},
			),
			secretFields: credential.secretFieldsEnc
				? await secrets.decrypt(
						row.orgId,
						credentialSubject(credential),
						credential.secretFieldsEnc,
						{
							actorUserId: null,
							runId: null,
							reason: "import.explore",
						},
					)
				: {},
		});
	}
	const model = await resolveModelKeys(db, secrets, {
		orgId: row.orgId,
		actorUserId: null,
		reason: "import.explore",
	});
	return {
		environment: {
			name: environment.name,
			baseUrl: environment.baseUrl,
			variables: parseJsonColumn(
				environment.variablesJson,
				z.record(z.string(), z.string()),
				{},
			),
			agentInstructions: environment.agentInstructions,
			dataLocale: environment.dataLocale,
		},
		credentials,
		model: { act: model.act, judge: model.judge, apiKeys: model.apiKeys },
	};
};

// What the agent did, as a transcript: written by the model, or step by step when the model is
// not available. The title and environment come from the import, not from the model.
const transcriptFromRecord = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: {
		row: ExplorationRow;
		environmentName: string | null;
		record: ExplorationRecord;
		generateText: TextGenerator | null;
		outbound?: OutboundPolicy;
	},
): Promise<{ transcript: string; note: string | null }> => {
	const fallback = () =>
		explorationFallbackTranscript({
			title: input.row.title,
			record: input.record,
			environmentName: input.environmentName,
		});
	if (!input.generateText) return { transcript: fallback(), note: null };
	try {
		const model = await resolveModelKeys(db, secrets, {
			orgId: input.row.orgId,
			actorUserId: null,
			reason: "import.explore.transcript",
		});
		const outbound = input.outbound ?? defaultOutboundPolicy;
		const modelFetch = ((url: string | URL | Request, init?: RequestInit) =>
			guardedFetch(
				fetch,
				outbound,
				url instanceof Request ? url.url : String(url),
				init ?? {},
			)) as typeof fetch;
		const generated = extractTranscript(
			await input.generateText({
				modelId: model.act,
				apiKeys: model.apiKeys,
				fetch: modelFetch,
				prompt: explorationTranscriptPrompt({
					title: input.row.title,
					instructions: input.row.instructions,
					environmentName: input.environmentName,
					record: input.record,
				}),
			}),
		);
		const parsed = parseTranscriptDocument(generated).cases[0];
		if (!parsed || parsed.steps.length === 0) throw new Error("no steps");
		const titled = {
			...parsed,
			title: input.row.title,
			metadata: {
				...parsed.metadata,
				env: input.environmentName ?? parsed.metadata.env,
				tags: [...new Set([...parsed.metadata.tags, "source:exploration"])],
			},
		};
		return {
			transcript: `${serializeTestCase(titled, { forceHeading: true })}\n`,
			note: null,
		};
	} catch (error) {
		return {
			transcript: fallback(),
			note: `The model did not write the transcript (${error instanceof Error ? error.message : "unknown error"}); it lists the explored steps`,
		};
	}
};

export const completeExploration = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: {
		row: ExplorationRow;
		request: ExplorationResultRequest;
		generateText: TextGenerator | null;
		outbound?: OutboundPolicy;
		now?: number;
	},
): Promise<void> => {
	const { row, request } = input;
	const now = input.now ?? Date.now();
	const item = await db.query.testImportItems.findFirst({
		where: eq(testImportItems.id, row.itemId),
	});
	const environment = row.environmentId
		? await db.query.testEnvironments.findFirst({
				where: eq(testEnvironments.id, row.environmentId),
				columns: { name: true },
			})
		: null;
	const explored = request.status === "done" && request.explore !== null;
	let transcript = item?.transcript ?? "";
	let note: string | null = request.error;
	if (explored && request.explore) {
		const written = await transcriptFromRecord(db, secrets, {
			row,
			environmentName: environment?.name ?? null,
			record: request.explore,
			generateText: input.generateText,
			...(input.outbound ? { outbound: input.outbound } : {}),
		});
		transcript = written.transcript;
		note = written.note;
	}
	await db
		.update(testExplorations)
		.set({
			status: explored ? "done" : "failed",
			resultJson: request.explore ? JSON.stringify(request.explore) : null,
			error: note,
			leaseExpiresAt: null,
			finishedAt: now,
			updatedAt: now,
		})
		.where(eq(testExplorations.id, row.id));
	if (item) {
		const analysed = await analyseCandidate(
			db,
			row.orgId,
			{ title: row.title, transcript, externalId: item.externalId },
			row.environmentId,
		);
		await db
			.update(testImportItems)
			.set({
				title: analysed.title,
				transcript: analysed.transcript,
				externalId: analysed.externalId,
				lintJson: JSON.stringify(analysed.lint),
				similarJson: JSON.stringify(analysed.similar),
				parsedJson: analysed.parsedJson,
				decision: analysed.state === "error" ? "skip" : analysed.decision,
				state: analysed.state,
				error: analysed.error,
				resultTestCaseId: analysed.existingId,
				updatedAt: now,
			})
			.where(eq(testImportItems.id, item.id));
	}
	await finishExploredBatch(db, row.batchId, now);
};

// The batch is ready for review once none of its explorations is queued or running.
export const finishExploredBatch = async (
	db: BackendDb,
	batchId: string,
	now = Date.now(),
) => {
	const open = await db.query.testExplorations.findFirst({
		where: and(
			eq(testExplorations.batchId, batchId),
			inArray(testExplorations.status, ["queued", "running"]),
		),
		columns: { id: true },
	});
	if (open) return;
	const items = await db.query.testImportItems.findMany({
		where: eq(testImportItems.batchId, batchId),
		columns: { state: true },
	});
	await db
		.update(testImportBatches)
		.set({
			status: "ready",
			errors: items.filter((item) => item.state === "error").length,
			updatedAt: now,
		})
		.where(
			and(
				eq(testImportBatches.id, batchId),
				eq(testImportBatches.status, "parsing"),
			),
		);
};

export const explorationsForItems = async (
	db: BackendDb,
	itemIds: string[],
): Promise<Map<string, ImportItemExploration>> => {
	if (itemIds.length === 0) return new Map();
	const rows = await db.query.testExplorations.findMany({
		where: inArray(testExplorations.itemId, itemIds),
		orderBy: asc(testExplorations.createdAt),
	});
	const environmentIds = [
		...new Set(
			rows.flatMap((row) => (row.environmentId ? [row.environmentId] : [])),
		),
	];
	const environments = environmentIds.length
		? await db.query.testEnvironments.findMany({
				where: inArray(testEnvironments.id, environmentIds),
				columns: { id: true, name: true },
			})
		: [];
	const names = new Map(
		environments.map((environment) => [environment.id, environment.name]),
	);
	return new Map(
		rows.map((row) => {
			const record = row.resultJson
				? explorationRecordSchema.safeParse(JSON.parse(row.resultJson))
				: null;
			return [
				row.itemId,
				{
					status: row.status,
					environmentName: row.environmentId
						? (names.get(row.environmentId) ?? null)
						: null,
					attempts: row.attempts,
					error: row.error,
					...summarizeExploration(record?.success ? record.data : null),
				},
			];
		}),
	);
};
