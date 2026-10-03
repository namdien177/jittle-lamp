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
} from "@jittle-lamp/shared";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod/v4";

import { runnerPools } from "../db/schema";
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
	recordHeartbeat,
	registerWorker,
	rotateRegistrationToken,
	toRunnerPool,
	touchWorker,
	verifyWorkerToken,
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
					items: (await listRunnerPools(db, who.orgId)).map((pool) =>
						respond(runnerPoolSchema, pool),
					),
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
					pool: await toRunnerPool(db, created.pool),
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
				const { worker } = await verifyWorkerToken(db, readBearer(ctx.request));
				const body = parseInput(runnerHeartbeatRequestSchema, ctx.body);
				await recordHeartbeat(db, { worker, request: body });
				return { ok: true as const };
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
					await toRunnerPool(db, updated ?? pool),
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
					pool: await toRunnerPool(db, pool),
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
