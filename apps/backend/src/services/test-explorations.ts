import {
	type ClaimedExploration,
	type ExplorationConfig,
	type ExplorationOutcome,
	type ExplorationRecord,
	type ExplorationResultRequest,
	explorationDraftTranscript,
	explorationFallbackTranscript,
	explorationGoal,
	explorationOutcome,
	explorationRecordSchema,
	explorationTranscriptPrompt,
	type ImportItemExploration,
	parseTranscriptDocument,
	resolveCredentialAlias,
	serializeTestCase,
	summarizeExploration,
	type TranscriptGrounding,
	transcriptProblems,
} from "@jittle-lamp/shared";
import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod/v4";

import {
	runnerPools,
	runnerWorkers,
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
import { loadLintContext, parseJsonColumn } from "./test-cases";
import type { TestSecrets } from "./test-config";
import { extractTranscript } from "./test-import-parsers";
import { analyseCandidate, type TextGenerator } from "./test-imports";
import {
	type RunnerPoolRow,
	resolvePoolReference,
	WORKER_LIVE_MS,
} from "./test-runs";
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

// Online runners per pool: a worker whose heartbeat is recent and that is not revoked.
export const onlineRunnerCounts = async (
	db: BackendDb,
	poolIds: string[],
	now = Date.now(),
): Promise<Map<string, number>> => {
	if (poolIds.length === 0) return new Map();
	const rows = await db
		.select({ poolId: runnerWorkers.poolId, workers: sql<number>`count(*)` })
		.from(runnerWorkers)
		.where(
			and(
				inArray(runnerWorkers.poolId, poolIds),
				isNull(runnerWorkers.revokedAt),
				gt(runnerWorkers.lastHeartbeatAt, now - WORKER_LIVE_MS),
			),
		)
		.groupBy(runnerWorkers.poolId);
	return new Map(rows.map((row) => [row.poolId, Number(row.workers)]));
};

// Before an explored import: the pool its environment is bound to and whether a runner of it
// is online. A pool that does not exist yet has none.
export const explorationReadiness = async (
	db: BackendDb,
	input: { orgId: string; environmentId: string; now?: number },
): Promise<{ poolName: string; runnersOnline: number }> => {
	const environment = await db.query.testEnvironments.findFirst({
		where: and(
			eq(testEnvironments.id, input.environmentId),
			eq(testEnvironments.orgId, input.orgId),
		),
		columns: { runnerPool: true },
	});
	const reference = environment?.runnerPool ?? "cloud";
	const pool = await resolvePoolReference(db, input.orgId, reference);
	if (!pool) return { poolName: reference, runnersOnline: 0 };
	const online = await onlineRunnerCounts(db, [pool.id], input.now);
	return { poolName: pool.name, runnersOnline: online.get(pool.id) ?? 0 };
};

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

// Login profiles the instructions name, by profile or by a unique prefix as [Login: PCF] does,
// and PROFILE_LIKE names the organisation has no login credential for.
export const profilesNamedIn = (
	instructions: string,
	available: readonly string[],
): { named: Set<string>; missing: string[] } => {
	const profiles = new Set(available);
	const named = new Set<string>();
	const missing = new Set<string>();
	for (const word of instructions.match(/[A-Za-z][A-Za-z0-9_]{1,}/g) ?? []) {
		if (!mentions(instructions, word)) continue;
		const profile = resolveCredentialAlias(word, profiles);
		if (profile) named.add(profile);
		else if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(word)) missing.add(word);
	}
	return { named, missing: [...missing].sort() };
};

