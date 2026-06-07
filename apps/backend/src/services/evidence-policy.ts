import { and, eq, isNull } from "drizzle-orm";

import { type OrganizationPermission, organizationMembers } from "../db/schema";

import {
	getOrganizationRolePermissions,
	normalizeOrganizationRoleKey,
} from "./organization-permissions";
import type { BackendDb } from "./user-provisioning";

type TeamEvidenceAccessPolicyContext = {
	organizationId: string;
	teamId: string;
	userId: string;
};

type TeamPolicyAdapter = {
	canViewEvidence: (
		context: TeamEvidenceAccessPolicyContext,
	) => Promise<boolean>;
	canShareEvidence: (
		context: TeamEvidenceAccessPolicyContext,
	) => Promise<boolean>;
	canMoveEvidence: (
		context: EvidenceMoveContext & { teamId: string },
	) => Promise<boolean>;
};

const defaultTeamPolicyAdapter: TeamPolicyAdapter = {
	canViewEvidence: async () => true,
	canShareEvidence: async () => true,
	canMoveEvidence: async () => true,
};

export type EvidencePolicyDeps = {
	teamPolicyAdapter?: TeamPolicyAdapter;
};

export type EvidenceAccessContext = {
	organizationId: string;
	teamId?: string | null;
	userId: string;
};

export type EvidenceMoveContext = EvidenceAccessContext & {
	sourceOrganizationId: string;
	targetOrganizationId: string;
	isEvidenceCreator: boolean;
	isSourceOrganizationCreator: boolean;
};

const authorizeTeamAction = async (
	teamPolicyAdapter: TeamPolicyAdapter,
	action: "view" | "share",
	context: EvidenceAccessContext,
): Promise<boolean> => {
	if (!context.teamId) {
		return true;
	}

	const teamContext: TeamEvidenceAccessPolicyContext = {
		organizationId: context.organizationId,
		teamId: context.teamId,
		userId: context.userId,
	};

	switch (action) {
		case "view":
			return teamPolicyAdapter.canViewEvidence(teamContext);
		case "share":
			return teamPolicyAdapter.canShareEvidence(teamContext);
	}
};

const authorizeTeamMoveAction = async (
	teamPolicyAdapter: TeamPolicyAdapter,
	context: EvidenceMoveContext,
): Promise<boolean> => {
	if (!context.teamId) {
		return true;
	}

	return teamPolicyAdapter.canMoveEvidence({
		...context,
		teamId: context.teamId,
	});
};

const resolveOrgMembershipRole = async (
	db: BackendDb,
	organizationId: string,
	userId: string,
): Promise<string | null> => {
	const membership = await db.query.organizationMembers.findFirst({
		where: and(
			eq(organizationMembers.organizationId, organizationId),
			eq(organizationMembers.userId, userId),
			isNull(organizationMembers.teamId),
		),
		columns: { role: true },
	});

	return membership?.role ?? null;
};

const memberHasPermission = async (
	db: BackendDb,
	organizationId: string,
	userId: string,
	permission: OrganizationPermission,
): Promise<boolean> => {
	const role = await resolveOrgMembershipRole(db, organizationId, userId);
	if (!role) return false;
	const permissions = await getOrganizationRolePermissions(db, {
		organizationId,
		role: normalizeOrganizationRoleKey(role),
	});
	return permissions.has(permission);
};

export const createEvidencePolicy = (deps: EvidencePolicyDeps = {}) => {
	const teamPolicyAdapter = deps.teamPolicyAdapter ?? defaultTeamPolicyAdapter;

	return {
		canViewEvidence: async (
			db: BackendDb,
			context: EvidenceAccessContext,
		): Promise<boolean> => {
			const hasMembership = await memberHasPermission(
				db,
				context.organizationId,
				context.userId,
				"evidence.view",
			);
			if (!hasMembership) {
				return false;
			}

			return authorizeTeamAction(teamPolicyAdapter, "view", context);
		},
		canShareEvidence: async (
			db: BackendDb,
			context: EvidenceAccessContext,
		): Promise<boolean> => {
			const hasMembership = await memberHasPermission(
				db,
				context.organizationId,
				context.userId,
				"evidence.download",
			);
			if (!hasMembership) {
				return false;
			}

			return authorizeTeamAction(teamPolicyAdapter, "share", context);
		},
		canMoveEvidence: async (
			db: BackendDb,
			context: EvidenceMoveContext,
		): Promise<boolean> => {
			const [canMoveOwn, canMoveAny, hasTargetMembership] = await Promise.all([
				memberHasPermission(
					db,
					context.sourceOrganizationId,
					context.userId,
					"evidence.move.own",
				),
				memberHasPermission(
					db,
					context.sourceOrganizationId,
					context.userId,
					"evidence.move.any",
				),
				memberHasPermission(
					db,
					context.targetOrganizationId,
					context.userId,
					"evidence.create",
				),
			]);

			if (!hasTargetMembership) {
				return false;
			}

			if (
				!(
					canMoveAny ||
					(canMoveOwn &&
						(context.isEvidenceCreator || context.isSourceOrganizationCreator))
				)
			) {
				return false;
			}

			return authorizeTeamMoveAction(teamPolicyAdapter, context);
		},
	};
};
