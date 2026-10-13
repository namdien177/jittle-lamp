import {
	apiCacheReadResponseSchema,
	apiCacheWriteRequestSchema,
	assertCheckSchema,
	cacheCheckReadResponseSchema,
	cacheCheckWriteRequestSchema,
	cacheEntryReadResponseSchema,
	cacheEntryWriteRequestSchema,
	finalizeTestRunRequestSchema,
	recentOutputsResponseSchema,
	testRunBatchSchema,
	testRunConfigSchema,
	testRunDetailSchema,
	testRunListResponseSchema,
	testRunProgressRequestSchema,
	testRunProgressResponseSchema,
	testRunStatusSchema,
} from "@jittle-lamp/shared";
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { Elysia } from "elysia";
import type { Logger } from "pino";
import { z } from "zod/v4";

// A [Query] step's SQL script (roadmap 2026-10-13 §5.2 tier 1): `kind: "sql"` rows keyed by
// `sql:<stepId>`, one active row per step and environment.
const sqlScriptSchema = z.object({
	sqlText: z.string().min(1),
	params: z.array(z.string()).default([]),
	binding: z.string().nullable().default(null),
	instructionKey: z.string().nullable().default(null),
});
const sqlStepParams = z.object({
	id: z.string().min(1),
	stepId: z.string().min(1),
});
const sqlKeyHash = (stepId: string) => `sql:${stepId}`;

import type { RuntimeConfig } from "../config/runtime";
import { testRunBatches, testRuns, testStepScripts } from "../db/schema";
import {
	HttpError,
	handleTestRoute,
	normalizeQuery,
	parseInput,
	readBearer,
	requireDb,
	requireTestPermission,
	resolveTestActor,
	respond,
} from "../http/test-http";
import type { ClerkAuthPlugin } from "../plugins/clerk-auth";
import type { ArtifactStorage } from "../services/artifact-storage";
import { getRequestIpAddress } from "../services/organization-activity";
import { verifyWorkerToken } from "../services/runner-pools";
import type { StorageRegistry } from "../services/storage-registry";
import {
	findActiveApiScript,
	parseApiScript,
	staleApiScript,
	writeApiScript,
} from "../services/test-api-scripts";
import { testCasePolicy } from "../services/test-case-policy";
import { getTestCaseRow } from "../services/test-cases";
import { createTestSecrets, type KeyProvider } from "../services/test-config";
import type { LiveHub } from "../services/test-live";
import {
	MAX_RUN_EVIDENCE_ZIP_BYTES,
	storeRunEvidence,
} from "../services/test-run-evidence";
import { finalizeRun } from "../services/test-run-finalize";
import { recentCaseOutputs } from "../services/test-run-outputs";
import {
	ACTIVE_RUN_STATUSES,
	cancelRun,
	getRunRow,
	issueRunToken,
	RUN_LEASE_MS,
	recordProgress,
	toBatch,
	toRunDetail,
	toRunSummary,
	verifyRunToken,
} from "../services/test-runs";
import { resolveRunConfig } from "../services/test-settings";
import type { BackendDb } from "../services/user-provisioning";

type Ctx = {
	db: BackendDb | null;
	request: Request;
	requestId: string;
	requestLogger: Logger;
	runtime: RuntimeConfig;
	keyProvider: KeyProvider;
	artifactStorage: ArtifactStorage;
	storageRegistry: StorageRegistry;
	set: { status?: number | string; headers: Record<string, unknown> };
};

const runParams = z.object({ id: z.string().min(1) });

// A step script belongs to the environment it was recorded in (design.md §9.5); scripts with no
// environment apply everywhere. Another environment's script is never replayed or staled.
const scriptEnvironmentScope = (environmentId: string | null) =>
	environmentId
		? or(
				eq(testStepScripts.environmentId, environmentId),
				isNull(testStepScripts.environmentId),
			)
		: isNull(testStepScripts.environmentId);

const runFromToken = async (ctx: Ctx & { params: unknown }) => {
	const db = requireDb(ctx.db);
	const { id } = parseInput(runParams, ctx.params);
	const run = await verifyRunToken(db, {
		runId: id,
		token: readBearer(ctx.request),
	});
	return { db, run };
};

