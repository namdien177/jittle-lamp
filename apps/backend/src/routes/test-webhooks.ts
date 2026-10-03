import {
	createWebhookEndpointResponseSchema,
	upsertWebhookEndpointRequestSchema,
	webhookDeliverySchema,
	webhookEndpointSchema,
	webhookRuleSchema,
} from "@jittle-lamp/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Elysia } from "elysia";
import type { Logger } from "pino";
import { z } from "zod/v4";

import type { RuntimeConfig } from "../config/runtime";
import { webhookEndpoints } from "../db/schema";
import {
	HttpError,
	handleTestRoute,
	parseInput,
	requireDb,
	requireTestPermission,
	resolveTestActor,
	respond,
} from "../http/test-http";
import type { ClerkAuthPlugin } from "../plugins/clerk-auth";
import {
	getRequestIpAddress,
	recordOrganizationActivity,
} from "../services/organization-activity";
import { createTestSecrets, type KeyProvider } from "../services/test-config";
import {
	createWebhookEndpoint,
	getWebhookEndpointRow,
	handleWebhookDelivery,
	listWebhookDeliveries,
	rotateWebhookSecret,
	toWebhookEndpoint,
	validateRules,
	WEBHOOK_MAX_BODY_BYTES,
} from "../services/test-webhooks";
import type { BackendDb } from "../services/user-provisioning";

// CI webhooks (design.md §10c): endpoint settings for test_config.manage, and the signed inbound
// POST /hooks/:endpointId that providers call without a session.

type Ctx = {
	db: BackendDb | null;
	request: Request;
	requestId: string;
	requestLogger: Logger;
	runtime: RuntimeConfig;
	keyProvider: KeyProvider;
	set: { status?: number | string; headers: Record<string, unknown> };
};

const idParams = z.object({ id: z.string().min(1) });

const apiOrigin = (ctx: Pick<Ctx, "runtime" | "request">) =>
	ctx.runtime.apiOrigin ?? new URL(ctx.request.url).origin;

const patchSchema = z.object({
	rules: z.array(webhookRuleSchema).min(1).optional(),
	enabled: z.boolean().optional(),
});

