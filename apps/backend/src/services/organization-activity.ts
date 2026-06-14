import { and, desc, eq, gte, lt, lte } from "drizzle-orm";

import {
	createOrganizationActivityLogInputSchema,
	organizationActivityLogs,
} from "../db/schema";
import type { BackendDb } from "./user-provisioning";

export const ORGANIZATION_ACTIVITY_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

export type OrganizationActivityEntity = {
	type: string;
	id?: string | null;
	url?: string | null;
};

export const evidenceActivityEntity = (
	evidenceId: string,
): OrganizationActivityEntity => ({
	type: "evidence",
	id: evidenceId,
	url: `/evidence/${encodeURIComponent(evidenceId)}`,
});

export const getRequestIpAddress = (request: Request): string | null => {
	const forwarded = request.headers.get("x-forwarded-for");
	if (forwarded) {
		return forwarded.split(",")[0]?.trim() || null;
	}
	return (
		request.headers.get("x-real-ip") ||
		request.headers.get("cf-connecting-ip") ||
		null
	);
};

export const recordOrganizationActivity = async (
	db: BackendDb,
	input: {
		organizationId: string;
		actorUserId?: string | null;
		action: string;
		entity: OrganizationActivityEntity;
		message: string;
		metadata?: Record<string, unknown>;
		ipAddress?: string | null;
	},
): Promise<void> => {
	const parsed = createOrganizationActivityLogInputSchema.parse({
		organizationId: input.organizationId,
		actorUserId: input.actorUserId ?? null,
		action: input.action,
		entityType: input.entity.type,
		entityId: input.entity.id ?? null,
		message: input.message,
		metadataJson: JSON.stringify({
			...(input.metadata ?? {}),
			entityUrl: input.entity.url ?? null,
		}),
		ipAddress: input.ipAddress ?? null,
	});

	await db.insert(organizationActivityLogs).values(parsed);
};

export const listOrganizationActivityLogs = async (
	db: BackendDb,
	args: {
		organizationId: string;
		userId?: string | undefined;
		action?: string | undefined;
		from?: number | undefined;
		to?: number | undefined;
		page?: number | undefined;
		limit?: number | undefined;
	},
) => {
	const page = Math.max(1, args.page ?? 1);
	const limit = Math.min(100, Math.max(1, args.limit ?? 25));
	const where = and(
		eq(organizationActivityLogs.organizationId, args.organizationId),
		args.userId
			? eq(organizationActivityLogs.actorUserId, args.userId)
			: undefined,
		args.action ? eq(organizationActivityLogs.action, args.action) : undefined,
		args.from ? gte(organizationActivityLogs.createdAt, args.from) : undefined,
		args.to ? lte(organizationActivityLogs.createdAt, args.to) : undefined,
	);

	const rows = await db.query.organizationActivityLogs.findMany({
		where,
		columns: {
			id: true,
			organizationId: true,
			actorUserId: true,
			action: true,
			entityType: true,
			entityId: true,
			message: true,
			metadataJson: true,
			ipAddress: true,
			createdAt: true,
		},
		orderBy: desc(organizationActivityLogs.createdAt),
		limit,
		offset: (page - 1) * limit,
	});

	return {
		logs: rows.map((row) => ({
			id: row.id,
			organizationId: row.organizationId,
			actorUserId: row.actorUserId,
			action: row.action,
			entityType: row.entityType,
			entityId: row.entityId,
			message: row.message,
			metadata: JSON.parse(row.metadataJson) as Record<string, unknown>,
			ipAddress: row.ipAddress,
			createdAt: row.createdAt,
		})),
		page,
		limit,
	};
};

export const cleanupExpiredOrganizationActivityLogs = async (
	db: BackendDb,
	now = Date.now(),
	retentionMs = ORGANIZATION_ACTIVITY_RETENTION_MS,
): Promise<number> => {
	const cutoff = now - retentionMs;
	const removed = await db
		.delete(organizationActivityLogs)
		.where(lt(organizationActivityLogs.createdAt, cutoff))
		.returning({ id: organizationActivityLogs.id });
	return removed.length;
};
