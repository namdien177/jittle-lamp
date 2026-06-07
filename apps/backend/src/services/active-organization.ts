import { and, eq, isNull } from "drizzle-orm";

import { organizationMembers, organizations, users } from "../db/schema";
import { ensureDefaultOrganizationRoles } from "./organization-permissions";
import type { BackendDb } from "./user-provisioning";

export type ResolvedActiveOrganization = {
	localUserId: string;
	organizationId: string;
};

export const resolveActiveOrganizationForClerkUser = async (
	db: BackendDb,
	clerkUserId: string,
	requestedOrganizationId?: string | null,
): Promise<ResolvedActiveOrganization | null> => {
	const localUser = await db.query.users.findFirst({
		where: eq(users.clerkUserId, clerkUserId),
		columns: { id: true, activeOrgId: true },
		with: {
			organizationMemberships: {
				columns: { organizationId: true },
				with: {
					organization: {
						columns: { id: true, isPersonal: true },
					},
				},
			},
		},
	});

	if (!localUser) {
		return null;
	}

	const membershipByOrganizationId = new Set(
		localUser.organizationMemberships.map(
			(membership) => membership.organization.id,
		),
	);

	if (requestedOrganizationId) {
		const orgScopeMembership = await db.query.organizationMembers.findFirst({
			where: and(
				eq(organizationMembers.organizationId, requestedOrganizationId),
				eq(organizationMembers.userId, localUser.id),
				isNull(organizationMembers.teamId),
			),
			columns: { id: true },
		});
		if (!orgScopeMembership) {
			return null;
		}
		return {
			localUserId: localUser.id,
			organizationId: requestedOrganizationId,
		};
	}

	if (
		localUser.activeOrgId &&
		membershipByOrganizationId.has(localUser.activeOrgId)
	) {
		return {
			localUserId: localUser.id,
			organizationId: localUser.activeOrgId,
		};
	}

	const personalMembership = localUser.organizationMemberships.find(
		(membership) => membership.organization.isPersonal,
	);

	if (personalMembership) {
		await db
			.update(users)
			.set({
				activeOrgId: personalMembership.organizationId,
				updatedAt: Date.now(),
			})
			.where(eq(users.id, localUser.id));
		return {
			localUserId: localUser.id,
			organizationId: personalMembership.organizationId,
		};
	}

	const firstMembership = localUser.organizationMemberships[0];
	if (firstMembership) {
		await db
			.update(users)
			.set({
				activeOrgId: firstMembership.organizationId,
				updatedAt: Date.now(),
			})
			.where(eq(users.id, localUser.id));
		return {
			localUserId: localUser.id,
			organizationId: firstMembership.organizationId,
		};
	}

	const ownedPersonalOrganization = await db.query.organizations.findFirst({
		where: eq(organizations.personalOwnerUserId, localUser.id),
		columns: { id: true },
	});
	if (!ownedPersonalOrganization) {
		return null;
	}

	await ensureDefaultOrganizationRoles(db, ownedPersonalOrganization.id);

	await db
		.insert(organizationMembers)
		.values({
			organizationId: ownedPersonalOrganization.id,
			userId: localUser.id,
			role: "admin",
		})
		.onConflictDoNothing();

	await db
		.update(users)
		.set({
			activeOrgId: ownedPersonalOrganization.id,
			updatedAt: Date.now(),
		})
		.where(eq(users.id, localUser.id));

	return {
		localUserId: localUser.id,
		organizationId: ownedPersonalOrganization.id,
	};
};

export const selectActiveOrganizationForClerkUser = async (
	db: BackendDb,
	clerkUserId: string,
	organizationId: string,
): Promise<ResolvedActiveOrganization | null> => {
	const resolved = await resolveActiveOrganizationForClerkUser(
		db,
		clerkUserId,
		organizationId,
	);
	if (!resolved) {
		return null;
	}

	await db
		.update(users)
		.set({
			activeOrgId: organizationId,
			updatedAt: Date.now(),
		})
		.where(eq(users.id, resolved.localUserId));

	return resolved;
};