export const createTestWebhookRoutes = (
	auth: ClerkAuthPlugin,
	options: { fetchImpl?: typeof fetch } = {},
) =>
	new Elysia({ name: "test-webhook-routes" })
		.use(auth)
		.get("/test-webhooks", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const rows = await db.query.webhookEndpoints.findMany({
					where: and(
						eq(webhookEndpoints.orgId, who.orgId),
						isNull(webhookEndpoints.deletedAt),
					),
					orderBy: desc(webhookEndpoints.createdAt),
				});
				return {
					items: rows.map((row) =>
						respond(
							webhookEndpointSchema,
							toWebhookEndpoint(row, apiOrigin(ctx)),
						),
					),
				};
			}),
		)
		.post("/test-webhooks", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const body = parseInput(upsertWebhookEndpointRequestSchema, ctx.body);
				const { row, secret } = await createWebhookEndpoint(
					db,
					createTestSecrets({ db, keyProvider: ctx.keyProvider }),
					{ orgId: who.orgId, userId: who.userId, request: body },
				);
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: "test_config.webhook_created",
					entity: { type: "webhook_endpoint", id: row.id },
					message: `Created a ${row.provider} webhook with ${body.rules.length} rule(s)`,
					ipAddress: getRequestIpAddress(ctx.request),
				});
				ctx.set.status = 201;
				// The secret is shown once; only its ciphertext is stored.
				return respond(createWebhookEndpointResponseSchema, {
					endpoint: toWebhookEndpoint(row, apiOrigin(ctx)),
					secret,
				});
			}),
		)
		.get("/test-webhooks/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(idParams, ctx.params);
				const row = await getWebhookEndpointRow(db, who.orgId, id);
				return respond(
					webhookEndpointSchema,
					toWebhookEndpoint(row, apiOrigin(ctx)),
				);
			}),
		)
		.get("/test-webhooks/:id/deliveries", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(idParams, ctx.params);
				const row = await getWebhookEndpointRow(db, who.orgId, id);
				return {
					items: (await listWebhookDeliveries(db, row.id)).map((item) =>
						respond(webhookDeliverySchema, item),
					),
				};
			}),
		)
		.patch("/test-webhooks/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(idParams, ctx.params);
				const existing = await getWebhookEndpointRow(db, who.orgId, id);
				const body = parseInput(patchSchema, ctx.body);
				if (body.rules) {
					await validateRules(db, who.orgId, existing.provider, body.rules);
				}
				const [row] = await db
					.update(webhookEndpoints)
					.set({
						...(body.rules ? { rulesJson: JSON.stringify(body.rules) } : {}),
						...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
						updatedAt: Date.now(),
					})
					.where(eq(webhookEndpoints.id, existing.id))
					.returning();
				if (!row) throw new Error("Webhook endpoint disappeared");
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: "test_config.webhook_updated",
					entity: { type: "webhook_endpoint", id: row.id },
					message: `Updated a ${row.provider} webhook`,
					metadata: {
						rules: body.rules?.length ?? null,
						enabled: body.enabled ?? null,
					},
				});
				return respond(
					webhookEndpointSchema,
					toWebhookEndpoint(row, apiOrigin(ctx)),
				);
			}),
		)
		.post("/test-webhooks/:id/rotate-secret", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(idParams, ctx.params);
				const existing = await getWebhookEndpointRow(db, who.orgId, id);
				const { row, secret } = await rotateWebhookSecret(
					db,
					createTestSecrets({ db, keyProvider: ctx.keyProvider }),
					existing,
				);
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: "test_config.webhook_secret_rotated",
					entity: { type: "webhook_endpoint", id: row.id },
					message: `Rotated the secret of a ${row.provider} webhook`,
				});
				return respond(createWebhookEndpointResponseSchema, {
					endpoint: toWebhookEndpoint(row, apiOrigin(ctx)),
					secret,
				});
			}),
		)
		.delete("/test-webhooks/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(idParams, ctx.params);
				const existing = await getWebhookEndpointRow(db, who.orgId, id);
				await db
					.update(webhookEndpoints)
					.set({ deletedAt: Date.now(), enabled: false, updatedAt: Date.now() })
					.where(eq(webhookEndpoints.id, existing.id));
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: "test_config.webhook_deleted",
					entity: { type: "webhook_endpoint", id: existing.id },
					message: `Deleted a ${existing.provider} webhook`,
				});
				return { id: existing.id, deleted: true };
			}),
		)
		// Inbound: no session; the signature is the authentication. The raw body is read
		// unparsed because GitHub signs the exact bytes.
		.post("/hooks/:endpointId", { parse: "none" }, (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const endpointId = String(ctx.params.endpointId ?? "");
				const declared = Number.parseInt(
					ctx.request.headers.get("content-length") ?? "",
					10,
				);
				if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BODY_BYTES) {
					throw new HttpError(
						413,
						"WEBHOOK_BODY_TOO_LARGE",
						"Payload too large",
					);
				}
				const raw = new Uint8Array(await ctx.request.arrayBuffer());
				if (raw.byteLength > WEBHOOK_MAX_BODY_BYTES) {
					throw new HttpError(
						413,
						"WEBHOOK_BODY_TOO_LARGE",
						"Payload too large",
					);
				}
				const result = await handleWebhookDelivery(
					{
						db,
						secrets: createTestSecrets({ db, keyProvider: ctx.keyProvider }),
						fetch: options.fetchImpl ?? fetch,
						webOrigin: ctx.runtime.webAppOrigin ?? null,
					},
					{ endpointId, headers: ctx.request.headers, raw },
				);
				ctx.set.status = result.status;
				return result.body;
			}),
		);
