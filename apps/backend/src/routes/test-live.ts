import {
	type LiveState,
	liveControlResponseSchema,
	liveInputRequestSchema,
	liveStateSchema,
	liveTakeoverRequestSchema,
	runnerInfoSchema,
} from "@jittle-lamp/shared";
import { and, eq, isNull, or } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod/v4";

import { testRuns } from "../db/schema";
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
import { recordOrganizationActivity } from "../services/organization-activity";
import { testCasePolicy } from "../services/test-case-policy";
import { parseJsonColumn } from "../services/test-cases";
import {
	isJpeg,
	LIVE_FRAME_HIDDEN_CONTENT_TYPE,
	LIVE_FRAME_MAX_BYTES,
	LIVE_TAKEOVER_TTL_MS,
	type LiveHub,
	LiveInputQueueFullError,
} from "../services/test-live";
import {
	ACTIVE_RUN_STATUSES,
	getRunRow,
	type TestRunRow,
	verifyRunToken,
} from "../services/test-runs";
import type { BackendDb } from "../services/user-provisioning";

// Live view and take-over routes (contract: packages/shared/src/test-live.ts, design.md §5.4).
// Viewers authenticate with their session and need test_run.view; taking over needs the right
// to cancel the run. The runner side authenticates with the per-run token.

const runParams = z.object({ id: z.string().min(1) });

const isActive = (run: Pick<TestRunRow, "status">) =>
	(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status);

const requireActive = (run: TestRunRow) => {
	if (!isActive(run)) {
		throw new HttpError(
			409,
			"TEST_RUN_NOT_LIVE",
			`The run is ${run.status}; live view is only available while it runs`,
		);
	}
};

const toLiveState = (run: TestRunRow, hub: LiveHub): LiveState => {
	const snapshot = hub.snapshot(run.id);
	const runnerViewport = parseJsonColumn(
		run.runnerInfoJson,
		runnerInfoSchema.nullable(),
		null,
	)?.viewport;
	return respond(liveStateSchema, {
		available: run.liveAvailable && isActive(run),
		takeoverBy: run.liveTakeoverBy,
		paused: run.status === "paused" || run.livePaused,
		frameAt: snapshot.frameAt,
		viewport: snapshot.viewport ?? runnerViewport ?? null,
		framesHidden: snapshot.framesHidden,
	});
};

// Releases a take-over whose holder went quiet (closed tab, lost network) for LIVE_TAKEOVER_TTL_MS;
// the agent resumes. After a restart the holder gets a fresh grace period.
const expireTakeover = async (
	db: BackendDb,
	hub: LiveHub,
	run: TestRunRow,
	now = Date.now(),
): Promise<TestRunRow> => {
	if (run.liveTakeoverBy === null || !isActive(run)) return run;
	const seen = hub.holderSeenAt(run.id);
	if (seen === null) {
		hub.touchHolder(run.id, now);
		return run;
	}
	if (now - seen <= LIVE_TAKEOVER_TTL_MS) return run;
	const [released] = await db
		.update(testRuns)
		.set({ liveTakeoverBy: null, takeoverRequestedAt: null, updatedAt: now })
		.where(
			and(
				eq(testRuns.id, run.id),
				eq(testRuns.liveTakeoverBy, run.liveTakeoverBy),
			),
		)
		.returning();
	if (!released) return run;
	// Input the absent holder left behind is not replayed.
	hub.clearInputs(run.id);
	await recordOrganizationActivity(db, {
		organizationId: run.orgId,
		actorUserId: run.liveTakeoverBy,
		action: "test_run.takeover_expired",
		entity: { type: "test_run", id: run.id },
		message: "Released a take-over after the holder went quiet",
	});
	return released;
};

const readBody = async (body: unknown, request: Request) =>
	body instanceof ArrayBuffer
		? new Uint8Array(body)
		: body instanceof Uint8Array
			? body
			: new Uint8Array(await request.arrayBuffer());

