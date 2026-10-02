import {
	markNotificationsReadRequestSchema,
	notificationListResponseSchema,
	notificationSubscriptionsSchema,
} from "@jittle-lamp/shared";
import { Elysia } from "elysia";
import { z } from "zod/v4";

import {
	handleTestRoute,
	normalizeQuery,
	parseInput,
	requireDb,
	resolveTestActor,
	respond,
} from "../http/test-http";
import type { ClerkAuthPlugin } from "../plugins/clerk-auth";
import {
	getNotificationSubscriptions,
	listInAppNotifications,
	markNotificationsRead,
	saveNotificationSubscriptions,
} from "../services/notifications";

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
		);
