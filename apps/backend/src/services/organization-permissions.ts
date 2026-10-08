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
	"evidence.tags.manage",
	"invitations.create",
	"invitations.disable",
	"join_requests.manage",
	"roles.manage",
	"members.assign_role",
	"members.kick",
	"activity.view",
	"storage.manage",
	"test_case.view",
	"test_case.create",
	"test_case.update",
	"test_case.approve",
	"test_case.delete",
	"test_run.create",
	"test_run.cancel",
	"test_run.cancel_any",
	"test_run.view",
	"test_config.manage",
	"test_config.use",
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

export const testCasePermissions = [
	"test_case.view",
	"test_case.create",
	"test_case.update",
	"test_case.approve",
	"test_case.delete",
] as const satisfies readonly OrganizationPermission[];

export const testRunPermissions = [
	"test_run.create",
	"test_run.cancel",
	"test_run.cancel_any",
	"test_run.view",
] as const satisfies readonly OrganizationPermission[];

export const testConfigPermissions = [
	"test_config.manage",
	"test_config.use",
] as const satisfies readonly OrganizationPermission[];

// Default grants for test cases (design.md §6, §9.3): QA engineers author, review and run;
// developers view and run; moderators and admins hold everything.
export const defaultRoleTestPermissions = {
	developer: [
		"test_case.view",
		"test_run.create",
		"test_run.view",
		"test_config.use",
	],
	qa_engineer: [
		...testCasePermissions,
		...testRunPermissions,
		"test_config.use",
	],
	moderator: [
		...testCasePermissions,
		...testRunPermissions,
		...testConfigPermissions,
	],
	admin: [
		...testCasePermissions,
		...testRunPermissions,
		...testConfigPermissions,
	],
} as const satisfies Record<
	OrganizationRoleKey,
	readonly OrganizationPermission[]
>;

export const defaultRolePermissions = {
	developer: [
		"evidence.view",
		"evidence.download",
		"evidence.comment",
		"evidence.create",
		...defaultRoleTestPermissions.developer,
	],
	qa_engineer: [
		"evidence.view",
		"evidence.download",
		"evidence.comment",
		"evidence.create",
		"evidence.update.own",
		"evidence.delete.own",
		"evidence.move.own",
		...defaultRoleTestPermissions.qa_engineer,
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
		"evidence.tags.manage",
		"invitations.disable",
		"join_requests.manage",
		"activity.view",
		"storage.manage",
		...defaultRoleTestPermissions.moderator,
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

// Stored role JSON may come from an older or newer server version: unknown values are dropped
// rather than failing every permission check for the organisation.
export const parsePermissions = (
	permissionsJson: string,
): OrganizationPermission[] => {
	const parsed = z.array(z.string()).parse(JSON.parse(permissionsJson));
	const known = new Set<string>(organizationPermissionSchema.options);
	return parsed.filter((permission): permission is OrganizationPermission =>
		known.has(permission),
	);
};

export const serializePermissions = (
	permissions: readonly OrganizationPermission[],
): string => JSON.stringify(Array.from(new Set(permissions)));

export const ensureDefaultOrganizationRoles = async (
	db: PermissionDb,
	organizationId: string,
): Promise<void> => {
	const existing = await db.query.organizationRoles.findMany({
		where: eq(organizationRoles.organizationId, organizationId),
		columns: { key: true },
	});
	const existingKeys = new Set(existing.map((role) => role.key));
	const now = Date.now();
	for (const key of [
		"admin",
		"moderator",
		"developer",
		"qa_engineer",
	] as const) {
		if (existingKeys.has(key)) continue;
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