export const createTestLiveRoutes = (auth: ClerkAuthPlugin, hub: LiveHub) =>
	new Elysia({ name: "test-live-routes" })
		.use(auth)
		// --- Viewer side ---------------------------------------------------------------------
		.post("/test-runs/:id/live/watch", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_run.view");
				const { id } = parseInput(runParams, ctx.params);
				const found = await getRunRow(db, who.orgId, id);
				// Watching is the holder's heartbeat (the panel calls it every 10 s).
				if (found.liveTakeoverBy === who.userId) hub.touchHolder(found.id);
				const run = await expireTakeover(db, hub, found);
				if (isActive(run)) hub.watch(run.id);
				return toLiveState(run, hub);
			}),
		)
		.get("/test-runs/:id/live/frame", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_run.view");
				const { id } = parseInput(runParams, ctx.params);
				const run = await getRunRow(db, who.orgId, id);
				const frame = isActive(run) ? hub.frame(run.id) : null;
				if (!frame) {
					throw new HttpError(
						404,
						"LIVE_FRAME_NOT_FOUND",
						"No live frame yet; frames arrive while someone watches",
					);
				}
				const headers: Record<string, string> = {
					"content-type": "image/jpeg",
					"cache-control": "no-store",
					"x-frame-at": String(frame.frameAt),
				};
				if (frame.viewport) {
					headers["x-frame-width"] = String(frame.viewport.width);
					headers["x-frame-height"] = String(frame.viewport.height);
				}
				// After a secret entry the placeholder is served instead of the page.
				if (frame.hidden) headers["x-frame-hidden"] = "secret-entered";
				return new Response(Uint8Array.from(frame.bytes), { headers });
			}),
		)
		.post("/test-runs/:id/live/takeover", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_run.view");
				const { id } = parseInput(runParams, ctx.params);
				const body = parseInput(liveTakeoverRequestSchema, ctx.body);
				const run = await expireTakeover(
					db,
					hub,
					await getRunRow(db, who.orgId, id),
				);
				// The requester of the run, or anyone who may cancel other people's runs.
				const canCancelAny = (
					await testCasePolicy.permissions(db, {
						organizationId: who.orgId,
						userId: who.userId,
					})
				).has("test_run.cancel_any");
				const canTakeOver = run.createdBy === who.userId || canCancelAny;
				const now = Date.now();
				if (body.action === "start") {
					if (!canTakeOver) {
						throw new HttpError(
							403,
							"TEST_PERMISSION_DENIED",
							"Only the requester or someone with test_run.cancel_any can take over this run",
							{ permission: "test_run.cancel_any" },
						);
					}
					requireActive(run);
					if (!run.liveAvailable) {
						throw new HttpError(
							409,
							"LIVE_VIEW_UNAVAILABLE",
							"The runner of this run does not offer live view",
						);
					}
					// One holder at a time; the compare-and-set keeps two starts from both winning.
					const [held] = await db
						.update(testRuns)
						.set({
							liveTakeoverBy: who.userId,
							takeoverRequestedAt: now,
							updatedAt: now,
						})
						.where(
							and(
								eq(testRuns.id, run.id),
								or(
									isNull(testRuns.liveTakeoverBy),
									eq(testRuns.liveTakeoverBy, who.userId),
								),
							),
						)
						.returning();
					if (!held) {
						throw new HttpError(
							409,
							"LIVE_TAKEOVER_HELD",
							"Someone else controls the browser of this run",
							{ takeoverBy: run.liveTakeoverBy },
						);
					}
					// Watching keeps frames flowing while the person drives.
					hub.watch(run.id, now);
					hub.touchHolder(run.id, now);
					// A new take-over never replays input left over from an earlier one. Input
					// sent with a release stays queued until the runner reads it.
					if (run.liveTakeoverBy !== who.userId) hub.clearInputs(run.id);
					if (run.liveTakeoverBy !== who.userId) {
						await recordOrganizationActivity(db, {
							organizationId: who.orgId,
							actorUserId: who.userId,
							action: "test_run.takeover_started",
							entity: { type: "test_run", id: run.id },
							message: "Took over the browser of a test run",
						});
					}
					return toLiveState(held, hub);
				}
				if (run.liveTakeoverBy === null) return toLiveState(run, hub);
				if (run.liveTakeoverBy !== who.userId && !canCancelAny) {
					throw new HttpError(
						403,
						"LIVE_TAKEOVER_NOT_HOLDER",
						"Only the person in control, or someone with test_run.cancel_any, can release the take-over",
					);
				}
				const [released] = await db
					.update(testRuns)
					.set({
						liveTakeoverBy: null,
						takeoverRequestedAt: null,
						updatedAt: now,
					})
					.where(eq(testRuns.id, run.id))
					.returning();
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: "test_run.takeover_ended",
					entity: { type: "test_run", id: run.id },
					message:
						run.liveTakeoverBy === who.userId
							? "Released the browser of a test run"
							: "Ended someone else's take-over of a test run",
				});
				return toLiveState(released ?? run, hub);
			}),
		)
		.post("/test-runs/:id/live/input", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_run.view");
				const { id } = parseInput(runParams, ctx.params);
				const body = parseInput(liveInputRequestSchema, ctx.body);
				const run = await expireTakeover(
					db,
					hub,
					await getRunRow(db, who.orgId, id),
				);
				requireActive(run);
				if (run.liveTakeoverBy !== who.userId) {
					throw new HttpError(
						403,
						"LIVE_TAKEOVER_NOT_HOLDER",
						"Take over the run before sending input",
					);
				}
				try {
					const events = hub.enqueue(run.id, body.events);
					hub.watch(run.id);
					hub.touchHolder(run.id);
					return {
						accepted: events.length,
						lastSeq: events.at(-1)?.seq ?? null,
					};
				} catch (error) {
					if (error instanceof LiveInputQueueFullError) {
						throw new HttpError(
							429,
							"LIVE_INPUT_QUEUE_FULL",
							"The runner has not caught up with earlier input; wait a moment",
							{ pending: error.pending },
							{ "retry-after": "1" },
						);
					}
					throw error;
				}
			}),
		)
		// --- Runner side (per-run token) -----------------------------------------------------
		.get("/test-runs/:id/live/control", (ctx) =>
			handleTestRoute(ctx, async () => {
				const { db, run: found } = await runFromToken(ctx);
				const run = await expireTakeover(db, hub, found);
				const query = parseInput(
					z.object({ after: z.number().int().min(-1).default(-1) }),
					normalizeQuery(ctx.request.url, new Set()),
				);
				if (!run.liveAvailable && isActive(run)) {
					await db
						.update(testRuns)
						.set({ liveAvailable: true })
						.where(eq(testRuns.id, run.id));
				}
				const takeover = run.liveTakeoverBy !== null && isActive(run);
				return respond(liveControlResponseSchema, {
					live: hub.isWatched(run.id) || takeover,
					takeover,
					takeoverBy: takeover ? run.liveTakeoverBy : null,
					inputs: hub.pending(run.id, query.after),
					cancelRequested: run.cancelRequestedAt !== null,
				});
			}),
		)
		.put("/test-runs/:id/live/frame", (ctx) =>
			handleTestRoute(ctx, async () => {
				const { run } = await runFromToken(ctx);
				// The runner stops capturing once a secret was typed and says so; every frame
				// from then on is the placeholder.
				if (
					(ctx.request.headers.get("content-type") ?? "").startsWith(
						LIVE_FRAME_HIDDEN_CONTENT_TYPE,
					)
				) {
					if (isActive(run)) hub.hideFrames(run.id);
					return { ok: true, stored: false, hidden: true };
				}
				const contentType = ctx.request.headers.get("content-type") ?? "";
				if (!contentType.toLowerCase().startsWith("image/jpeg")) {
					throw new HttpError(
						415,
						"LIVE_FRAME_CONTENT_TYPE_INVALID",
						"Live frames must be image/jpeg",
					);
				}
				const declared = Number.parseInt(
					ctx.request.headers.get("content-length") ?? "",
					10,
				);
				if (Number.isFinite(declared) && declared > LIVE_FRAME_MAX_BYTES) {
					throw new HttpError(
						413,
						"LIVE_FRAME_TOO_LARGE",
						"Live frames must be 1 MB or smaller",
					);
				}
				const bytes = await readBody(ctx.body, ctx.request);
				if (bytes.byteLength > LIVE_FRAME_MAX_BYTES) {
					throw new HttpError(
						413,
						"LIVE_FRAME_TOO_LARGE",
						"Live frames must be 1 MB or smaller",
					);
				}
				if (!isJpeg(bytes)) {
					throw new HttpError(
						422,
						"LIVE_FRAME_INVALID",
						"The body is not a JPEG image",
					);
				}
				if (!isActive(run)) return { ok: true, stored: false };
				const runnerViewport =
					parseJsonColumn(run.runnerInfoJson, runnerInfoSchema.nullable(), null)
						?.viewport ?? null;
				const stored = hub.putFrame(run.id, bytes, runnerViewport);
				return { ok: true, stored: true, frameAt: stored.frameAt };
			}),
		);

type RunnerCtx = {
	db: BackendDb | null;
	request: Request;
	params: unknown;
};

const runFromToken = async (ctx: RunnerCtx) => {
	const db = requireDb(ctx.db);
	const { id } = parseInput(runParams, ctx.params);
	const run = await verifyRunToken(db, {
		runId: id,
		token: readBearer(ctx.request),
	});
	return { db, run };
};
