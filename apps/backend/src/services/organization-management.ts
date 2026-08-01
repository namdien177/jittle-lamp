import { and, desc, eq, gt, inArray, isNull, lt, ne } from "drizzle-orm";
import type { z } from "zod/v4";
import {
	createOrganizationInputSchema,
	createOrganizationInvitationCodeInputSchema,
	createOrganizationInvitationInputSchema,
	createOrganizationJoinRequestInputSchema,
	createOrganizationMembershipInputSchema,
	type OrganizationPermission,
	type organizationInvitationCodeRoleSchema,
	organizationInvitationCodes,
	type organizationInvitationRoleSchema,
	organizationInvitations,
	organizationJoinRequests,
	organizationMembers,
	organizationMigrationLinks,
	organizationMigrationStates,
	organizationRoles,
	organizations,
	users,
} from "../db/schema";
import {
	fallbackClerkUserProfile,
	formatClerkDisplayName,
	resolveClerkUserProfile,
} from "./clerk-user-profile";
import {
	adminOnlyOrganizationPermissions,
	allOrganizationPermissions,
	defaultRoleLabels,
	ensureDefaultOrganizationRoles,
	normalizeOrganizationRoleKey,
	organizationMemberHasPermission,
	parsePermissions,
	serializePermissions,
} from "./organization-permissions";
import type { BackendDb } from "./user-provisioning";

export type OrganizationSummary = {
	id: string;
	name: string;
	role: string;
	isPersonal: boolean;
	requireInvitationApproval: boolean;
	memberCount: number;
	createdAt: number;
	joinedAt: number;
	migrationAccessState: string | null;
	migrationDestinationWebOrigin: string | null;
};

export type OrganizationMemberSummary = {
	membershipId: string;
	userId: string;
	clerkUserId: string;
	firstName: string | null;
	lastName: string | null;
	displayName: string;
	email: string | null;
	role: string;
	joinedAt: number;
	guestExpiresAt: number | null;
};

export type OrganizationMemberList = {
	members: OrganizationMemberSummary[];
	total: number;
	page: number;
	limit: number;
};

export type InvitationSummary = {
	id: string;
	email: string;
	role: "admin" | "moderator" | "developer" | "qa_engineer";
	status: "pending" | "accepted" | "revoked" | "expired";
	expiresAt: number;
	createdAt: number;
	invitedBy: string;
};

export type CreatedInvitation = InvitationSummary & {
	token: string;
	organizationId: string;
};

export type InvitationCodeSummary = {
	id: string;
	label: string;
	role: "admin" | "moderator" | "developer" | "qa_engineer";
	hasPassword: boolean;
	emailDomain: string | null;
	expiresAt: number | null;
	guestExpiresAfterDays: number | null;
	lockedAt: number | null;
	createdAt: number;
	createdBy: string;
};

export type CreatedInvitationCode = InvitationCodeSummary & {
	code: string;
	organizationId: string;
};

export type OrganizationRoleSummary = {
	key: "admin" | "moderator" | "developer" | "qa_engineer";
	name: string;
	permissions: string[];
	isSystem: boolean;
	updatedAt: number;
};

export type OrganizationJoinRequestSummary = {
	id: string;
	organizationId: string;
	userId: string;
	clerkUserId: string;
	displayName: string;
	email: string | null;
	requestedRole: string;
	status: "pending" | "approved" | "rejected";
	createdAt: number;
};

const sha256Hex = async (value: string): Promise<string> => {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
};

export const generateInvitationToken = (): string =>
	`inv_${crypto.randomUUID().replace(/-/g, "")}`;