// The environment, the model and the login profiles the instructions name. Nothing else is
// decrypted.
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
	const { named, missing } = profilesNamedIn(
		row.instructions,
		rows.map((credential) => credential.profile),
	);
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
		missingProfiles: missing,
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
		sleep?: (ms: number) => Promise<void>;
	},
): Promise<{
	transcript: string;
	note: string | null;
	outcome: ExplorationOutcome;
	reason: string | null;
}> => {
	const { outcome, reason } = explorationOutcome(input.record);
	// A blocked, failed or incomplete exploration proved nothing: keep the instructions as written
	// rather than turn what the agent saw while failing into a test.
	if (outcome !== "passed") {
		return {
			transcript: explorationDraftTranscript({
				title: input.row.title,
				instructions: input.row.instructions,
				environmentName: input.environmentName,
				outcome,
				reason,
			}),
			note: `Exploration ${outcome}${reason ? `: ${reason}` : ""}`,
			outcome,
			reason,
		};
	}
	const fallback = () =>
		explorationFallbackTranscript({
			title: input.row.title,
			record: input.record,
			environmentName: input.environmentName,
		});
	if (!input.generateText)
		return { transcript: fallback(), note: null, outcome, reason };
	const grounding = await explorationGrounding(db, input.row);
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
		const generateText = input.generateText;
		const generated = extractTranscript(
			await withRateLimitRetry(
				() =>
					generateText({
						modelId: model.act,
						apiKeys: model.apiKeys,
						fetch: modelFetch,
						prompt: explorationTranscriptPrompt({
							title: input.row.title,
							instructions: input.row.instructions,
							environmentName: input.environmentName,
							record: input.record,
							grounding,
						}),
					}),
				input.sleep,
			),
		);
		// Only a transcript that runs as written: no unknown macro, no profile the exploration
		// was not given, no parse or lint error.
		const problems = transcriptProblems(generated, grounding);
		if (problems.length > 0) {
			throw new Error(`invalid transcript: ${problems.slice(0, 3).join("; ")}`);
		}
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
			outcome,
			reason,
		};
	} catch (error) {
		return {
			transcript: fallback(),
			note: `The model did not write the transcript (${error instanceof Error ? error.message : "unknown error"}); it lists the explored steps`,
			outcome,
			reason,
		};
	}
};

// What a written transcript may use: the organisation's macros plus the built-in ones, and the
// login profiles the exploration was given.
const explorationGrounding = async (
	db: BackendDb,
	row: ExplorationRow,
): Promise<TranscriptGrounding> => {
	const context = await loadLintContext(db, row.orgId, row.environmentId);
	const credentials = await db.query.testCredentials.findMany({
		where: and(
			eq(testCredentials.orgId, row.orgId),
			eq(testCredentials.kind, "login"),
			isNull(testCredentials.deletedAt),
		),
		columns: { profile: true, environmentId: true },
	});
	const available = credentials
		.filter(
			(credential) =>
				credential.environmentId === null ||
				credential.environmentId === row.environmentId,
		)
		.map((credential) => credential.profile);
	return {
		macros: context.macros,
		profiles: [...profilesNamedIn(row.instructions, available).named],
	};
};

// A rate-limited model call (429) is tried once more after the provider's Retry-After when that
// is short; anything else, or a longer wait, falls through to the step-by-step transcript.
export const RATE_LIMIT_MAX_WAIT_MS = 20_000;

export const retryAfterMs = (error: unknown): number | null => {
	if (!error || typeof error !== "object") return null;
	const record = error as {
		statusCode?: unknown;
		status?: unknown;
		responseHeaders?: Record<string, string | undefined>;
		message?: unknown;
	};
	const status = record.statusCode ?? record.status;
	const message = typeof record.message === "string" ? record.message : "";
	if (
		status !== 429 &&
		!/\b429\b|rate limit|too many requests/i.test(message)
	) {
		return null;
	}
	const header = record.responseHeaders?.["retry-after"];
	if (header !== undefined && /^\d+(\.\d+)?$/.test(header.trim())) {
		return Math.round(Number(header.trim()) * 1000);
	}
	const inText = /retry[\s-]*after[:\s]*(\d+(?:\.\d+)?)\s*(ms|s)?/i.exec(
		message,
	);
	if (inText?.[1]) {
		return Math.round(
			Number(inText[1]) * (inText[2]?.toLowerCase() === "ms" ? 1 : 1000),
		);
	}
	return null;
};

