import {
	claimRunResponseSchema,
	createRunnerPoolRequestSchema,
	createRunnerPoolResponseSchema,
	explorationConfigSchema,
	explorationResultRequestSchema,
	registerRunnerRequestSchema,
	registerRunnerResponseSchema,
	runnerHeartbeatRequestSchema,
	runnerPoolSchema,
	runnerUpdateProgressRequestSchema,
} from "@jittle-lamp/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod/v4";

import { runnerPools, runnerWorkers } from "../db/schema";
import {
	HttpError,
	handleTestRoute,
	parseInput,
	readBearer,
	requireAnyTestPermission,
	requireDb,
	requireTestPermission,
	resolveTestActor,
	respond,
} from "../http/test-http";
import type { ClerkAuthPlugin } from "../plugins/clerk-auth";
import { recordOrganizationActivity } from "../services/organization-activity";
import type { OutboundPolicy } from "../services/outbound-http";
import {
	createRunnerPool,
	getRunnerPoolRow,
	listRunnerPools,
	readRunnerUpdateProgress,
	recordHeartbeat,
	registerWorker,
	rotateRegistrationToken,
	runnerUpdateId,
	toRunnerPool,
	touchWorker,
	verifyWorkerToken,
	withRunnerVersion,
	workerCapabilities,
} from "../services/runner-pools";
import { createTestSecrets } from "../services/test-config";
import {
	claimNextExploration,
	completeExploration,
	explorationConfig,
	requireExplorationLease,
	sweepExplorations,
} from "../services/test-explorations";
import {
	defaultTextGenerator,
	type TextGenerator,
} from "../services/test-imports";
import {
	claimNextRun,
	revokeRunnerWorker,
	sweepRunQueue,
} from "../services/test-run-queue";
import { buildClaimedRun } from "../services/test-runs";

const poolParams = z.object({ id: z.string().min(1) });

export type RunnerPoolRouteOptions = {
	// Writes the transcript from an exploration's record.
	generateText?: TextGenerator;
	outbound?: OutboundPolicy;
};