export const generateInvitationCode = (): string =>
	`join_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

export const hashInvitationToken = (token: string): Promise<string> =>
	sha256Hex(token);

const hashInvitationCodePassword = (code: string, password: string) =>
	sha256Hex(`${code}:${password}`);

const normalizeDomain = (domain: string | null | undefined): string | null => {
	const trimmed = domain?.trim().toLowerCase().replace(/^@/, "") ?? "";
	return trimmed ? trimmed : null;
};

export const createOrganization = async (
	db: BackendDb,
	input: { name: string; createdByLocalUserId: string },
): Promise<OrganizationSummary> => {
	const parsed = createOrganizationInputSchema.parse({
		name: input.name,
		isPersonal: false,
		personalOwnerUserId: null,
	});

	return db.transaction(async (tx) => {
		const [organization] = await tx
			.insert(organizations)
			.values({
				name: parsed.name,
				isPersonal: false,
				personalOwnerUserId: null,
			})
			.returning({
				id: organizations.id,
				name: organizations.name,
				isPersonal: organizations.isPersonal,
				createdAt: organizations.createdAt,
			});

		if (!organization) {
			throw new Error("Failed to create organization");
		}

		const membership = createOrganizationMembershipInputSchema.parse({
			organizationId: organization.id,
			userId: input.createdByLocalUserId,
			role: "admin",
		});

		await ensureDefaultOrganizationRoles(tx, organization.id);

		await tx
			.insert(organizationMembers)
			.values(membership)
			.onConflictDoNothing();

		await tx
			.update(users)
			.set({ activeOrgId: organization.id, updatedAt: Date.now() })
			.where(eq(users.id, input.createdByLocalUserId));

		return {
			id: organization.id,
			name: organization.name,
			role: "admin",
			isPersonal: organization.isPersonal,
			requireInvitationApproval: false,
			memberCount: 1,
			createdAt: organization.createdAt,
			joinedAt: Date.now(),
			migrationAccessState: null,
			migrationDestinationWebOrigin: null,
		};
	});
};

export const listOrganizationsForUser = async (
	db: BackendDb,
	localUserId: string,
): Promise<OrganizationSummary[]> => {
	const memberships = await db.query.organizationMembers.findMany({
		where: and(
			eq(organizationMembers.userId, localUserId),
			isNull(organizationMembers.teamId),
		),
		columns: { organizationId: true, role: true, createdAt: true },
		with: {
			organization: {
				columns: {
					id: true,
					name: true,
					isPersonal: true,
					requireInvitationApproval: true,
					createdAt: true,
				},
			},
		},
	});

	const counts = new Map<string, number>();
	for (const membership of memberships) {
		const allMembers = await db.query.organizationMembers.findMany({
			where: and(
				eq(organizationMembers.organizationId, membership.organizationId),
				isNull(organizationMembers.teamId),
			),
			columns: { id: true },
		});
		counts.set(membership.organizationId, allMembers.length);
	}

	const states =
		memberships.length > 0
			? await db
					.select()
					.from(organizationMigrationStates)
					.where(
						inArray(
							organizationMigrationStates.organizationId,
							memberships.map((membership) => membership.organizationId),
						),
					)
			: [];
	const stateByOrganization = new Map(
		states.map((state) => [state.organizationId, state] as const),
	);
	const migrationLinks =
		states.length > 0
			? await db
					.select({
						id: organizationMigrationLinks.id,
						lastSuccessfulAt: organizationMigrationLinks.lastSuccessfulAt,
					})
					.from(organizationMigrationLinks)
					.where(
						inArray(
							organizationMigrationLinks.id,
							states.map((state) => state.linkId),
						),
					)
			: [];
	const linkById = new Map(
		migrationLinks.map((link) => [link.id, link] as const),
	);
	return memberships
		.filter((membership) => {
			const state = stateByOrganization.get(membership.organizationId);
			return !(
				state?.accessState === "importing" &&
				!linkById.get(state.linkId)?.lastSuccessfulAt
			);
		})
		.map((membership) => ({
			id: membership.organization.id,
			name: membership.organization.name,
			role: normalizeOrganizationRoleKey(membership.role),
			isPersonal: membership.organization.isPersonal,
			requireInvitationApproval:
				membership.organization.requireInvitationApproval,
			memberCount: counts.get(membership.organizationId) ?? 1,
			createdAt: membership.organization.createdAt,
			joinedAt: membership.createdAt,
			migrationAccessState:
				stateByOrganization.get(membership.organizationId)?.accessState ?? null,
			migrationDestinationWebOrigin:
				stateByOrganization.get(membership.organizationId)
					?.destinationWebOrigin ?? null,
		}));
};

export const getOrganizationRole = async (
	db: BackendDb,
	args: { organizationId: string; localUserId: string },
): Promise<string | null> => {
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

export const ensureOrganizationOwner = async (
	db: BackendDb,
	args: { organizationId: string; localUserId: string },
): Promise<boolean> => (await getOrganizationRole(db, args)) === "admin";

export const ensureOrganizationManager = async (
	db: BackendDb,
	args: { organizationId: string; localUserId: string },
): Promise<boolean> => {
	return organizationMemberHasPermission(db, {
		organizationId: args.organizationId,
		localUserId: args.localUserId,
		permission: "invitations.disable",
	});
};

export const ensureOrganizationMember = async (
	db: BackendDb,
	args: { organizationId: string; localUserId: string },
): Promise<boolean> => Boolean(await getOrganizationRole(db, args));

export const listOrganizationMembers = async (
	db: BackendDb,
	args: {
		organizationId: string;
		runtime: { clerkSecretKey: string | undefined };
		currentLocalUserId: string;
		search?: string | undefined;
		role?: "all" | "admin" | "moderator" | "developer" | "qa_engineer";
		page?: number | undefined;
		limit?: number | undefined;
	},
): Promise<OrganizationMemberList> => {
	const page = Math.max(1, args.page ?? 1);
	const limit = Math.min(100, Math.max(1, args.limit ?? 20));
	const memberships = await db.query.organizationMembers.findMany({
		where: and(
			eq(organizationMembers.organizationId, args.organizationId),
			isNull(organizationMembers.teamId),
		),
		columns: {
			id: true,
			userId: true,
			role: true,
			guestExpiresAt: true,
			createdAt: true,
		},
		with: {
			user: {
				columns: { clerkUserId: true },
			},
		},
	});

	const summaries = await Promise.all(
		memberships.map(async (membership) => {
			const profile = await resolveClerkUserProfile(
				args.runtime,
				membership.user.clerkUserId,
			).catch(() => fallbackClerkUserProfile(membership.user.clerkUserId));

			return {
				membershipId: membership.id,
				userId: membership.userId,
				clerkUserId: membership.user.clerkUserId,
				firstName: profile.firstName,
				lastName: profile.lastName,
				displayName: formatClerkDisplayName({
					clerkUserId: membership.user.clerkUserId,
					firstName: profile.firstName,
					lastName: profile.lastName,
					username: profile.username,
					email: profile.email,
				}),
				email: profile.email,
				role: normalizeOrganizationRoleKey(membership.role),
				joinedAt: membership.createdAt,
				guestExpiresAt: membership.guestExpiresAt,
			};
		}),
	);

	const search = args.search?.trim().toLowerCase() ?? "";
	const filtered = summaries
		.filter(
			(member) =>
				args.role === undefined ||
				args.role === "all" ||
				member.role === args.role,
		)
		.filter((member) => {
			if (!search) return true;
			return [
				member.displayName,
				member.email ?? "",
				member.firstName ?? "",
				member.lastName ?? "",
				member.role,
			].some((value) => value.toLowerCase().includes(search));
		})
		.sort((a, b) => {
			if (a.userId === args.currentLocalUserId) return -1;
			if (b.userId === args.currentLocalUserId) return 1;
			return a.joinedAt - b.joinedAt;
		});

	const start = (page - 1) * limit;
	return {
		members: filtered.slice(start, start + limit),
		total: filtered.length,
		page,
		limit,
	};
};

export const renameOrganization = async (
	db: BackendDb,
	args: { organizationId: string; name: string },
): Promise<void> => {
	await db
		.update(organizations)
		.set({ name: args.name.trim(), updatedAt: Date.now() })
		.where(eq(organizations.id, args.organizationId));
};

export const updateOrganizationSettings = async (
	db: BackendDb,
	args: {
		organizationId: string;
		requireInvitationApproval: boolean;
	},
): Promise<{ organizationId: string; requireInvitationApproval: boolean }> => {
	const [updated] = await db
		.update(organizations)
		.set({
			requireInvitationApproval: args.requireInvitationApproval,
			updatedAt: Date.now(),
		})
		.where(eq(organizations.id, args.organizationId))
		.returning({
			organizationId: organizations.id,
			requireInvitationApproval: organizations.requireInvitationApproval,
		});
	if (!updated) throw new Error("Organization not found.");
	return updated;
};

export const listOrganizationRoles = async (
	db: BackendDb,
	organizationId: string,
): Promise<OrganizationRoleSummary[]> => {
	await ensureDefaultOrganizationRoles(db, organizationId);
	const rows = await db.query.organizationRoles.findMany({
		where: eq(organizationRoles.organizationId, organizationId),
		columns: {
			key: true,
			name: true,
			permissionsJson: true,
			isSystem: true,
			updatedAt: true,
		},
	});
	const order = new Map([
		["admin", 0],
		["moderator", 1],
		["qa_engineer", 2],
		["developer", 3],
	]);
	return rows
		.map((row) => ({
			key: normalizeOrganizationRoleKey(row.key),
			name: row.name,
			permissions: parsePermissions(row.permissionsJson),
			isSystem: row.isSystem,
			updatedAt: row.updatedAt,
		}))
		.sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
};

export const updateOrganizationRolePermissions = async (
	db: BackendDb,
	args: {
		organizationId: string;
		role: "admin" | "moderator" | "developer" | "qa_engineer";
		permissions: string[];
	},
): Promise<OrganizationRoleSummary> => {
	const role = normalizeOrganizationRoleKey(args.role);
	if (role === "admin") {
		throw new Error("Admin permissions cannot be restricted.");
	}
	const allowed = new Set(allOrganizationPermissions);
	const adminOnly = new Set<OrganizationPermission>(
		adminOnlyOrganizationPermissions,
	);
	const permissions = args.permissions.filter((permission) =>
		allowed.has(permission as never),
	) as Array<(typeof allOrganizationPermissions)[number]>;
	if (permissions.some((permission) => adminOnly.has(permission))) {
		throw new Error("Only the Admin role can hold admin-only permissions.");
	}
	const now = Date.now();
	await ensureDefaultOrganizationRoles(db, args.organizationId);
	const [updated] = await db
		.update(organizationRoles)
		.set({
			name: defaultRoleLabels[role],
			permissionsJson: serializePermissions(permissions),
			updatedAt: now,
		})
		.where(
			and(
				eq(organizationRoles.organizationId, args.organizationId),
				eq(organizationRoles.key, role),
			),
		)
		.returning({
			key: organizationRoles.key,
			name: organizationRoles.name,
			permissionsJson: organizationRoles.permissionsJson,
			isSystem: organizationRoles.isSystem,
			updatedAt: organizationRoles.updatedAt,
		});
	if (!updated) throw new Error("Role not found.");
	return {
		key: normalizeOrganizationRoleKey(updated.key),
		name: updated.name,
		permissions: parsePermissions(updated.permissionsJson),
		isSystem: updated.isSystem,
		updatedAt: updated.updatedAt,
	};
};

export const updateOrganizationMemberRole = async (
	db: BackendDb,
	args: {
		organizationId: string;
		actorLocalUserId: string;
		membershipId: string;
		role: "admin" | "moderator" | "developer" | "qa_engineer";
	},
): Promise<void> => {
	const canAssignRole =
		(await getOrganizationRole(db, {
			organizationId: args.organizationId,
			localUserId: args.actorLocalUserId,
		})) === "admin";
	const target = await db.query.organizationMembers.findFirst({
		where: and(
			eq(organizationMembers.id, args.membershipId),
			eq(organizationMembers.organizationId, args.organizationId),
			isNull(organizationMembers.teamId),
		),
		columns: { role: true, userId: true },
	});
	if (!target) throw new Error("Member not found.");
	if (!canAssignRole) {
		throw new Error("Only admins can assign organization roles.");
	}

	await db
		.update(organizationMembers)
		.set({ role: normalizeOrganizationRoleKey(args.role) })
		.where(eq(organizationMembers.id, args.membershipId));
};

export const removeOrganizationMember = async (
	db: BackendDb,
	args: {
		organizationId: string;
		actorLocalUserId: string;
		membershipId: string;
	},
): Promise<void> => {
	const canKick =
		(await getOrganizationRole(db, {
			organizationId: args.organizationId,
			localUserId: args.actorLocalUserId,
		})) === "admin";
	const target = await db.query.organizationMembers.findFirst({
		where: and(
			eq(organizationMembers.id, args.membershipId),
			eq(organizationMembers.organizationId, args.organizationId),
			isNull(organizationMembers.teamId),
		),
		columns: { role: true, userId: true },
	});
	if (!target) throw new Error("Member not found.");
	if (target.userId === args.actorLocalUserId) {
		throw new Error("You cannot remove yourself from the organization.");
	}
	if (!canKick) {
		throw new Error("Only admins can remove organization members.");
	}
	await db
		.delete(organizationMembers)
		.where(eq(organizationMembers.id, args.membershipId));
};

export const leaveOrganization = async (
	db: BackendDb,
	args: { organizationId: string; localUserId: string },
): Promise<void> => {
	const membership = await db.query.organizationMembers.findFirst({
		where: and(
			eq(organizationMembers.organizationId, args.organizationId),
			eq(organizationMembers.userId, args.localUserId),
			isNull(organizationMembers.teamId),
		),
		columns: { id: true, role: true },
	});
	if (!membership) throw new Error("Member not found.");
	if (normalizeOrganizationRoleKey(membership.role) === "admin") {
		const otherOwner = await db.query.organizationMembers.findFirst({
			where: and(
				eq(organizationMembers.organizationId, args.organizationId),
				eq(organizationMembers.role, "admin"),
				ne(organizationMembers.userId, args.localUserId),
				isNull(organizationMembers.teamId),
			),
			columns: { id: true },
		});
		if (!otherOwner) {
			throw new Error("Assign another admin before leaving this organization.");
		}
	}

	await db.transaction(async (tx) => {
		await tx
			.delete(organizationMembers)
			.where(eq(organizationMembers.id, membership.id));

		const user = await tx.query.users.findFirst({
			where: eq(users.id, args.localUserId),
			columns: { activeOrgId: true },
		});
		if (user?.activeOrgId !== args.organizationId) return;

		const nextMembership = await tx.query.organizationMembers.findFirst({
			where: and(
				eq(organizationMembers.userId, args.localUserId),
				isNull(organizationMembers.teamId),
			),
			columns: { organizationId: true },
			orderBy: desc(organizationMembers.createdAt),
		});
		await tx
			.update(users)
			.set({
				activeOrgId: nextMembership?.organizationId ?? null,
				updatedAt: Date.now(),
			})
			.where(eq(users.id, args.localUserId));
	});
};

export const deleteOrganizationAsLastAdmin = async (
	db: BackendDb,
	args: { organizationId: string; localUserId: string },
): Promise<void> => {
	const organization = await db.query.organizations.findFirst({
		where: eq(organizations.id, args.organizationId),
		columns: { id: true, isPersonal: true },
	});
	if (!organization) throw new Error("Organization not found.");
	if (organization.isPersonal) {
		throw new Error("Personal organizations cannot be deleted.");
	}

	const membership = await db.query.organizationMembers.findFirst({
		where: and(
			eq(organizationMembers.organizationId, args.organizationId),
			eq(organizationMembers.userId, args.localUserId),
			isNull(organizationMembers.teamId),
		),
		columns: { id: true, role: true },
	});
	if (!membership) throw new Error("Member not found.");
	if (normalizeOrganizationRoleKey(membership.role) !== "admin") {
		throw new Error("Only admins can delete this organization.");
	}

	const members = await db.query.organizationMembers.findMany({
		where: and(
			eq(organizationMembers.organizationId, args.organizationId),
			isNull(organizationMembers.teamId),
		),
		columns: { userId: true },
	});
	if (members.length !== 1 || members[0]?.userId !== args.localUserId) {
		throw new Error(
			"Only the last remaining admin can delete this organization.",
		);
	}

	await db.transaction(async (tx) => {
		const user = await tx.query.users.findFirst({
			where: eq(users.id, args.localUserId),
			columns: { activeOrgId: true },
		});

		await tx
			.delete(organizations)
			.where(eq(organizations.id, args.organizationId));

		if (user?.activeOrgId !== args.organizationId) return;

		const nextMembership = await tx.query.organizationMembers.findFirst({
			where: and(
				eq(organizationMembers.userId, args.localUserId),
				isNull(organizationMembers.teamId),
			),
			columns: { organizationId: true },
			orderBy: desc(organizationMembers.createdAt),
		});
		await tx
			.update(users)
			.set({
				activeOrgId: nextMembership?.organizationId ?? null,
				updatedAt: Date.now(),
			})
			.where(eq(users.id, args.localUserId));
	});
};

const summarizeInvitation = (row: {
	id: string;
	email: string;
	role: "admin" | "moderator" | "developer" | "qa_engineer" | string;
	status: string;
	expiresAt: number;
	createdAt: number;
	invitedBy: string;
}): InvitationSummary => ({
	id: row.id,
	email: row.email,
	role: normalizeOrganizationRoleKey(row.role),
	status:
		row.status === "accepted"
			? "accepted"
			: row.status === "revoked"
				? "revoked"
				: row.status === "expired"
					? "expired"
					: "pending",
	expiresAt: row.expiresAt,
	createdAt: row.createdAt,
	invitedBy: row.invitedBy,
});

const summarizeInvitationCode = (row: {
	id: string;
	label: string;
	role: "admin" | "moderator" | "developer" | "qa_engineer" | string;
	passwordHash: string | null;
	emailDomain: string | null;
	expiresAt: number | null;
	guestExpiresAfterDays: number | null;
	lockedAt: number | null;
	createdAt: number;
	createdBy: string;
}): InvitationCodeSummary => ({
	id: row.id,
	label: row.label,
	role: normalizeOrganizationRoleKey(row.role),
	hasPassword: Boolean(row.passwordHash),
	emailDomain: row.emailDomain,
	expiresAt: row.expiresAt,
	guestExpiresAfterDays: row.guestExpiresAfterDays,
	lockedAt: row.lockedAt,
	createdAt: row.createdAt,
	createdBy: row.createdBy,
});

export const createOrganizationInvitation = async (
	db: BackendDb,
	args: {
		organizationId: string;
		email: string;
		role: z.infer<typeof organizationInvitationRoleSchema>;
		invitedBy: string;
		ttlMs?: number;
	},
): Promise<CreatedInvitation> => {
	const ttl = args.ttlMs ?? 1000 * 60 * 60 * 24 * 7;
	const token = generateInvitationToken();
	const tokenHash = await hashInvitationToken(token);

	const parsed = createOrganizationInvitationInputSchema.parse({
		organizationId: args.organizationId,
		email: args.email,
		role: args.role,
		tokenHash,
		expiresAt: Date.now() + ttl,
		invitedBy: args.invitedBy,
	});

	const [created] = await db
		.insert(organizationInvitations)
		.values(parsed)
		.returning({
			id: organizationInvitations.id,
			email: organizationInvitations.email,
			role: organizationInvitations.role,
			status: organizationInvitations.status,
			expiresAt: organizationInvitations.expiresAt,
			createdAt: organizationInvitations.createdAt,
			invitedBy: organizationInvitations.invitedBy,
		});

	if (!created) {
		throw new Error("Failed to create invitation");
	}

	return {
		...summarizeInvitation(created),
		organizationId: args.organizationId,
		token,
	};
};

export const listOrganizationInvitations = async (
	db: BackendDb,
	organizationId: string,
): Promise<InvitationSummary[]> => {
	const rows = await db.query.organizationInvitations.findMany({
		where: eq(organizationInvitations.organizationId, organizationId),
		columns: {
			id: true,
			email: true,
			role: true,
			status: true,
			expiresAt: true,
			createdAt: true,
			invitedBy: true,
		},
		orderBy: desc(organizationInvitations.createdAt),
	});
	return rows.map(summarizeInvitation);
};

export const revokeOrganizationInvitation = async (
	db: BackendDb,
	args: { organizationId: string; invitationId: string },
): Promise<InvitationSummary | null> => {
	const now = Date.now();
	const [updated] = await db
		.update(organizationInvitations)
		.set({ status: "revoked", revokedAt: now, updatedAt: now })
		.where(
			and(
				eq(organizationInvitations.id, args.invitationId),
				eq(organizationInvitations.organizationId, args.organizationId),
				eq(organizationInvitations.status, "pending"),
			),
		)
		.returning({
			id: organizationInvitations.id,
			email: organizationInvitations.email,
			role: organizationInvitations.role,
			status: organizationInvitations.status,
			expiresAt: organizationInvitations.expiresAt,
			createdAt: organizationInvitations.createdAt,
			invitedBy: organizationInvitations.invitedBy,
		});
	return updated ? summarizeInvitation(updated) : null;
};

export const listOrganizationInvitationCodes = async (
	db: BackendDb,
	organizationId: string,
): Promise<InvitationCodeSummary[]> => {
	const rows = await db.query.organizationInvitationCodes.findMany({
		where: eq(organizationInvitationCodes.organizationId, organizationId),
		columns: {
			id: true,
			label: true,
			role: true,
			passwordHash: true,
			emailDomain: true,
			expiresAt: true,
			guestExpiresAfterDays: true,
			lockedAt: true,
			createdAt: true,
			createdBy: true,
		},
		orderBy: desc(organizationInvitationCodes.createdAt),
	});
	return rows.map(summarizeInvitationCode);
};

export const createOrganizationInvitationCode = async (
	db: BackendDb,
	args: {
		organizationId: string;
		label: string;
		role: z.infer<typeof organizationInvitationCodeRoleSchema>;
		createdBy: string;
		password?: string;
		emailDomain?: string | null;
		expiresAt?: number | null;
		guestExpiresAfterDays?: number | null;
	},
): Promise<CreatedInvitationCode> => {
	const existing = await db.query.organizationInvitationCodes.findMany({
		where: eq(organizationInvitationCodes.organizationId, args.organizationId),
		columns: { id: true },
	});
	if (existing.length >= 3) {
		throw new Error("An organization can only have up to 3 invitation codes.");
	}

	const code = generateInvitationCode();
	const parsed = createOrganizationInvitationCodeInputSchema.parse({
		organizationId: args.organizationId,
		label: args.label,
		role: args.role,
		codeHash: await hashInvitationToken(code),
		passwordHash: args.password
			? await hashInvitationCodePassword(code, args.password)
			: null,
		emailDomain: normalizeDomain(args.emailDomain),
		expiresAt: args.expiresAt ?? null,
		guestExpiresAfterDays: args.guestExpiresAfterDays ?? null,
		createdBy: args.createdBy,
	});

	const [created] = await db
		.insert(organizationInvitationCodes)
		.values(parsed)
		.returning({
			id: organizationInvitationCodes.id,
			label: organizationInvitationCodes.label,
			role: organizationInvitationCodes.role,
			passwordHash: organizationInvitationCodes.passwordHash,
			emailDomain: organizationInvitationCodes.emailDomain,
			expiresAt: organizationInvitationCodes.expiresAt,
			guestExpiresAfterDays: organizationInvitationCodes.guestExpiresAfterDays,
			lockedAt: organizationInvitationCodes.lockedAt,
			createdAt: organizationInvitationCodes.createdAt,
			createdBy: organizationInvitationCodes.createdBy,
		});
	if (!created) throw new Error("Failed to create invitation code");
	return {
		...summarizeInvitationCode(created),
		code,
		organizationId: args.organizationId,
	};
};

export const setOrganizationInvitationCodeLocked = async (
	db: BackendDb,
	args: { organizationId: string; codeId: string; locked: boolean },
): Promise<InvitationCodeSummary | null> => {
	const [updated] = await db
		.update(organizationInvitationCodes)
		.set({ lockedAt: args.locked ? Date.now() : null, updatedAt: Date.now() })
		.where(
			and(
				eq(organizationInvitationCodes.id, args.codeId),
				eq(organizationInvitationCodes.organizationId, args.organizationId),
			),
		)
		.returning({
			id: organizationInvitationCodes.id,
			label: organizationInvitationCodes.label,
			role: organizationInvitationCodes.role,
			passwordHash: organizationInvitationCodes.passwordHash,
			emailDomain: organizationInvitationCodes.emailDomain,
			expiresAt: organizationInvitationCodes.expiresAt,
			guestExpiresAfterDays: organizationInvitationCodes.guestExpiresAfterDays,
			lockedAt: organizationInvitationCodes.lockedAt,
			createdAt: organizationInvitationCodes.createdAt,
			createdBy: organizationInvitationCodes.createdBy,
		});
	return updated ? summarizeInvitationCode(updated) : null;
};

export const deleteOrganizationInvitationCode = async (
	db: BackendDb,
	args: { organizationId: string; codeId: string },
): Promise<boolean> => {
	await db
		.delete(organizationInvitationCodes)
		.where(
			and(
				eq(organizationInvitationCodes.id, args.codeId),
				eq(organizationInvitationCodes.organizationId, args.organizationId),
			),
		);
	return true;
};

export const lookupInvitationCode = async (
	db: BackendDb,
	code: string,
): Promise<{
	codeId: string;
	organizationId: string;
	label: string;
	requiresPassword: boolean;
	emailDomain: string | null;
	guestExpiresAfterDays: number | null;
} | null> => {
	const row = await db.query.organizationInvitationCodes.findFirst({
		where: eq(
			organizationInvitationCodes.codeHash,
			await hashInvitationToken(code),
		),
		columns: {
			id: true,
			organizationId: true,
			label: true,
			passwordHash: true,
			emailDomain: true,
			expiresAt: true,
			guestExpiresAfterDays: true,
			lockedAt: true,
		},
	});
	if (
		!row ||
		row.lockedAt ||
		(row.expiresAt !== null && row.expiresAt <= Date.now())
	) {
		return null;
	}
	return {
		codeId: row.id,
		organizationId: row.organizationId,
		label: row.label,
		requiresPassword: Boolean(row.passwordHash),
		emailDomain: row.emailDomain,
		guestExpiresAfterDays: row.guestExpiresAfterDays,
	};
};

export const acceptInvitationByToken = async (
	db: BackendDb,
	args: {
		token: string;
		localUserId: string;
		userEmail?: string | null;
		password?: string;
	},
): Promise<{
	organizationId: string;
	role: "admin" | "moderator" | "developer" | "qa_engineer";
	invitationId: string;
	status: "accepted" | "pending_approval";
}> => {
	const tokenHash = await hashInvitationToken(args.token);
	const now = Date.now();

	return db.transaction(async (tx) => {
		const invitation = await tx.query.organizationInvitations.findFirst({
			where: and(
				eq(organizationInvitations.tokenHash, tokenHash),
				eq(organizationInvitations.status, "pending"),
				gt(organizationInvitations.expiresAt, now),
			),
			columns: {
				id: true,
				organizationId: true,
				role: true,
			},
		});
		if (invitation) {
			const role = normalizeOrganizationRoleKey(invitation.role);

			await tx
				.insert(organizationMembers)
				.values({
					organizationId: invitation.organizationId,
					userId: args.localUserId,
					role,
				})
				.onConflictDoNothing();

			await tx
				.update(organizationInvitations)
				.set({
					status: "accepted",
					acceptedBy: args.localUserId,
					acceptedAt: now,
					updatedAt: now,
				})
				.where(eq(organizationInvitations.id, invitation.id));

			await tx
				.update(users)
				.set({ activeOrgId: invitation.organizationId, updatedAt: now })
				.where(eq(users.id, args.localUserId));

			return {
				organizationId: invitation.organizationId,
				role,
				invitationId: invitation.id,
				status: "accepted",
			};
		}

		const code = await tx.query.organizationInvitationCodes.findFirst({
			where: eq(organizationInvitationCodes.codeHash, tokenHash),
			columns: {
				id: true,
				organizationId: true,
				role: true,
				passwordHash: true,
				emailDomain: true,
				expiresAt: true,
				guestExpiresAfterDays: true,
				lockedAt: true,
			},
		});
		if (
			!code ||
			code.lockedAt ||
			(code.expiresAt !== null && code.expiresAt <= now)
		) {
			throw new Error("Invitation is invalid, expired, or locked.");
		}
		if (code.passwordHash) {
			if (!args.password)
				throw new Error("This invitation code requires a password.");
			const incomingHash = await hashInvitationCodePassword(
				args.token,
				args.password,
			);
			if (incomingHash !== code.passwordHash) {
				throw new Error("Invitation code password is incorrect.");
			}
		}
		if (code.emailDomain) {
			const email = args.userEmail?.trim().toLowerCase() ?? "";
			if (!email.endsWith(`@${code.emailDomain}`)) {
				throw new Error(
					`This invitation code only accepts ${code.emailDomain} email addresses.`,
				);
			}
		}

		const role = normalizeOrganizationRoleKey(code.role);
		const guestExpiresAt = code.guestExpiresAfterDays
			? now + code.guestExpiresAfterDays * 24 * 60 * 60 * 1000
			: null;

		const organization = await tx.query.organizations.findFirst({
			where: eq(organizations.id, code.organizationId),
			columns: { requireInvitationApproval: true },
		});
		if (organization?.requireInvitationApproval) {
			const parsed = createOrganizationJoinRequestInputSchema.parse({
				organizationId: code.organizationId,
				userId: args.localUserId,
				invitationCodeId: code.id,
				requestedRole: role,
			});
			const existingRequest = await tx.query.organizationJoinRequests.findFirst(
				{
					where: and(
						eq(organizationJoinRequests.organizationId, code.organizationId),
						eq(organizationJoinRequests.userId, args.localUserId),
						eq(organizationJoinRequests.status, "pending"),
					),
					columns: { id: true },
				},
			);
			if (existingRequest) {
				await tx
					.update(organizationJoinRequests)
					.set({
						requestedRole: role,
						invitationCodeId: code.id,
						updatedAt: now,
					})
					.where(eq(organizationJoinRequests.id, existingRequest.id));
			} else {
				await tx.insert(organizationJoinRequests).values({
					...parsed,
					updatedAt: now,
				});
			}
			return {
				organizationId: code.organizationId,
				role,
				invitationId: code.id,
				status: "pending_approval",
			};
		}

		await tx
			.insert(organizationMembers)
			.values({
				organizationId: code.organizationId,
				userId: args.localUserId,
				role,
				guestExpiresAt,
				invitationCodeId: code.id,
			})
			.onConflictDoNothing();

		await tx
			.update(organizationMembers)
			.set({ role, guestExpiresAt, invitationCodeId: code.id })
			.where(
				and(
					eq(organizationMembers.organizationId, code.organizationId),
					eq(organizationMembers.userId, args.localUserId),
					isNull(organizationMembers.teamId),
				),
			);

		await tx
			.update(users)
			.set({ activeOrgId: code.organizationId, updatedAt: now })
			.where(eq(users.id, args.localUserId));

		return {
			organizationId: code.organizationId,
			role,
			invitationId: code.id,
			status: "accepted",
		};
	});
};

export const listOrganizationJoinRequests = async (
	db: BackendDb,
	args: {
		organizationId: string;
		runtime: { clerkSecretKey: string | undefined };
	},
): Promise<OrganizationJoinRequestSummary[]> => {
	const rows = await db.query.organizationJoinRequests.findMany({
		where: and(
			eq(organizationJoinRequests.organizationId, args.organizationId),
			eq(organizationJoinRequests.status, "pending"),
		),
		columns: {
			id: true,
			organizationId: true,
			userId: true,
			requestedRole: true,
			status: true,
			createdAt: true,
		},
		with: { user: { columns: { clerkUserId: true } } },
		orderBy: desc(organizationJoinRequests.createdAt),
	});

	return Promise.all(
		rows.map(async (row) => {
			const profile = await resolveClerkUserProfile(
				args.runtime,
				row.user.clerkUserId,
			).catch(() => fallbackClerkUserProfile(row.user.clerkUserId));
			return {
				id: row.id,
				organizationId: row.organizationId,
				userId: row.userId,
				clerkUserId: row.user.clerkUserId,
				displayName: formatClerkDisplayName({
					clerkUserId: row.user.clerkUserId,
					firstName: profile.firstName,
					lastName: profile.lastName,
					username: profile.username,
					email: profile.email,
				}),
				email: profile.email,
				requestedRole: normalizeOrganizationRoleKey(row.requestedRole),
				status: row.status,
				createdAt: row.createdAt,
			};
		}),
	);
};

export const reviewOrganizationJoinRequest = async (
	db: BackendDb,
	args: {
		organizationId: string;
		requestId: string;
		reviewerLocalUserId: string;
		decision: "approved" | "rejected";
	},
): Promise<{ requestId: string; status: "approved" | "rejected" }> => {
	const now = Date.now();
	return db.transaction(async (tx) => {
		const request = await tx.query.organizationJoinRequests.findFirst({
			where: and(
				eq(organizationJoinRequests.id, args.requestId),
				eq(organizationJoinRequests.organizationId, args.organizationId),
				eq(organizationJoinRequests.status, "pending"),
			),
			columns: {
				id: true,
				organizationId: true,
				userId: true,
				requestedRole: true,
				invitationCodeId: true,
			},
		});
		if (!request) throw new Error("Join request not found.");

		if (args.decision === "approved") {
			const existingMembership = await tx.query.organizationMembers.findFirst({
				where: and(
					eq(organizationMembers.organizationId, request.organizationId),
					eq(organizationMembers.userId, request.userId),
					isNull(organizationMembers.teamId),
				),
				columns: { id: true },
			});
			if (existingMembership) {
				await tx
					.update(organizationMembers)
					.set({
						role: normalizeOrganizationRoleKey(request.requestedRole),
						invitationCodeId: request.invitationCodeId,
					})
					.where(eq(organizationMembers.id, existingMembership.id));
			} else {
				await tx.insert(organizationMembers).values({
					organizationId: request.organizationId,
					userId: request.userId,
					role: normalizeOrganizationRoleKey(request.requestedRole),
					invitationCodeId: request.invitationCodeId,
				});
			}
		}

		await tx
			.update(organizationJoinRequests)
			.set({
				status: args.decision,
				reviewedBy: args.reviewerLocalUserId,
				reviewedAt: now,
				updatedAt: now,
			})
			.where(eq(organizationJoinRequests.id, request.id));

		return { requestId: request.id, status: args.decision };
	});
};

export const cleanupExpiredGuestMemberships = async (
	db: BackendDb,
	now = Date.now(),
): Promise<number> => {
	const expired = await db.query.organizationMembers.findMany({
		where: and(
			lt(organizationMembers.guestExpiresAt, now),
			isNull(organizationMembers.teamId),
		),
		columns: { id: true, role: true, organizationId: true },
	});
	const paused = new Set(
		(
			await db.query.organizationMigrationStates.findMany({
				where: inArray(organizationMigrationStates.accessState, [
					"importing",
					"synced_read_only",
					"finalizing_read_only",
					"completed_source_read_only",
					"ready_to_activate",
				]),
				columns: { organizationId: true },
			})
		).map((state) => state.organizationId),
	);
	const removable = expired.filter(
		(row) =>
			normalizeOrganizationRoleKey(row.role) !== "admin" &&
			!paused.has(row.organizationId),
	);
	for (const row of removable) {
		await db
			.delete(organizationMembers)
			.where(eq(organizationMembers.id, row.id));
	}
	return removable.length;
};