const withRateLimitRetry = async <T>(
	call: () => Promise<T>,
	sleep: (ms: number) => Promise<void> = (ms) =>
		new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> => {
	try {
		return await call();
	} catch (error) {
		const wait = retryAfterMs(error);
		if (wait === null || wait > RATE_LIMIT_MAX_WAIT_MS) throw error;
		await sleep(wait);
		return call();
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
		// "Stop waiting": the user chose to review the instructions unexplored.
		reviewedWithoutExploring?: boolean;
		sleep?: (ms: number) => Promise<void>;
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
	// Why the item is not a test yet, shown on the row; null once a passing exploration wrote it.
	let notWritten: string | null = input.reviewedWithoutExploring
		? null
		: `Not explored${request.error ? `: ${request.error}` : ""}. Review the instructions before creating a case`;
	if (explored && request.explore) {
		const written = await transcriptFromRecord(db, secrets, {
			row,
			environmentName: environment?.name ?? null,
			record: request.explore,
			generateText: input.generateText,
			...(input.outbound ? { outbound: input.outbound } : {}),
			...(input.sleep ? { sleep: input.sleep } : {}),
		});
		transcript = written.transcript;
		note = written.note;
		notWritten =
			written.outcome === "passed"
				? null
				: `Exploration ${written.outcome}${written.reason ? ` at ${written.reason}` : ""}; the instructions were kept, not written as a test`;
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
				// An item the exploration did not prove is skipped unless a reviewer decides otherwise.
				decision:
					analysed.state === "error" || notWritten ? "skip" : analysed.decision,
				state: analysed.state,
				error: analysed.error ?? notWritten,
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
	const poolIds = [
		...new Set(
			rows.flatMap((row) => (row.runnerPoolId ? [row.runnerPoolId] : [])),
		),
	];
	const pools = poolIds.length
		? await db.query.runnerPools.findMany({
				where: inArray(runnerPools.id, poolIds),
				columns: { id: true, name: true },
			})
		: [];
	const poolNames = new Map(pools.map((pool) => [pool.id, pool.name]));
	const online = await onlineRunnerCounts(db, poolIds);
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
					runnerPoolName: row.runnerPoolId
						? (poolNames.get(row.runnerPoolId) ?? row.runnerPool)
						: row.runnerPool,
					// Only a queued item waits on runners; say how many could take it.
					runnersOnline:
						row.status === "queued"
							? row.runnerPoolId
								? (online.get(row.runnerPoolId) ?? 0)
								: 0
							: null,
					attempts: row.attempts,
					error: row.error,
					...summarizeExploration(record?.success ? record.data : null),
				},
			];
		}),
	);
};

export const STOPPED_WAITING =
	"Stopped waiting for a runner; reviewed without exploring";

// "Stop waiting": queued explorations of a batch end without a runner. Their items go to review
// with the instructions as written; explorations a runner already holds carry on.
export const cancelQueuedExplorations = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: { batchId: string; now?: number },
): Promise<number> => {
	const now = input.now ?? Date.now();
	const queued = await db.query.testExplorations.findMany({
		where: and(
			eq(testExplorations.batchId, input.batchId),
			eq(testExplorations.status, "queued"),
		),
	});
	let cancelled = 0;
	for (const row of queued) {
		// Claimed meanwhile: the runner reports it.
		const [won] = await db
			.update(testExplorations)
			.set({ status: "failed", error: STOPPED_WAITING, updatedAt: now })
			.where(
				and(
					eq(testExplorations.id, row.id),
					eq(testExplorations.status, "queued"),
				),
			)
			.returning({ id: testExplorations.id });
		if (!won) continue;
		cancelled += 1;
		await completeExploration(db, secrets, {
			row,
			request: { status: "failed", explore: null, error: STOPPED_WAITING },
			generateText: null,
			now,
			reviewedWithoutExploring: true,
		});
	}
	return cancelled;
};
