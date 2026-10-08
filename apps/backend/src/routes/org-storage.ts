import {
	createOrganizationStorageInputSchema,
	organizationStorageOverviewSchema,
	organizationStorageSchema,
	storageConnectionInputSchema,
	storageImpactSchema,
	storageSettingsSchema,
	storageTransferSchema,
	storageUsageGranularitySchema,
	storageUsageReportSchema,
	updateOrganizationStorageInputSchema,
} from "@jittle-lamp/shared";
import { Elysia } from "elysia";
import { z } from "zod/v4";

import {
	forbidden,
	HttpError,
	handleTestRoute,
	parseInput,
	requireDb,
	respond,
} from "../http/test-http";
import {
	type ClerkAuthPlugin,
	requireSessionScope,
} from "../plugins/clerk-auth";
import { getRequestIpAddress } from "../services/organization-activity";
import { ensureOrganizationMember } from "../services/organization-management";
import { organizationMemberHasPermission } from "../services/organization-permissions";
import type { OrganizationStorageService } from "../services/organization-storage";
import type { StorageTransfers } from "../services/storage-transfer";
import type { BackendDb } from "../services/user-provisioning";

// Organisation storage: usage statistics for every member, bring-your-own S3 storages, the
// write target and transfers for members with `storage.manage` (admins and moderators by default).

const usageQuerySchema = z.object({
	granularity: storageUsageGranularitySchema.default("day"),
	from: z.string().optional(),
	to: z.string().optional(),
});

const settingsInputSchema = z.object({
	defaultStorageId: z.string().min(1).nullable().optional(),
	defaultStorageDisabled: z.boolean().optional(),
});

const transferInputSchema = z.object({
	sourceStorageId: z.string().min(1).nullable().default(null),
	targetStorageId: z.string().min(1),
});

const deleteInputSchema = z.object({ confirmName: z.string() });

export type OrganizationStorageRouteDeps = {
	storage: OrganizationStorageService;
	transfers: StorageTransfers;
} | null;

type Who = { db: BackendDb; orgId: string; userId: string };