export const createRunnerPoolRoutes = (
	auth: ClerkAuthPlugin,
	options: RunnerPoolRouteOptions = {},
) =>
	new Elysia({ name: "runner-pool-routes" })
		.use(auth)
		.get("/runner-pools", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireAnyTestPermission(
					db,
					who,
					"test_config.manage",
					"test_config.use",
				);
				return {
					items: (await listRunnerPools(db, who.orgId))
						.map((pool) => withRunnerVersion(pool, ctx.runtime.version))
						.map((pool) => respond(runnerPoolSchema, pool)),
				};
			}),
		)
		.post("/runner-pools", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const body = parseInput(createRunnerPoolRequestSchema, ctx.body);
				const created = await createRunnerPool(db, {
					orgId: who.orgId,
					userId: who.userId,
					name: body.name,
					maxConcurrentRuns: body.maxConcurrentRuns,
				});
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: "runner_pool.created",
					entity: { type: "runner_pool", id: created.pool.id },
					message: `Created runner pool ${created.pool.name}`,
				});
				ctx.set.status = 201;
				return respond(createRunnerPoolResponseSchema, {
					pool: withRunnerVersion(
						await toRunnerPool(db, created.pool),
						ctx.runtime.version,
					),
					registrationToken: created.registrationToken,
				});
			}),
		)
		// Static paths before /runner-pools/:id.
		.post("/runner-pools/register", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const body = parseInput(registerRunnerRequestSchema, ctx.body);
				ctx.set.status = 201;
				return respond(
					registerRunnerResponseSchema,
					await registerWorker(db, {
						registrationToken: readBearer(ctx.request),
						request: body,
					}),
				);
			}),
		)
		.post("/runner-pools/heartbeat", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const { worker, pool } = await verifyWorkerToken(
					db,
					readBearer(ctx.request),
				);
				const body = parseInput(runnerHeartbeatRequestSchema, ctx.body);
				await recordHeartbeat(db, { worker, request: body });
				return {
					ok: true as const,
					serverVersion: ctx.runtime.version,
					targetVersion: pool.targetVersion,
					updateId: runnerUpdateId(pool),
				};
			}),
		)
		.post("/runner-pools/claim", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const { worker, pool } = await verifyWorkerToken(
					db,
					readBearer(ctx.request),
				);
				await touchWorker(db, worker);
				// Managed hosts drain before the supervisor replaces their image.
				if (
					pool.targetVersion &&
					pool.targetVersion !== worker.version &&
					workerCapabilities(worker).managedUpdates === true
				) {
					return respond(claimRunResponseSchema, {
						run: null,
						exploration: null,
					});
				}
				// Expired leases go back to the queue before this worker picks.
				await sweepRunQueue(db, Date.now(), { logger: ctx.logger });
				const claimed = await claimNextRun(db, { pool, workerId: worker.id });
				if (claimed) {
					return respond(claimRunResponseSchema, {
						run: await buildClaimedRun(db, claimed.run, claimed.runToken),
						exploration: null,
					});
				}
				// Runs first; an idle worker explores import items of its pool.
				const secrets = createTestSecrets({ db, keyProvider: ctx.keyProvider });
				await sweepExplorations(db, secrets);
				return respond(claimRunResponseSchema, {
					run: null,
					exploration: await claimNextExploration(db, {
						pool,
						workerId: worker.id,
					}),
				});
			}),
		)
		.get("/test-explorations/:id/config", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const { worker } = await verifyWorkerToken(db, readBearer(ctx.request));
				const { id } = parseInput(poolParams, ctx.params);
				const row = await requireExplorationLease(db, {
					explorationId: id,
					workerId: worker.id,
				});
				return respond(
					explorationConfigSchema,
					await explorationConfig(
						db,
						createTestSecrets({ db, keyProvider: ctx.keyProvider }),
						row,
					),
				);
			}),
		)
		.post("/test-explorations/:id/result", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const { worker } = await verifyWorkerToken(db, readBearer(ctx.request));
				const { id } = parseInput(poolParams, ctx.params);
				const body = parseInput(explorationResultRequestSchema, ctx.body);
				const row = await requireExplorationLease(db, {
					explorationId: id,
					workerId: worker.id,
				});
				await completeExploration(
					db,
					createTestSecrets({ db, keyProvider: ctx.keyProvider }),
					{
						row,
						request: body,
						generateText: options.generateText ?? defaultTextGenerator,
						...(options.outbound ? { outbound: options.outbound } : {}),
					},
				);
				return { ok: true };
			}),
		)
		// Worker-scoped update plan; a worker never sees another pool's credentials.
		.get("/runner-pools/update-plan", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const { worker, pool } = await verifyWorkerToken(
					db,
					readBearer(ctx.request),
				);
				const capabilities = workerCapabilities(worker);
				return {
					poolId: pool.id,
					workerId: worker.id,
					serverVersion: ctx.runtime.version,
					targetVersion: pool.targetVersion,
					version: worker.version,
					updatePhase: readRunnerUpdateProgress(pool)?.phase ?? null,
					progressReporting: true,
					updateId: runnerUpdateId(pool),
					ready:
						capabilities.managedUpdates === true &&
						capabilities.drainingVersion === pool.targetVersion &&
						capabilities.drainingUpdateId === runnerUpdateId(pool) &&
						worker.load === 0 &&
						(worker.lastHeartbeatAt ?? 0) > Date.now() - 30_000,
				};
			}),
		)

		.post("/runner-pools/update-progress", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const { worker, pool } = await verifyWorkerToken(
					db,
					readBearer(ctx.request),
				);
				const body = parseInput(runnerUpdateProgressRequestSchema, ctx.body);
				const previous = readRunnerUpdateProgress(pool);
				if (
					pool.kind !== "cloud" ||
					workerCapabilities(worker).managedUpdates !== true
				) {
					throw new HttpError(
						403,
						"RUNNER_UPDATER_REQUIRED",
						"Managed cloud worker required",
					);
				}
				if (
					!previous ||
					body.updateId !== previous.updateId ||
					body.targetVersion !== pool.targetVersion
				) {
					throw new HttpError(
						409,
						"RUNNER_UPDATE_CHANGED",
						"The update was cancelled or replaced",
					);
				}
				if (previous.phase === "completed" && body.phase !== "completed") {
					throw new HttpError(
						409,
						"RUNNER_UPDATE_COMPLETED",
						"This update already completed",
					);
				}
				if (body.phase === "completed") {
					const ids = [...new Set(body.replacementWorkerIds ?? [])];
					const replacements = ids.length
						? await db.query.runnerWorkers.findMany({
								where: and(
									eq(runnerWorkers.poolId, pool.id),
									inArray(runnerWorkers.id, ids),
								),
							})
						: [];
					if (
						!ids.length ||
						replacements.length !== ids.length ||
						replacements.some(
							(item) =>
								item.revokedAt !== null ||
								item.version !== pool.targetVersion ||
								(item.lastHeartbeatAt ?? 0) < Date.now() - 30_000 ||
								workerCapabilities(item).managedUpdates !== true,
						)
					)
						throw new HttpError(
							409,
							"RUNNER_UPDATE_NOT_READY",
							"Waiting for replacement workers to reconnect",
						);
				}
				const { replacementWorkerIds: _ids, ...progress } = body;
				const result = await db
					.update(runnerPools)
					.set({
						updateProgressJson: JSON.stringify({
							...progress,
							startedAt: previous.startedAt,
							reportedAt: Date.now(),
						}),
					})
					.where(
						and(
							eq(runnerPools.id, pool.id),
							eq(runnerPools.updateProgressJson, pool.updateProgressJson ?? ""),
						),
					)
					.returning({ id: runnerPools.id });
				if (!result.length)
					throw new HttpError(
						409,
						"RUNNER_UPDATE_CHANGED",
						"The update changed; fetch the current plan",
					);
				return { ok: true };
			}),
		)
		.post("/runner-pools/:id/update", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(poolParams, ctx.params);
				const { cancel } = parseInput(
					z.object({ cancel: z.boolean().default(false) }),
					ctx.body,
				);
				const pool = await getRunnerPoolRow(db, who.orgId, id);
				if (pool.kind !== "cloud")
					throw new HttpError(
						422,
						"RUNNER_UPDATE_CLOUD_ONLY",
						"Managed updates are available for cloud pools",
					);
				const view = await toRunnerPool(db, pool);
				if (
					!cancel &&
					!view.workers.some(
						(worker) => worker.status === "online" && worker.managedUpdates,
					)
				) {
					throw new HttpError(
						409,
						"RUNNER_UPDATER_REQUIRED",
						"Start the host updater and enable managed updates before requesting an update",
					);
				}
				if (
					!cancel &&
					!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(ctx.runtime.version)
				) {
					throw new HttpError(
						422,
						"RUNNER_VERSION_INVALID",
						"The server version must name a published runner release",
					);
				}
				const previous = readRunnerUpdateProgress(pool);
				if (
					previous &&
					["restarting", "reconnecting"].includes(previous.phase)
				) {
					throw new HttpError(
						409,
						"RUNNER_UPDATE_REPLACING",
						"Workers are restarting; wait for the update to finish",
					);
				}
				const updateId = Math.max(
					Date.now(),
					runnerUpdateId(pool) + 1,
					pool.updatedAt + 1,
				);
				const targetVersion = cancel ? null : ctx.runtime.version;
				const updateProgress = cancel
					? null
					: {
							updateId,
							targetVersion: ctx.runtime.version,
							phase: "draining" as const,
							downloadPercent: null,
							downloadedBytes: null,
							totalBytes: null,
							errorCode: null,
							startedAt: updateId,
							reportedAt: updateId,
						};
				const changed = await db
					.update(runnerPools)
					.set({
						targetVersion,
						updateProgressJson: updateProgress
							? JSON.stringify(updateProgress)
							: null,
						updatedAt: updateId,
					})
					.where(
						and(
							eq(runnerPools.id, pool.id),
							pool.updateProgressJson === null
								? isNull(runnerPools.updateProgressJson)
								: eq(runnerPools.updateProgressJson, pool.updateProgressJson),
						),
					)
					.returning({ id: runnerPools.id });
				if (!changed.length)
					throw new HttpError(
						409,
						"RUNNER_UPDATE_CHANGED",
						"Update progress changed; refresh before trying again",
					);
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: cancel
						? "runner_pool.update_cancelled"
						: "runner_pool.update_requested",
					entity: { type: "runner_pool", id: pool.id },
					message: cancel
						? "Cancelled runner update"
						: `Requested runner update to ${targetVersion}`,
				});
				return respond(
					runnerPoolSchema,
					withRunnerVersion(
						await toRunnerPool(db, {
							...pool,
							targetVersion,
							updatedAt: updateId,
							updateProgressJson: updateProgress
								? JSON.stringify(updateProgress)
								: null,
						}),
						ctx.runtime.version,
					),
				);
			}),
		)
		.patch("/runner-pools/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(poolParams, ctx.params);
				const body = parseInput(
					z.object({
						maxConcurrentRuns: z.number().int().min(1).max(50).optional(),
					}),
					ctx.body,
				);
				const pool = await getRunnerPoolRow(db, who.orgId, id);
				if (pool.kind === "cloud" && body.maxConcurrentRuns !== undefined) {
					// The cloud pool runs at the organisation's max_concurrent_runs (design.md §10.1).
					throw new HttpError(
						422,
						"RUNNER_POOL_CLOUD_CONCURRENCY",
						"The cloud pool's concurrency is the organisation run setting maxConcurrentRuns; change it in the run settings",
						{ setting: "maxConcurrentRuns" },
					);
				}
				const [updated] = await db
					.update(runnerPools)
					.set({
						...(body.maxConcurrentRuns !== undefined
							? { maxConcurrentRuns: body.maxConcurrentRuns }
							: {}),
						updatedAt: Date.now(),
					})
					.where(eq(runnerPools.id, pool.id))
					.returning();
				return respond(
					runnerPoolSchema,
					withRunnerVersion(
						await toRunnerPool(db, updated ?? pool),
						ctx.runtime.version,
					),
				);
			}),
		)
		.post("/runner-pools/:id/registration-token", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(poolParams, ctx.params);
				const pool = await getRunnerPoolRow(db, who.orgId, id);
				const registrationToken = await rotateRegistrationToken(db, pool);
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: "runner_pool.registration_token_rotated",
					entity: { type: "runner_pool", id: pool.id },
					message: `Issued a registration token for runner pool ${pool.name}`,
				});
				return respond(createRunnerPoolResponseSchema, {
					pool: withRunnerVersion(
						await toRunnerPool(db, pool),
						ctx.runtime.version,
					),
					registrationToken,
				});
			}),
		)
		.delete("/runner-pools/:id/workers/:workerId", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id, workerId } = parseInput(
					z.object({ id: z.string().min(1), workerId: z.string().min(1) }),
					ctx.params,
				);
				const pool = await getRunnerPoolRow(db, who.orgId, id);
				const result = await revokeRunnerWorker(db, {
					poolId: pool.id,
					workerId,
				});
				return { revoked: result.revoked };
			}),
		);
