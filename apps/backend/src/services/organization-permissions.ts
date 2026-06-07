import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod/v4";

import {
	type OrganizationPermission,
	type OrganizationRoleKey,
	organizationMembers,
	organizationRoles,
} from "../db/schema";
import type { BackendDb } from "./user-provisioning";

type PermissionDb = Pick<BackendDb, "insert" | "query">;

export const organizationPermissionSchema = z.enum([
	"evidence.view",
	"evidence.download",
	"evidence.comment",
	"evidence.create",
	"evidence.update.own",
	"evidence.delete.own",
	"evidence.move.own",
	"evidence.update.any",
	"evidence.delete.any",
	"evidence.move.any",
	"invitations.create",
	"invitations.disable",
	"join_requests.manage",
	"roles.manage",
	"members.assign_role",
	"members.kick",
	"activity.view",
]);

export const allOrganizationPermissions = organizationPermissionSchema.options;

export const adminOnlyOrganizationPermissions = [
	"invitations.create",
	"roles.manage",
	"members.assign_role",
	"members.kick",
] as const satisfies readonly OrganizationPermission[];

export const defaultRoleLabels = {
	admin: "Admin",
	moderator: "Moderator",
	developer: "Developer",
	qa_engineer: "QA Engineer",
} as const satisfies Record<OrganizationRoleKey, string>;

export const defaultRolePermissions = {
	developer: ["evidence.view", "evidence.download", "evidence.comment"],
	qa_engineer: [
		"evidence.view",
		"evidence.download",
		"evidence.comment",
		"evidence.create",
		"evidence.update.own",
		"evidence.delete.own",
		"evidence.move.own",
	],
	moderator: [
		"evidence.view",
		"evidence.download",
		"evidence.comment",
		"evidence.create",
		"evidence.update.own",
		"evidence.delete.own",
		"evidence.move.own",
		"evidence.update.any",
		"evidence.delete.any",
		"evidence.move.any",
		"invitations.disable",
		"join_requests.manage",
		"activity.view",
	],
	admin: allOrganizationPermissions,
} as const satisfies Record<
	OrganizationRoleKey,
	readonly OrganizationPermission[]
>;

export const normalizeOrganizationRoleKey = (
	role: string,
): OrganizationRoleKey => {
	const normalized = role.trim().toLowerCase();
	switch (normalized) {
		case "owner":
		case "admin":
			return "admin";
		case "moderator":
			return "moderator";
		case "qa":
		case "qa-engineer":
		case "qa_engineer":
		case "qa engineer":
			return "qa_engineer";
		default:
			return "developer";
	}
};

export const parsePermissions = (
	permissionsJson: string,
): OrganizationPermission[] => {
	const parsed = JSON.parse(permissionsJson) as unknown;
	return organizationPermissionSchema.array().parse(parsed);
};

export const serializePermissions = (
	permissions: readonly OrganizationPermission[],
): string => JSON.stringify(Array.from(new Set(permissions)));

export const ensureDefaultOrganizationRoles = async (
	db: PermissionDb,
	organizationId: string,
): Promise<void> => {
	const now = Date.now();
	for (const key of [
		"admin",
		"moderator",
		"developer",
		"qa_engineer",
	] as const) {
		await db
			.insert(organizationRoles)
			.values({
				organizationId,
				key,
				name: defaultRoleLabels[key],
				permissionsJson: serializePermissions(defaultRolePermissions[key]),
				isSystem: true,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing();
	}
};

export const getOrganizationMembershipRole = async (
	db: BackendDb,
	args: { organizationId: string; localUserId: string },
): Promise<OrganizationRoleKey | null> => {
	const membership = await db.query.organizationMembers.findFirst({
		where: and(
			eq(organizationMembers.organizationId, args.organizationId),
			eq(organizationMembers.userId, args.localUserId),
			isNull(organizationMembers.teamId),
		),
		columns: { role: true },
	});
	return membership ? normalizeOrganizationRoleKey(membership.role) : null;
};

export const getOrganizationRolePermissions = async (
	db: BackendDb,
	args: { organizationId: string; role: string },
): Promise<Set<OrganizationPermission>> => {
	const role = normalizeOrganizationRoleKey(args.role);
	await ensureDefaultOrganizationRoles(db, args.organizationId);
	const row = await db.query.organizationRoles.findFirst({
		where: and(
			eq(organizationRoles.organizationId, args.organizationId),
			eq(organizationRoles.key, role),
		),
		columns: { permissionsJson: true },
	});
	const permissions = row
		? parsePermissions(row.permissionsJson)
		: defaultRolePermissions[role];
	return new Set(permissions);
};

export const organizationMemberHasPermission = async (
	db: BackendDb,
	args: {
		organizationId: string;
		localUserId: string;
		permission: OrganizationPermission;
	},
): Promise<boolean> => {
	const role = await getOrganizationMembershipRole(db, args);
	if (!role) return false;
	const permissions = await getOrganizationRolePermissions(db, {
		organizationId: args.organizationId,
		role,
	});
	return permissions.has(args.permission);
};

export const requireAnyOrganizationPermission = async (
	db: BackendDb,
	args: {
		organizationId: string;
		localUserId: string;
		permissions: readonly OrganizationPermission[];
	},
): Promise<boolean> => {
	const role = await getOrganizationMembershipRole(db, args);
	if (!role) return false;
	const permissions = await getOrganizationRolePermissions(db, {
		organizationId: args.organizationId,
		role,
	});
	return args.permissions.some((permission) => permissions.has(permission));
};