export const createOrganizationStorageRoutes = (
	auth: ClerkAuthPlugin,
	deps: OrganizationStorageRouteDeps,
) => {
	const services = () => {
		if (!deps) {
			throw new HttpError(503, "DB_UNAVAILABLE", "Database is unavailable");
		}
		return deps;
	};

	const member = async (ctx: {
		db: BackendDb | null;
		authContext: { localUserId: string | null };
		params: { orgId: string };
	}): Promise<Who> => {
		const db = requireDb(ctx.db);
		const userId = ctx.authContext.localUserId;
		if (!userId) {
			throw forbidden(
				"ORG_CONTEXT_UNRESOLVED",
				"No local user found for current session",
			);
		}
		if (
			!(await ensureOrganizationMember(db, {
				organizationId: ctx.params.orgId,
				localUserId: userId,
			}))
		) {
			throw forbidden(
				"ORG_STORAGE_FORBIDDEN",
				"Only members can view this organization's storage",
			);
		}
		return { db, orgId: ctx.params.orgId, userId };
	};

	const canManage = (who: Who) =>
		organizationMemberHasPermission(who.db, {
			organizationId: who.orgId,
			localUserId: who.userId,
			permission: "storage.manage",
		});

	const manager = async (ctx: Parameters<typeof member>[0]) => {
		const who = await member(ctx);
		if (!(await canManage(who))) {
			throw forbidden(
				"ORG_STORAGE_MANAGE_FORBIDDEN",
				"Your role cannot manage storage in this organization",
			);
		}
		return who;
	};

	return new Elysia({ name: "organization-storage-routes" })
		.use(auth)
		.guard({ auth: true }, (app) =>
			app
				.beforeHandle(
					({ authContext, requestId, set }) =>
						requireSessionScope(authContext, "org:read", requestId, set) ??
						undefined,
				)
				.get("/orgs/:orgId/storage/usage", (ctx) =>
					handleTestRoute(ctx, async () => {
						const who = await member(ctx);
						const query = parseInput(usageQuerySchema, ctx.query);
						return respond(
							storageUsageReportSchema,
							await services().storage.usageReport({
								orgId: who.orgId,
								...query,
							}),
						);
					}),
				)
				.get("/orgs/:orgId/storage", (ctx) =>
					handleTestRoute(ctx, async () => {
						const who = await member(ctx);
						return respond(
							organizationStorageOverviewSchema,
							await services().storage.overview({
								orgId: who.orgId,
								canManage: await canManage(who),
							}),
						);
					}),
				)
				.patch("/orgs/:orgId/storage/settings", (ctx) =>
					handleTestRoute(ctx, async () => {
						const who = await manager(ctx);
						const body = parseInput(settingsInputSchema, ctx.body);
						return respond(
							storageSettingsSchema,
							await services().storage.updateSettings({
								orgId: who.orgId,
								actorUserId: who.userId,
								defaultStorageId: body.defaultStorageId,
								defaultStorageDisabled: body.defaultStorageDisabled,
								ipAddress: getRequestIpAddress(ctx.request),
							}),
						);
					}),
				)
				// Tests a connection before it is saved. Nothing is stored.
				.post("/orgs/:orgId/storages/test", (ctx) =>
					handleTestRoute(ctx, async () => {
						const who = await manager(ctx);
						const body = parseInput(storageConnectionInputSchema, ctx.body);
						const { accessKeyId, secretAccessKey, ...fields } = body;
						return services().storage.testConnection({
							orgId: who.orgId,
							fields,
							credentials: { accessKeyId, secretAccessKey },
						});
					}),
				)
				.post("/orgs/:orgId/storages", (ctx) =>
					handleTestRoute(ctx, async () => {
						const who = await manager(ctx);
						const body = parseInput(
							createOrganizationStorageInputSchema,
							ctx.body,
						);
						const { name, accessKeyId, secretAccessKey, ...fields } = body;
						ctx.set.status = 201;
						return respond(
							organizationStorageSchema,
							await services().storage.createStorage({
								orgId: who.orgId,
								actorUserId: who.userId,
								name,
								fields,
								credentials: { accessKeyId, secretAccessKey },
								ipAddress: getRequestIpAddress(ctx.request),
							}),
						);
					}),
				)
				.patch("/orgs/:orgId/storages/:storageId", (ctx) =>
					handleTestRoute(ctx, async () => {
						const who = await manager(ctx);
						const body = parseInput(
							updateOrganizationStorageInputSchema,
							ctx.body,
						);
						const { name, accessKeyId, secretAccessKey, ...fields } = body;
						return respond(
							organizationStorageSchema,
							await services().storage.updateStorage({
								orgId: who.orgId,
								storageId: ctx.params.storageId,
								actorUserId: who.userId,
								name,
								fields: Object.fromEntries(
									Object.entries(fields).filter(
										([, value]) => value !== undefined,
									),
								),
								credentials: {
									...(accessKeyId ? { accessKeyId } : {}),
									...(secretAccessKey ? { secretAccessKey } : {}),
								},
								ipAddress: getRequestIpAddress(ctx.request),
							}),
						);
					}),
				)
				.post("/orgs/:orgId/storages/:storageId/test", (ctx) =>
					handleTestRoute(ctx, async () => {
						const who = await manager(ctx);
						return services().storage.testConnection({
							orgId: who.orgId,
							storageId: ctx.params.storageId,
						});
					}),
				)
				.get("/orgs/:orgId/storages/:storageId/impact", (ctx) =>
					handleTestRoute(ctx, async () => {
						const who = await manager(ctx);
						return respond(
							storageImpactSchema,
							await services().storage.storageImpact({
								orgId: who.orgId,
								storageId: ctx.params.storageId,
							}),
						);
					}),
				)
				// POST rather than DELETE so the confirmation travels in a body every client sends.
				.post("/orgs/:orgId/storages/:storageId/delete", (ctx) =>
					handleTestRoute(ctx, async () => {
						const who = await manager(ctx);
						const body = parseInput(deleteInputSchema, ctx.body);
						return respond(
							storageImpactSchema,
							await services().storage.deleteStorage({
								orgId: who.orgId,
								storageId: ctx.params.storageId,
								actorUserId: who.userId,
								confirmName: body.confirmName,
								ipAddress: getRequestIpAddress(ctx.request),
							}),
						);
					}),
				)
				.get("/orgs/:orgId/storage/transfers", (ctx) =>
					handleTestRoute(ctx, async () => {
						const who = await member(ctx);
						return {
							items: (await services().transfers.list(who.orgId)).map((item) =>
								respond(storageTransferSchema, item),
							),
						};
					}),
				)
				.post("/orgs/:orgId/storage/transfers", (ctx) =>
					handleTestRoute(ctx, async () => {
						const who = await manager(ctx);
						const body = parseInput(transferInputSchema, ctx.body);
						ctx.set.status = 201;
						return respond(
							storageTransferSchema,
							await services().transfers.start({
								orgId: who.orgId,
								actorUserId: who.userId,
								sourceStorageId: body.sourceStorageId,
								targetStorageId: body.targetStorageId,
								ipAddress: getRequestIpAddress(ctx.request),
							}),
						);
					}),
				)
				.get("/orgs/:orgId/storage/transfers/:transferId", (ctx) =>
					handleTestRoute(ctx, async () => {
						const who = await member(ctx);
						return respond(
							storageTransferSchema,
							await services().transfers.get(who.orgId, ctx.params.transferId),
						);
					}),
				)
				.post("/orgs/:orgId/storage/transfers/:transferId/:action", (ctx) =>
					handleTestRoute(ctx, async () => {
						const who = await manager(ctx);
						const action = parseInput(
							z.enum(["pause", "resume", "cancel"]),
							ctx.params.action,
						);
						return respond(
							storageTransferSchema,
							await services().transfers.control({
								orgId: who.orgId,
								transferId: ctx.params.transferId,
								actorUserId: who.userId,
								action,
								ipAddress: getRequestIpAddress(ctx.request),
							}),
						);
					}),
				),
		);
};