export const createTestRunRoutes = (auth: ClerkAuthPlugin, liveHub?: LiveHub) =>
	new Elysia({ name: "test-run-routes" })
		.use(auth)
		.get("/test-runs", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx, { automation: true });
				await requireTestPermission(db, who, "test_run.view");
				const query = parseInput(
					z.object({
						batchId: z.string().optional(),
						testCaseId: z.string().optional(),
						status: z.array(testRunStatusSchema).optional(),
						mine: z.boolean().optional(),
						limit: z.number().int().min(1).max(200).default(50),
						cursor: z.string().optional(),
					}),
					normalizeQuery(ctx.request.url, new Set(["status"])),
				);
				const before = query.cursor ? Number(query.cursor) : null;
				let batchRunIds: string[] | null = null;
				if (query.batchId) {
					const batch = await toBatch(db, query.batchId, who.orgId);
					batchRunIds = batch.runIds;
				}
				const runs = await db.query.testRuns.findMany({
					where: and(
						eq(testRuns.orgId, who.orgId),
						batchRunIds
							? or(
									inArray(testRuns.id, batchRunIds),
									eq(testRuns.batchId, query.batchId ?? ""),
								)
							: undefined,
						query.testCaseId
							? eq(testRuns.testCaseId, query.testCaseId)
							: undefined,
						query.status?.length
							? inArray(testRuns.status, query.status)
							: undefined,
						query.mine ? eq(testRuns.createdBy, who.userId) : undefined,
						before !== null && Number.isFinite(before)
							? lt(testRuns.queuedAt, before)
							: undefined,
					),
					orderBy: [desc(testRuns.queuedAt), desc(testRuns.id)],
					limit: query.limit + 1,
				});
				const page = runs.slice(0, query.limit);
				const items = [];
				for (const run of page) items.push(await toRunSummary(db, run));
				return respond(testRunListResponseSchema, {
					items,
					nextCursor:
						runs.length > query.limit
							? String(page[page.length - 1]?.queuedAt ?? "")
							: null,
				});
			}),
		)
		.get("/test-run-batches/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx, { automation: true });
				await requireTestPermission(db, who, "test_run.view");
				const { id } = parseInput(runParams, ctx.params);
				const batch = await db.query.testRunBatches.findFirst({
					where: and(
						eq(testRunBatches.id, id),
						eq(testRunBatches.orgId, who.orgId),
					),
					columns: { id: true },
				});
				if (!batch) {
					throw new HttpError(
						404,
						"TEST_RUN_BATCH_NOT_FOUND",
						"Run batch not found",
					);
				}
				return respond(
					testRunBatchSchema,
					await toBatch(db, batch.id, who.orgId),
				);
			}),
		)
		.get("/test-runs/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx, { automation: true });
				await requireTestPermission(db, who, "test_run.view");
				const { id } = parseInput(runParams, ctx.params);
				const run = await getRunRow(db, who.orgId, id);
				return respond(
					testRunDetailSchema,
					await toRunDetail(db, ctx.storageRegistry, run, Date.now(), liveHub),
				);
			}),
		)
		.post("/test-runs/:id/cancel", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx, { automation: true });
				await requireTestPermission(db, who, "test_run.view");
				const { id } = parseInput(runParams, ctx.params);
				const run = await getRunRow(db, who.orgId, id);
				const result = await cancelRun(db, {
					run,
					userId: who.userId,
					canCancel: await testCasePolicy.canCancelRun(
						db,
						{ organizationId: who.orgId, userId: who.userId },
						run,
					),
				});
				const current = await getRunRow(db, who.orgId, id);
				return { runId: id, status: current.status, ...result };
			}),
		)
		// --- Runner side: authenticated by the per-run token or the worker token -------------
		.post("/test-runs/:id/config-token", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const { worker } = await verifyWorkerToken(db, readBearer(ctx.request));
				const { id } = parseInput(runParams, ctx.params);
				const run = await db.query.testRuns.findFirst({
					where: and(
						eq(testRuns.id, id),
						eq(testRuns.workerLeaseOwner, worker.id),
						inArray(testRuns.status, [...ACTIVE_RUN_STATUSES]),
					),
				});
				if (!run) {
					throw new HttpError(
						404,
						"TEST_RUN_NOT_CLAIMED",
						"This worker does not hold a lease on the run",
					);
				}
				const expiresAt = run.workerLeaseExpiresAt ?? Date.now() + RUN_LEASE_MS;
				return {
					runToken: await issueRunToken(db, run.id, expiresAt),
					expiresAt,
				};
			}),
		)
		.get("/test-runs/:id/config", (ctx) =>
			handleTestRoute(ctx, async () => {
				const { db, run } = await runFromToken(ctx);
				return respond(
					testRunConfigSchema,
					await resolveRunConfig(
						db,
						createTestSecrets({ db, keyProvider: ctx.keyProvider }),
						{ run, ipAddress: getRequestIpAddress(ctx.request) },
					),
				);
			}),
		)
		.patch("/test-runs/:id/progress", (ctx) =>
			handleTestRoute(ctx, async () => {
				const { db, run } = await runFromToken(ctx);
				const body = parseInput(testRunProgressRequestSchema, ctx.body);
				return respond(
					testRunProgressResponseSchema,
					await recordProgress(db, ctx.artifactStorage, run, body),
				);
			}),
		)
		.post("/test-runs/:id/finalize", (ctx) =>
			handleTestRoute(ctx, async () => {
				const { db, run } = await runFromToken(ctx);
				const body = parseInput(finalizeTestRunRequestSchema, ctx.body);
				const result = await finalizeRun(db, { run, request: body });
				liveHub?.clear(run.id);
				return respond(
					testRunDetailSchema,
					await toRunDetail(db, ctx.storageRegistry, result.run),
				);
			}),
		)
		.post("/test-runs/:id/evidence", (ctx) =>
			handleTestRoute(ctx, async () => {
				const { db, run } = await runFromToken(ctx);
				const contentType = ctx.request.headers.get("content-type") ?? "";
				if (!contentType.toLowerCase().includes("application/zip")) {
					throw new HttpError(
						415,
						"TEST_RUN_EVIDENCE_CONTENT_TYPE_INVALID",
						"Upload content-type must be application/zip",
					);
				}
				const declared = Number.parseInt(
					ctx.request.headers.get("content-length") ?? "",
					10,
				);
				if (
					Number.isFinite(declared) &&
					declared > MAX_RUN_EVIDENCE_ZIP_BYTES
				) {
					throw new HttpError(
						413,
						"TEST_RUN_EVIDENCE_TOO_LARGE",
						"Run evidence ZIP must be 64 MB or smaller",
					);
				}
				const bytes =
					ctx.body instanceof ArrayBuffer
						? new Uint8Array(ctx.body)
						: ctx.body instanceof Uint8Array
							? ctx.body
							: new Uint8Array(await ctx.request.arrayBuffer());
				if (bytes.byteLength > MAX_RUN_EVIDENCE_ZIP_BYTES) {
					throw new HttpError(
						413,
						"TEST_RUN_EVIDENCE_TOO_LARGE",
						"Run evidence ZIP must be 64 MB or smaller",
					);
				}
				const result = await storeRunEvidence(db, ctx.storageRegistry, {
					run,
					zip: bytes,
				});
				ctx.set.status = result.existing ? 200 : 201;
				return { evidenceId: result.evidenceId };
			}),
		)
		// API scripts (roadmap §2.3, §2.4): read before the run, write after a passed step, mark
		// stale on hand-off. Same token, cache-mode and environment rules as UI scripts.
		.get("/test-runs/:id/cache/api/:stepId", (ctx) =>
			handleTestRoute(ctx, async () => {
				const { db, run } = await runFromToken(ctx);
				const stepId = String(ctx.params.stepId);
				if (run.cacheMode === "off") {
					return respond(apiCacheReadResponseSchema, { status: "miss" });
				}
				const script = await findActiveApiScript(db, {
					testCaseId: run.testCaseId,
					stepId,
					environmentId: run.environmentId,
				});
				const parsed = script ? parseApiScript(script) : null;
				if (!script || !parsed) {
					return respond(apiCacheReadResponseSchema, { status: "miss" });
				}
				return respond(apiCacheReadResponseSchema, {
					status: "hit",
					script: parsed,
					scriptId: script.id,
					version: script.version,
				});
			}),
		)
		.put("/test-runs/:id/cache/api/:stepId", (ctx) =>
			handleTestRoute(ctx, async () => {
				const { db, run } = await runFromToken(ctx);
				const stepId = String(ctx.params.stepId);
				const body = parseInput(apiCacheWriteRequestSchema, ctx.body);
				if ("stale" in body) {
					const staled = await staleApiScript(db, run, stepId, body.reason);
					return { ok: true, staled };
				}
				if (run.cacheMode !== "read-write") {
					throw new HttpError(
						409,
						"TEST_RUN_CACHE_READ_ONLY",
						`Cache mode ${run.cacheMode} does not record scripts`,
					);
				}
				if (body.script.stepId !== stepId) {
					throw new HttpError(
						422,
						"TEST_RUN_API_SCRIPT_STEP_MISMATCH",
						"The script names another step",
					);
				}
				const written = await writeApiScript(db, run, body.script);
				return { ok: true, scriptId: written?.id ?? null };
			}),
		)
		// --- Assert checks (roadmap 2026-10-13 §4.1): kind `assert-check`, keyed by step id -----
		.get("/test-runs/:id/cache/check/:stepId", (ctx) =>
			handleTestRoute(ctx, async () => {
				const { db, run } = await runFromToken(ctx);
				const stepId = String(ctx.params.stepId);
				if (run.cacheMode === "off") {
					return respond(cacheCheckReadResponseSchema, { status: "miss" });
				}
				const scripts = await db.query.testStepScripts.findMany({
					where: and(
						eq(testStepScripts.testCaseId, run.testCaseId),
						eq(testStepScripts.kind, "assert-check"),
						eq(testStepScripts.stepId, stepId),
						eq(testStepScripts.status, "active"),
						scriptEnvironmentScope(run.environmentId),
					),
					orderBy: desc(testStepScripts.version),
				});
				const script =
					scripts.find((entry) => entry.environmentId === run.environmentId) ??
					scripts.find((entry) => entry.environmentId === null);
				const check = assertCheckSchema.safeParse(
					JSON.parse(script?.checkJson ?? "null"),
				);
				// A row whose check no longer parses is as good as none.
				if (!check.success) {
					return respond(cacheCheckReadResponseSchema, { status: "miss" });
				}
				return respond(cacheCheckReadResponseSchema, {
					status: "hit",
					check: check.data,
				});
			}),
		)
		.put("/test-runs/:id/cache/check/:stepId", (ctx) =>
			handleTestRoute(ctx, async () => {
				const { db, run } = await runFromToken(ctx);
				const stepId = String(ctx.params.stepId);
				const body = parseInput(cacheCheckWriteRequestSchema, ctx.body);
				const now = Date.now();
				// A check that stopped holding goes stale in every mode that replays it.
				if ("stale" in body) {
					if (run.cacheMode === "off") {
						throw new HttpError(
							409,
							"TEST_RUN_CACHE_READ_ONLY",
							"Cache mode off replays no checks",
						);
					}
					const stale = await db
						.update(testStepScripts)
						.set({
							status: "stale",
							staleReason: body.reason.slice(0, 2000),
							updatedAt: now,
						})
						.where(
							and(
								eq(testStepScripts.testCaseId, run.testCaseId),
								eq(testStepScripts.kind, "assert-check"),
								eq(testStepScripts.stepId, stepId),
								eq(testStepScripts.status, "active"),
								scriptEnvironmentScope(run.environmentId),
							),
						)
						.returning({ id: testStepScripts.id });
					return { ok: true, stale: stale.length };
				}
				if (run.cacheMode !== "read-write") {
					throw new HttpError(
						409,
						"TEST_RUN_CACHE_READ_ONLY",
						`Cache mode ${run.cacheMode} does not record checks`,
					);
				}
				// Checks are keyed by kind and step id; the key hash only names the row.
				const keyHash = `check:${stepId}`;
				const previous = await db.query.testStepScripts.findFirst({
					where: and(
						eq(testStepScripts.testCaseId, run.testCaseId),
						eq(testStepScripts.kind, "assert-check"),
						eq(testStepScripts.stepId, stepId),
					),
					orderBy: desc(testStepScripts.version),
				});
				await db
					.update(testStepScripts)
					.set({
						status: "stale",
						staleReason: `re-recorded on run ${run.id}`,
						updatedAt: now,
					})
					.where(
						and(
							eq(testStepScripts.testCaseId, run.testCaseId),
							eq(testStepScripts.kind, "assert-check"),
							eq(testStepScripts.stepId, stepId),
							eq(testStepScripts.status, "active"),
							scriptEnvironmentScope(run.environmentId),
						),
					);
				await db.insert(testStepScripts).values({
					orgId: run.orgId,
					testCaseId: run.testCaseId,
					stepId,
					stepIdsJson: JSON.stringify([stepId]),
					instructionKey: body.instructionKey,
					environmentId: run.environmentId,
					keyHash,
					kind: "assert-check",
					entryJson: "null",
					checkJson: JSON.stringify(body.check),
					version: (previous?.version ?? 0) + 1,
					renderedCode: body.renderedCode,
					recordedFromRunId: run.id,
					status: "active",
					createdAt: now,
					updatedAt: now,
				});
				return { ok: true };
			}),
		)
		.get("/test-runs/:id/cache/sql/:stepId", (ctx) =>
			handleTestRoute(ctx, async () => {
				const { db, run } = await runFromToken(ctx);
				const { stepId } = parseInput(sqlStepParams, ctx.params);
				if (run.cacheMode === "off") return { status: "miss" };
				const scripts = await db.query.testStepScripts.findMany({
					where: and(
						eq(testStepScripts.testCaseId, run.testCaseId),
						eq(testStepScripts.keyHash, sqlKeyHash(stepId)),
						eq(testStepScripts.kind, "sql"),
						eq(testStepScripts.status, "active"),
						scriptEnvironmentScope(run.environmentId),
					),
					orderBy: desc(testStepScripts.version),
				});
				const script =
					scripts.find((entry) => entry.environmentId === run.environmentId) ??
					scripts.find((entry) => entry.environmentId === null);
				if (!script?.sqlText) return { status: "miss" };
				const parsed = sqlScriptSchema.safeParse(JSON.parse(script.entryJson));
				if (!parsed.success) return { status: "miss" };
				return { status: "hit", script: parsed.data };
			}),
		)
		.put("/test-runs/:id/cache/sql/:stepId", (ctx) =>
			handleTestRoute(ctx, async () => {
				const { db, run } = await runFromToken(ctx);
				const { stepId } = parseInput(sqlStepParams, ctx.params);
				if (run.cacheMode !== "read-write") {
					throw new HttpError(
						409,
						"TEST_RUN_CACHE_READ_ONLY",
						`Cache mode ${run.cacheMode} does not record scripts`,
					);
				}
				const body = parseInput(sqlScriptSchema, ctx.body);
				const keyHash = sqlKeyHash(stepId);
				const now = Date.now();
				const previous = await db.query.testStepScripts.findFirst({
					where: and(
						eq(testStepScripts.testCaseId, run.testCaseId),
						eq(testStepScripts.keyHash, keyHash),
					),
					orderBy: desc(testStepScripts.version),
				});
				await db
					.update(testStepScripts)
					.set({
						status: "stale",
						staleReason: `re-recorded on run ${run.id}`,
						updatedAt: now,
					})
					.where(
						and(
							eq(testStepScripts.testCaseId, run.testCaseId),
							eq(testStepScripts.keyHash, keyHash),
							eq(testStepScripts.status, "active"),
							scriptEnvironmentScope(run.environmentId),
						),
					);
				await db.insert(testStepScripts).values({
					orgId: run.orgId,
					testCaseId: run.testCaseId,
					stepId,
					stepIdsJson: JSON.stringify([stepId]),
					instructionKey: body.instructionKey,
					environmentId: run.environmentId,
					keyHash,
					kind: "sql",
					entryJson: JSON.stringify(body),
					sqlText: body.sqlText,
					version: (previous?.version ?? 0) + 1,
					renderedCode: body.sqlText,
					recordedFromRunId: run.id,
					status: "active",
					createdAt: now,
					updatedAt: now,
				});
				return { ok: true };
			}),
		)
		// A hand-off (no rows, an error, a rejected replay) marks the step's script stale.
		.delete("/test-runs/:id/cache/sql/:stepId", (ctx) =>
			handleTestRoute(ctx, async () => {
				const { db, run } = await runFromToken(ctx);
				const { stepId } = parseInput(sqlStepParams, ctx.params);
				const body = z
					.object({ reason: z.string().max(500).default("hand-off") })
					.safeParse(ctx.body ?? {});
				await db
					.update(testStepScripts)
					.set({
						status: "stale",
						staleReason: `${body.success ? body.data.reason : "hand-off"} (run ${run.id})`,
						updatedAt: Date.now(),
					})
					.where(
						and(
							eq(testStepScripts.testCaseId, run.testCaseId),
							eq(testStepScripts.keyHash, sqlKeyHash(stepId)),
							eq(testStepScripts.status, "active"),
							scriptEnvironmentScope(run.environmentId),
						),
					);
				return { ok: true };
			}),
		)
		// Reuse window (roadmap §2.6): the runner asks for a used case's recent outputs.
		.get("/test-runs/:id/reuse", (ctx) =>
			handleTestRoute(ctx, async () => {
				const { db, run } = await runFromToken(ctx);
				const query = parseInput(
					z.object({
						caseKey: z.string().min(1),
						paramsHash: z.string().min(1),
						withinMs: z.coerce
							.number()
							.int()
							.positive()
							.max(30 * 86_400_000),
					}),
					normalizeQuery(ctx.request.url, new Set()),
				);
				const used = await getTestCaseRow(db, run.orgId, query.caseKey);
				return respond(
					recentOutputsResponseSchema,
					await recentCaseOutputs(db, {
						orgId: run.orgId,
						testCaseId: used.id,
						environmentId: run.environmentId,
						paramsHash: query.paramsHash,
						withinMs: query.withinMs,
					}),
				);
			}),
		)
		.get("/test-runs/:id/cache/:keyHash", (ctx) =>
			handleTestRoute(ctx, async () => {
				const { db, run } = await runFromToken(ctx);
				const keyHash = String(ctx.params.keyHash);
				if (run.cacheMode === "off") {
					return respond(cacheEntryReadResponseSchema, { status: "miss" });
				}
				const scripts = await db.query.testStepScripts.findMany({
					where: and(
						eq(testStepScripts.testCaseId, run.testCaseId),
						eq(testStepScripts.keyHash, keyHash),
						eq(testStepScripts.status, "active"),
						scriptEnvironmentScope(run.environmentId),
					),
					orderBy: desc(testStepScripts.version),
				});
				const script =
					scripts.find((entry) => entry.environmentId === run.environmentId) ??
					scripts.find((entry) => entry.environmentId === null);
				if (!script) {
					return respond(cacheEntryReadResponseSchema, { status: "miss" });
				}
				return respond(cacheEntryReadResponseSchema, {
					status: "hit",
					entry: JSON.parse(script.entryJson) as unknown,
				});
			}),
		)
		.put("/test-runs/:id/cache/:keyHash", (ctx) =>
			handleTestRoute(ctx, async () => {
				const { db, run } = await runFromToken(ctx);
				const keyHash = String(ctx.params.keyHash);
				if (run.cacheMode !== "read-write") {
					throw new HttpError(
						409,
						"TEST_RUN_CACHE_READ_ONLY",
						`Cache mode ${run.cacheMode} does not record scripts`,
					);
				}
				const body = parseInput(cacheEntryWriteRequestSchema, ctx.body);
				const now = Date.now();
				const previous = await db.query.testStepScripts.findFirst({
					where: and(
						eq(testStepScripts.testCaseId, run.testCaseId),
						eq(testStepScripts.keyHash, keyHash),
					),
					orderBy: desc(testStepScripts.version),
				});
				await db
					.update(testStepScripts)
					.set({
						status: "stale",
						staleReason: `re-recorded on run ${run.id}`,
						updatedAt: now,
					})
					.where(
						and(
							eq(testStepScripts.testCaseId, run.testCaseId),
							eq(testStepScripts.keyHash, keyHash),
							eq(testStepScripts.status, "active"),
							scriptEnvironmentScope(run.environmentId),
						),
					);
				const entry = body.entry as { payload?: { actions?: unknown } } | null;
				await db.insert(testStepScripts).values({
					orgId: run.orgId,
					testCaseId: run.testCaseId,
					stepId: body.stepIds[0] ?? body.instructionKey ?? keyHash,
					stepIdsJson: JSON.stringify(body.stepIds),
					instructionKey: body.instructionKey,
					environmentId: run.environmentId,
					keyHash,
					entryJson: JSON.stringify(body.entry ?? null),
					version: (previous?.version ?? 0) + 1,
					actionsJson:
						entry?.payload?.actions !== undefined
							? JSON.stringify(entry.payload.actions)
							: null,
					renderedCode: body.renderedCode,
					recordedFromRunId: run.id,
					status: "active",
					createdAt: now,
					updatedAt: now,
				});
				return { ok: true };
			}),
		);
