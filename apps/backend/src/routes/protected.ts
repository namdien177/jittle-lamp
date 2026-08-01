import { and, eq, inArray, isNull } from "drizzle-orm";
import { Elysia, t } from "elysia";

import {
	organizationMembers,
	organizationMigrationLinks,
	organizationMigrationStates,
} from "../db/schema";
import { apiErrorSchema } from "../http/api-error";
import type { ClerkAuthPlugin } from "../plugins/clerk-auth";
import {
	fallbackClerkUserProfile,
	formatClerkDisplayName,
	resolveClerkUserProfile,
} from "../services/clerk-user-profile";
import { normalizeOrganizationRoleKey } from "../services/organization-permissions";

type ClerkUserSummary = {
	id: string;
	displayName: string;
	email: string | null;
	imageUrl: string | null;
};

const userSummarySchema = t.Object({
	id: t.String({ minLength: 1 }),
	displayName: t.String({ minLength: 1 }),
	email: t.Union([t.String({ minLength: 1 }), t.Null()]),
	imageUrl: t.Union([t.String({ minLength: 1 }), t.Null()]),
});

const organizationSummarySchema = t.Object({
	id: t.String({ minLength: 1 }),
	name: t.String({ minLength: 1 }),
	role: t.String({ minLength: 1 }),
	isPersonal: t.Boolean(),
	isActive: t.Boolean(),
	migrationAccessState: t.Union([t.String(), t.Null()]),
	migrationDestinationWebOrigin: t.Union([t.String(), t.Null()]),
});

const protectedMeResponseSchema = t.Object({
	userId: t.String({ minLength: 1 }),
	localUserId: t.Union([t.String({ minLength: 1 }), t.Null()]),
	orgId: t.Union([t.String({ minLength: 1 }), t.Null()]),
	activeOrgId: t.Union([t.String({ minLength: 1 }), t.Null()]),
	roles: t.Array(t.String({ minLength: 1 })),
	scopes: t.Array(t.String({ minLength: 1 })),
	user: userSummarySchema,
	organizations: t.Array(organizationSummarySchema),
});

const resolveClerkUserSummary = async (
	runtime: { clerkSecretKey: string | undefined },
	clerkUserId: string,
): Promise<ClerkUserSummary> => {
	const profile = runtime.clerkSecretKey
		? await resolveClerkUserProfile(runtime, clerkUserId)
		: fallbackClerkUserProfile(clerkUserId);

	return {
		id: profile.id,
		displayName: formatClerkDisplayName({
			clerkUserId,
			firstName: profile.firstName,
			lastName: profile.lastName,
			username: profile.username,
			email: profile.email,
		}),
		email: profile.email,
		imageUrl: profile.imageUrl,
	};
};

export const createProtectedRoutes = (auth: ClerkAuthPlugin) =>
	new Elysia({ name: "protected-routes" })
		.use(auth)
		.guard({ auth: true }, (app) =>
			app.get(
				"/protected/me",
				async ({ authContext, db, requestLogger, runtime }) => {
					let user: ClerkUserSummary = {
						id: authContext.userId,
						displayName: authContext.userId,
						email: null,
						imageUrl: null,
					};
					try {
						user = await resolveClerkUserSummary(runtime, authContext.userId);
					} catch (error) {
						requestLogger.warn(
							{ err: error, clerkUserId: authContext.userId },
							"failed to resolve Clerk user profile",
						);
					}

					const memberships =
						db && authContext.localUserId
							? await db.query.organizationMembers.findMany({
									where: and(
										eq(organizationMembers.userId, authContext.localUserId),
										isNull(organizationMembers.teamId),
									),
									columns: {
										organizationId: true,
										role: true,
									},
									with: {
										organization: {
											columns: {
												id: true,
												name: true,
												isPersonal: true,
											},
										},
									},
								})
							: [];

					const migrationStates =
						db && memberships.length > 0
							? await db
									.select()
									.from(organizationMigrationStates)
									.where(
										inArray(
											organizationMigrationStates.organizationId,
											memberships.map(
												(membership) => membership.organizationId,
											),
										),
									)
							: [];
					const stateByOrganization = new Map(
						migrationStates.map(
							(state) => [state.organizationId, state] as const,
						),
					);
					const migrationLinks =
						db && migrationStates.length > 0
							? await db
									.select({
										id: organizationMigrationLinks.id,
										lastSuccessfulAt:
											organizationMigrationLinks.lastSuccessfulAt,
									})
									.from(organizationMigrationLinks)
									.where(
										inArray(
											organizationMigrationLinks.id,
											migrationStates.map((state) => state.linkId),
										),
									)
							: [];
					const linkById = new Map(
						migrationLinks.map((link) => [link.id, link] as const),
					);
					const organizations = memberships
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
							isActive: membership.organization.id === authContext.activeOrgId,
							migrationAccessState:
								stateByOrganization.get(membership.organizationId)
									?.accessState ?? null,
							migrationDestinationWebOrigin:
								stateByOrganization.get(membership.organizationId)
									?.destinationWebOrigin ?? null,
						}));

					return {
						userId: authContext.userId,
						localUserId: authContext.localUserId,
						orgId: authContext.orgId,
						activeOrgId: authContext.activeOrgId,
						roles: authContext.roles,
						scopes: authContext.scopes,
						user,
						organizations,
					};
				},
				{
					detail: {
						tags: ["auth"],
						summary: "Returns auth context for current request",
					},
					response: {
						200: protectedMeResponseSchema,
						401: apiErrorSchema,
						500: apiErrorSchema,
					},
				},
			),
		);
