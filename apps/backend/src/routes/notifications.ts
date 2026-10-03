import {
	markNotificationsReadRequestSchema,
	notificationChannelSchema,
	notificationListResponseSchema,
	notificationSubscriptionsSchema,
	upsertNotificationChannelRequestSchema,
} from "@jittle-lamp/shared";
import { and, asc, eq, ne } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod/v4";

import { notificationChannels } from "../db/schema";
import {
	HttpError,
	handleTestRoute,
	normalizeQuery,
	parseInput,
	requireDb,
	requireTestPermission,
	resolveTestActor,
	respond,
} from "../http/test-http";
import type { ClerkAuthPlugin } from "../plugins/clerk-auth";
import {
	getChannelRow,
	normalizeChannelConfig,
	toNotificationChannel,
} from "../services/notification-channels";
import {
	getNotificationSubscriptions,
	listInAppNotifications,
	markNotificationsRead,
	notificationAdapterFor,
	saveNotificationSubscriptions,
} from "../services/notifications";
import { recordOrganizationActivity } from "../services/organization-activity";

const idParams = z.object({ id: z.string().min(1) });

// In-app notification channel (design.md §10b): the bell in the web and desktop apps.
export const createNotificationRoutes = (auth: ClerkAuthPlugin) =>
	new Elysia({ name: "notification-routes" })
		.use(auth)
		.get("/notifications", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				const query = parseInput(
					z.object({
						limit: z.number().int().min(1).max(200).default(50),
						unreadOnly: z.boolean().default(false),
					}),
					normalizeQuery(ctx.request.url, new Set()),
				);
				return respond(
					notificationListResponseSchema,
					await listInAppNotifications(db, {
						orgId: who.orgId,
						userId: who.userId,
						...query,
					}),
				);
			}),
		)
		.post("/notifications/read", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				const body = parseInput(markNotificationsReadRequestSchema, ctx.body);
				await markNotificationsRead(db, {
					orgId: who.orgId,
					userId: who.userId,
					ids: body.ids,
					all: body.all,
				});
				const { unread } = await listInAppNotifications(db, {
					orgId: who.orgId,
					userId: who.userId,
					limit: 1,
					unreadOnly: true,
				});
				return { unread };
			}),
		)
		.post("/notifications/read-all", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await markNotificationsRead(db, {
					orgId: who.orgId,
					userId: who.userId,
					ids: [],
					all: true,
				});
				return { unread: 0 };
			}),
		)
		.post("/notifications/:id/read", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				const { id } = parseInput(
					z.object({ id: z.string().min(1) }),
					ctx.params,
				);
				await markNotificationsRead(db, {
					orgId: who.orgId,
					userId: who.userId,
					ids: [id],
					all: false,
				});
				const { unread } = await listInAppNotifications(db, {
					orgId: who.orgId,
					userId: who.userId,
					limit: 1,
					unreadOnly: true,
				});
				return { unread };
			}),
		)
		.get("/notifications/subscriptions", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				return respond(
					notificationSubscriptionsSchema,
					await getNotificationSubscriptions(db, who.orgId, who.userId),
				);
			}),
		)
		.put("/notifications/subscriptions", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				const body = parseInput(notificationSubscriptionsSchema, ctx.body);
				await saveNotificationSubscriptions(db, {
					orgId: who.orgId,
					userId: who.userId,
					...body,
				});
				return respond(
					notificationSubscriptionsSchema,
					await getNotificationSubscriptions(db, who.orgId, who.userId),
				);
			}),
		)
		// --- Channels: Slack and outgoing webhooks (design.md §10b, unit 2.2) ---------------
		.get("/notification-channels", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const rows = await db.query.notificationChannels.findMany({
					where: and(
						eq(notificationChannels.orgId, who.orgId),
						ne(notificationChannels.kind, "in_app"),
					),
					orderBy: asc(notificationChannels.createdAt),
				});
				return {
					items: rows.map((row) =>
						respond(notificationChannelSchema, toNotificationChannel(row)),
					),
				};
			}),
		)
		.post("/notification-channels", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const body = parseInput(
					upsertNotificationChannelRequestSchema,
					ctx.body,
				);
				const config = await normalizeChannelConfig(db, who.orgId, body);
				const [row] = await db
					.insert(notificationChannels)
					.values({
						orgId: who.orgId,
						kind: body.kind,
						configJson: JSON.stringify(config),
						filterJson: JSON.stringify(body.filter),
						enabled: body.enabled,
						createdBy: who.userId,
					})
					.returning();
				if (!row) throw new Error("Failed to create notification channel");
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: "test_config.notification_channel_created",
					entity: { type: "notification_channel", id: row.id },
					message: `Added a ${row.kind} notification channel`,
				});
				ctx.set.status = 201;
				return respond(notificationChannelSchema, toNotificationChannel(row));
			}),
		)
		.patch("/notification-channels/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(idParams, ctx.params);
				const existing = await getChannelRow(db, who.orgId, id);
				if (existing.kind !== "slack" && existing.kind !== "webhook") {
					throw new HttpError(
						409,
						"NOTIFICATION_CHANNEL_READ_ONLY",
						"Only Slack and webhook channels can be edited",
					);
				}
				const current = toNotificationChannel(existing);
				const body = parseInput(upsertNotificationChannelRequestSchema, {
					kind: existing.kind,
					config: current.config,
					filter: current.filter,
					enabled: current.enabled,
					...(ctx.body as Record<string, unknown> | null),
				});
				if (body.kind !== existing.kind) {
					throw new HttpError(
						422,
						"VALIDATION",
						"kind: a channel keeps its kind; add a new channel instead",
					);
				}
				const config = await normalizeChannelConfig(db, who.orgId, body);
				const [row] = await db
					.update(notificationChannels)
					.set({
						configJson: JSON.stringify(config),
						filterJson: JSON.stringify(body.filter),
						enabled: body.enabled,
						updatedAt: Date.now(),
					})
					.where(eq(notificationChannels.id, existing.id))
					.returning();
				if (!row) throw new Error("Notification channel disappeared");
				return respond(notificationChannelSchema, toNotificationChannel(row));
			}),
		)
		.delete("/notification-channels/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(idParams, ctx.params);
				const existing = await getChannelRow(db, who.orgId, id);
				await db
					.delete(notificationChannels)
					.where(eq(notificationChannels.id, existing.id));
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: "test_config.notification_channel_deleted",
					entity: { type: "notification_channel", id: existing.id },
					message: `Removed a ${existing.kind} notification channel`,
				});
				return { id: existing.id, deleted: true };
			}),
		)
		// Sends a sample run.finished message through the channel; nothing is stored.
		.post("/notification-channels/:id/test", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(idParams, ctx.params);
				const channel = await getChannelRow(db, who.orgId, id);
				const adapter = notificationAdapterFor(db, channel.kind);
				if (!adapter) {
					throw new HttpError(
						409,
						"NOTIFICATION_ADAPTER_MISSING",
						`No ${channel.kind} adapter is installed`,
					);
				}
				const now = Date.now();
				const outcomes = await adapter.deliver({
					db,
					channel,
					recipients: [],
					event: {
						id: `test-${now}`,
						orgId: who.orgId,
						kind: "run.finished",
						subjectType: "test_run",
						subjectId: "sample",
						actorId: who.userId,
						recipientsJson: "[]",
						payloadJson: JSON.stringify({
							outcome: "passed",
							testCaseKey: "TC-0000",
							testCaseTitle: "Test message from Jittle Lamp",
						}),
						createdAt: now,
						dispatchedAt: null,
					},
				});
				const failure = outcomes.find(
					(outcome) => outcome.status !== "delivered",
				);
				return {
					delivered: !failure,
					error: failure?.error ?? null,
				};
			}),
		);
