import { Elysia, t } from "elysia";

import {
	apiErrorSchema,
	createApiError,
	createDbUnavailableError,
} from "../http/api-error";
import {
	type ClerkAuthPlugin,
	requireSessionScope,
} from "../plugins/clerk-auth";
import { selectActiveOrganizationForClerkUser } from "../services/active-organization";
import {
	fallbackClerkUserProfile,
	resolveClerkUserProfile,
} from "../services/clerk-user-profile";
import {
	getRequestIpAddress,
	listOrganizationActivityLogs,
	recordOrganizationActivity,
} from "../services/organization-activity";
import {
	acceptInvitationByToken,
	createOrganization,
	createOrganizationInvitation,
	createOrganizationInvitationCode,
	deleteOrganizationAsLastAdmin,
	deleteOrganizationInvitationCode,
	ensureOrganizationManager,
	ensureOrganizationMember,
	ensureOrganizationOwner,
	leaveOrganization,
	listOrganizationInvitationCodes,
	listOrganizationInvitations,
	listOrganizationJoinRequests,
	listOrganizationMembers,
	listOrganizationRoles,
	listOrganizationsForUser,
	lookupInvitationCode,
	removeOrganizationMember,
	renameOrganization,
	reviewOrganizationJoinRequest,
	revokeOrganizationInvitation,
	setOrganizationInvitationCodeLocked,
	updateOrganizationMemberRole,
	updateOrganizationRolePermissions,
	updateOrganizationSettings,
} from "../services/organization-management";
import {
	allOrganizationPermissions,
	organizationMemberHasPermission,
} from "../services/organization-permissions";

const roleSchema = t.Union([
	t.Literal("admin"),
	t.Literal("moderator"),
	t.Literal("developer"),
	t.Literal("qa_engineer"),
]);

const organizationSummarySchema = t.Object({
	id: t.String({ minLength: 1 }),
	name: t.String({ minLength: 1 }),
	role: t.String({ minLength: 1 }),
	isPersonal: t.Boolean(),
	requireInvitationApproval: t.Boolean(),
	memberCount: t.Number({ minimum: 0 }),
	createdAt: t.Number(),
	joinedAt: t.Number(),
	migrationAccessState: t.Union([t.String(), t.Null()]),
	migrationDestinationWebOrigin: t.Union([t.String(), t.Null()]),
});

const memberSummarySchema = t.Object({
	membershipId: t.String({ minLength: 1 }),
	userId: t.String({ minLength: 1 }),
	clerkUserId: t.String({ minLength: 1 }),
	firstName: t.Union([t.String({ minLength: 1 }), t.Null()]),
	lastName: t.Union([t.String({ minLength: 1 }), t.Null()]),
	displayName: t.String({ minLength: 1 }),
	email: t.Union([t.String({ minLength: 1 }), t.Null()]),
	role: t.String({ minLength: 1 }),
	joinedAt: t.Number(),
	guestExpiresAt: t.Union([t.Number(), t.Null()]),
});

const invitationSummarySchema = t.Object({
	id: t.String({ minLength: 1 }),
	email: t.String({ minLength: 1 }),
	role: roleSchema,
	status: t.Union([
		t.Literal("pending"),
		t.Literal("accepted"),
		t.Literal("revoked"),
		t.Literal("expired"),
	]),
	expiresAt: t.Number(),
	createdAt: t.Number(),
	invitedBy: t.String({ minLength: 1 }),
});

const invitationCodeSchema = t.Object({
	id: t.String({ minLength: 1 }),
	label: t.String({ minLength: 1 }),
	role: roleSchema,
	hasPassword: t.Boolean(),
	emailDomain: t.Union([t.String({ minLength: 1 }), t.Null()]),
	expiresAt: t.Union([t.Number(), t.Null()]),
	guestExpiresAfterDays: t.Union([t.Number(), t.Null()]),
	lockedAt: t.Union([t.Number(), t.Null()]),
	createdAt: t.Number(),
	createdBy: t.String({ minLength: 1 }),
});

const createdInvitationCodeSchema = t.Composite([
	invitationCodeSchema,
	t.Object({
		code: t.String({ minLength: 1 }),
		organizationId: t.String({ minLength: 1 }),
	}),
]);

const createInvitationBodySchema = t.Object({
	email: t.String({ format: "email", minLength: 3, maxLength: 200 }),
	role: roleSchema,
	ttlMs: t.Optional(
		t.Number({ minimum: 60_000, maximum: 1000 * 60 * 60 * 24 * 60 }),
	),
});

const createInvitationCodeBodySchema = t.Object({
	label: t.String({ minLength: 1, maxLength: 80 }),
	role: roleSchema,
	password: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
	emailDomain: t.Optional(
		t.Union([t.String({ minLength: 3, maxLength: 120 }), t.Null()]),
	),
	expiresAt: t.Optional(t.Union([t.Number(), t.Null()])),
	guestExpiresAfterDays: t.Optional(
		t.Union([t.Number({ minimum: 1, maximum: 365 }), t.Null()]),
	),
});

const rolePermissionSchema = t.Union(
	allOrganizationPermissions.map((permission) => t.Literal(permission)) as [
		ReturnType<typeof t.Literal>,
		ReturnType<typeof t.Literal>,
		...Array<ReturnType<typeof t.Literal>>,
	],
);

const organizationRoleSchema = t.Object({
	key: roleSchema,
	name: t.String({ minLength: 1 }),
	permissions: t.Array(rolePermissionSchema),
	isSystem: t.Boolean(),
	updatedAt: t.Number(),
});

const joinRequestSchema = t.Object({
	id: t.String({ minLength: 1 }),
	organizationId: t.String({ minLength: 1 }),
	userId: t.String({ minLength: 1 }),
	clerkUserId: t.String({ minLength: 1 }),
	displayName: t.String({ minLength: 1 }),
	email: t.Union([t.String({ minLength: 1 }), t.Null()]),
	requestedRole: t.String({ minLength: 1 }),
	status: t.Union([
		t.Literal("pending"),
		t.Literal("approved"),
		t.Literal("rejected"),
	]),
	createdAt: t.Number(),
});

const activityLogSchema = t.Object({
	id: t.String({ minLength: 1 }),
	organizationId: t.String({ minLength: 1 }),
	actorUserId: t.Union([t.String({ minLength: 1 }), t.Null()]),
	action: t.String({ minLength: 1 }),
	entityType: t.String({ minLength: 1 }),
	entityId: t.Union([t.String({ minLength: 1 }), t.Null()]),
	message: t.String({ minLength: 1 }),
	metadata: t.Record(t.String(), t.Unknown()),
	ipAddress: t.Union([t.String({ minLength: 1 }), t.Null()]),
	createdAt: t.Number(),
});

const acceptInvitationBodySchema = t.Object({
	token: t.String({ minLength: 1 }),
	password: t.Optional(t.String({ minLength: 1 })),
});

const requireLocalUser = (
	localUserId: string | null | undefined,
	requestId: string,
	set: { status?: number | string },
) => {
	if (localUserId) return localUserId;
	set.status = 403;
	return createApiError(
		requestId,
		"ORG_CONTEXT_UNRESOLVED",
		"No local user found for current Clerk session",
		403,
	);
};

export const createOrganizationRoutes = (auth: ClerkAuthPlugin) =>
	new Elysia({ name: "organization-routes" })
		.use(auth)
		.guard({ auth: true }, (app) =>
			app
				.onBeforeHandle(
					({ authContext, requestId, set }) =>
						// Organization management is not a device-token capability; only
						// human (Clerk) sessions and the desktop companion hold org scopes.
						requireSessionScope(authContext, "org:read", requestId, set) ??
						undefined,
				)
				.get(
					"/orgs",
					async ({ authContext, db, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						return {
							organizations: await listOrganizationsForUser(db, localUserId),
						};
					},
					{
						response: {
							200: t.Object({
								organizations: t.Array(organizationSummarySchema),
							}),
							401: apiErrorSchema,
							403: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/orgs",
					async ({ authContext, body, db, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						const created = await createOrganization(db, {
							name: body.name,
							createdByLocalUserId: localUserId,
						});
						return { organization: created };
					},
					{
						body: t.Object({
							name: t.String({ minLength: 1, maxLength: 100 }),
						}),
						response: {
							200: t.Object({ organization: organizationSummarySchema }),
							401: apiErrorSchema,
							403: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.patch(
					"/orgs/:orgId",
					async ({
						authContext,
						body,
						db,
						params,
						request,
						requestId,
						set,
					}) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						if (
							!(await ensureOrganizationOwner(db, {
								organizationId: params.orgId,
								localUserId: localUserId,
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_OWNER_REQUIRED",
								"Only owners can rename organizations",
								403,
							);
						}
						await renameOrganization(db, {
							organizationId: params.orgId,
							name: body.name,
						});
						await recordOrganizationActivity(db, {
							organizationId: params.orgId,
							actorUserId: localUserId,
							action: "organization.renamed",
							entity: { type: "organization", id: params.orgId },
							message: `Renamed organization to ${body.name}`,
							metadata: { name: body.name },
							ipAddress: getRequestIpAddress(request),
						});
						return { organizationId: params.orgId, name: body.name };
					},
					{
						params: t.Object({ orgId: t.String({ minLength: 1 }) }),
						body: t.Object({
							name: t.String({ minLength: 1, maxLength: 100 }),
						}),
						response: {
							200: t.Object({ organizationId: t.String(), name: t.String() }),
							401: apiErrorSchema,
							403: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.delete(
					"/orgs/:orgId",
					async ({ authContext, db, params, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						try {
							await deleteOrganizationAsLastAdmin(db, {
								organizationId: params.orgId,
								localUserId,
							});
							return { ok: true };
						} catch (error) {
							set.status = 400;
							return createApiError(
								requestId,
								"ORG_DELETE_FAILED",
								error instanceof Error
									? error.message
									: "Unable to delete organization",
								400,
							);
						}
					},
					{
						params: t.Object({ orgId: t.String({ minLength: 1 }) }),
						response: {
							200: t.Object({ ok: t.Boolean() }),
							400: apiErrorSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/orgs/:orgId/select-active",
					async ({ authContext, db, params, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const selected = await selectActiveOrganizationForClerkUser(
							db,
							authContext.userId,
							params.orgId,
						);
						if (!selected) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_MEMBERSHIP_REQUIRED",
								"Selected organization must be a member organization",
								403,
							);
						}
						return { organizationId: selected.organizationId };
					},
					{
						params: t.Object({ orgId: t.String({ minLength: 1 }) }),
						response: {
							200: t.Object({ organizationId: t.String({ minLength: 1 }) }),
							401: apiErrorSchema,
							403: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/orgs/:orgId/leave",
					async ({ authContext, db, params, request, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						try {
							await leaveOrganization(db, {
								organizationId: params.orgId,
								localUserId,
							});
							await recordOrganizationActivity(db, {
								organizationId: params.orgId,
								actorUserId: localUserId,
								action: "organization.member.left",
								entity: { type: "member", id: localUserId },
								message: "Left organization",
								metadata: { userId: localUserId },
								ipAddress: getRequestIpAddress(request),
							});
							return { ok: true };
						} catch (error) {
							set.status = 400;
							return createApiError(
								requestId,
								"ORG_LEAVE_FAILED",
								error instanceof Error
									? error.message
									: "Unable to leave organization",
								400,
							);
						}
					},
					{
						params: t.Object({ orgId: t.String({ minLength: 1 }) }),
						response: {
							200: t.Object({ ok: t.Boolean() }),
							400: apiErrorSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.get(
					"/orgs/:orgId/members",
					async ({
						authContext,
						db,
						params,
						query,
						requestId,
						runtime,
						set,
					}) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						if (
							!(await ensureOrganizationMember(db, {
								organizationId: params.orgId,
								localUserId: localUserId,
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_MEMBERSHIP_REQUIRED",
								"You must be a member of this organization",
								403,
							);
						}
						return await listOrganizationMembers(db, {
							organizationId: params.orgId,
							runtime,
							currentLocalUserId: localUserId,
							search: query.search,
							role: query.role ?? "all",
							page: query.page,
							limit: query.limit,
						});
					},
					{
						params: t.Object({ orgId: t.String({ minLength: 1 }) }),
						query: t.Object({
							search: t.Optional(t.String()),
							role: t.Optional(
								t.Union([
									t.Literal("all"),
									t.Literal("admin"),
									t.Literal("moderator"),
									t.Literal("developer"),
									t.Literal("qa_engineer"),
								]),
							),
							page: t.Optional(t.Number({ minimum: 1 })),
							limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
						}),
						response: {
							200: t.Object({
								members: t.Array(memberSummarySchema),
								total: t.Number({ minimum: 0 }),
								page: t.Number({ minimum: 1 }),
								limit: t.Number({ minimum: 1 }),
							}),
							401: apiErrorSchema,
							403: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.patch(
					"/orgs/:orgId/members/:membershipId",
					async ({
						authContext,
						body,
						db,
						params,
						request,
						requestId,
						set,
					}) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						try {
							await updateOrganizationMemberRole(db, {
								organizationId: params.orgId,
								actorLocalUserId: localUserId,
								membershipId: params.membershipId,
								role: body.role,
							});
							await recordOrganizationActivity(db, {
								organizationId: params.orgId,
								actorUserId: localUserId,
								action: "organization.member.role_updated",
								entity: { type: "member", id: params.membershipId },
								message: `Assigned member role ${body.role}`,
								metadata: {
									membershipId: params.membershipId,
									role: body.role,
								},
								ipAddress: getRequestIpAddress(request),
							});
							return { ok: true };
						} catch (error) {
							set.status = 400;
							return createApiError(
								requestId,
								"ORG_MEMBER_UPDATE_FAILED",
								error instanceof Error
									? error.message
									: "Unable to update member",
								400,
							);
						}
					},
					{
						params: t.Object({ orgId: t.String(), membershipId: t.String() }),
						body: t.Object({
							role: roleSchema,
						}),
						response: {
							200: t.Object({ ok: t.Boolean() }),
							400: apiErrorSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.delete(
					"/orgs/:orgId/members/:membershipId",
					async ({ authContext, db, params, request, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						try {
							await removeOrganizationMember(db, {
								organizationId: params.orgId,
								actorLocalUserId: localUserId,
								membershipId: params.membershipId,
							});
							await recordOrganizationActivity(db, {
								organizationId: params.orgId,
								actorUserId: localUserId,
								action: "organization.member.removed",
								entity: { type: "member", id: params.membershipId },
								message: "Removed member from organization",
								metadata: { membershipId: params.membershipId },
								ipAddress: getRequestIpAddress(request),
							});
							return { ok: true };
						} catch (error) {
							set.status = 400;
							return createApiError(
								requestId,
								"ORG_MEMBER_REMOVE_FAILED",
								error instanceof Error
									? error.message
									: "Unable to remove member",
								400,
							);
						}
					},
					{
						params: t.Object({ orgId: t.String(), membershipId: t.String() }),
						response: {
							200: t.Object({ ok: t.Boolean() }),
							400: apiErrorSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.patch(
					"/orgs/:orgId/settings",
					async ({
						authContext,
						body,
						db,
						params,
						request,
						requestId,
						set,
					}) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						if (
							!(await ensureOrganizationOwner(db, {
								organizationId: params.orgId,
								localUserId: localUserId,
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_SETTINGS_FORBIDDEN",
								"Only admins can update organization settings",
								403,
							);
						}
						const settings = await updateOrganizationSettings(db, {
							organizationId: params.orgId,
							requireInvitationApproval: body.requireInvitationApproval,
						});
						await recordOrganizationActivity(db, {
							organizationId: params.orgId,
							actorUserId: localUserId,
							action: "organization.settings.updated",
							entity: { type: "organization", id: params.orgId },
							message: "Updated organization settings",
							metadata: settings,
							ipAddress: getRequestIpAddress(request),
						});
						return { settings };
					},
					{
						params: t.Object({ orgId: t.String({ minLength: 1 }) }),
						body: t.Object({ requireInvitationApproval: t.Boolean() }),
						response: {
							200: t.Object({
								settings: t.Object({
									organizationId: t.String({ minLength: 1 }),
									requireInvitationApproval: t.Boolean(),
								}),
							}),
							401: apiErrorSchema,
							403: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.get(
					"/orgs/:orgId/roles",
					async ({ authContext, db, params, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						if (
							!(await ensureOrganizationMember(db, {
								organizationId: params.orgId,
								localUserId,
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_MEMBERSHIP_REQUIRED",
								"You must be a member of this organization",
								403,
							);
						}
						return {
							permissions: [...allOrganizationPermissions],
							roles: await listOrganizationRoles(db, params.orgId),
						};
					},
					{
						params: t.Object({ orgId: t.String({ minLength: 1 }) }),
						response: {
							200: t.Object({
								permissions: t.Array(rolePermissionSchema),
								roles: t.Array(organizationRoleSchema),
							}),
							401: apiErrorSchema,
							403: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.patch(
					"/orgs/:orgId/roles/:role",
					async ({
						authContext,
						body,
						db,
						params,
						request,
						requestId,
						set,
					}) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						if (
							!(await ensureOrganizationOwner(db, {
								organizationId: params.orgId,
								localUserId: localUserId,
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_ROLE_MANAGE_FORBIDDEN",
								"Only admins can update role permissions",
								403,
							);
						}
						try {
							const role = await updateOrganizationRolePermissions(db, {
								organizationId: params.orgId,
								role: params.role,
								permissions: body.permissions as string[],
							});
							await recordOrganizationActivity(db, {
								organizationId: params.orgId,
								actorUserId: localUserId,
								action: "organization.role.updated",
								entity: { type: "role", id: role.key },
								message: `Updated ${role.name} permissions`,
								metadata: { role: role.key, permissions: role.permissions },
								ipAddress: getRequestIpAddress(request),
							});
							return { role };
						} catch (error) {
							set.status = 400;
							return createApiError(
								requestId,
								"ORG_ROLE_UPDATE_FAILED",
								error instanceof Error
									? error.message
									: "Unable to update role",
								400,
							);
						}
					},
					{
						params: t.Object({
							orgId: t.String({ minLength: 1 }),
							role: roleSchema,
						}),
						body: t.Object({ permissions: t.Array(rolePermissionSchema) }),
						response: {
							200: t.Object({ role: organizationRoleSchema }),
							400: apiErrorSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.get(
					"/orgs/:orgId/join-requests",
					async ({ authContext, db, params, requestId, runtime, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: params.orgId,
								localUserId,
								permission: "join_requests.manage",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_JOIN_REQUESTS_FORBIDDEN",
								"Only moderators and admins can view join requests",
								403,
							);
						}
						return {
							requests: await listOrganizationJoinRequests(db, {
								organizationId: params.orgId,
								runtime,
							}),
						};
					},
					{
						params: t.Object({ orgId: t.String({ minLength: 1 }) }),
						response: {
							200: t.Object({ requests: t.Array(joinRequestSchema) }),
							401: apiErrorSchema,
							403: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/orgs/:orgId/join-requests/:joinRequestId/review",
					async ({
						authContext,
						body,
						db,
						params,
						request,
						requestId,
						set,
					}) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: params.orgId,
								localUserId,
								permission: "join_requests.manage",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_JOIN_REQUESTS_FORBIDDEN",
								"Only moderators and admins can review join requests",
								403,
							);
						}
						const review = await reviewOrganizationJoinRequest(db, {
							organizationId: params.orgId,
							requestId: params.joinRequestId,
							reviewerLocalUserId: localUserId,
							decision: body.decision,
						});
						await recordOrganizationActivity(db, {
							organizationId: params.orgId,
							actorUserId: localUserId,
							action: `organization.join_request.${review.status}`,
							entity: { type: "join_request", id: review.requestId },
							message: `${review.status === "approved" ? "Approved" : "Rejected"} join request`,
							metadata: review,
							ipAddress: getRequestIpAddress(request),
						});
						return { review };
					},
					{
						params: t.Object({
							orgId: t.String({ minLength: 1 }),
							joinRequestId: t.String({ minLength: 1 }),
						}),
						body: t.Object({
							decision: t.Union([t.Literal("approved"), t.Literal("rejected")]),
						}),
						response: {
							200: t.Object({
								review: t.Object({
									requestId: t.String({ minLength: 1 }),
									status: t.Union([
										t.Literal("approved"),
										t.Literal("rejected"),
									]),
								}),
							}),
							401: apiErrorSchema,
							403: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.get(
					"/orgs/:orgId/activity",
					async ({ authContext, db, params, query, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: params.orgId,
								localUserId,
								permission: "activity.view",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_ACTIVITY_FORBIDDEN",
								"Only moderators and admins can view activity logs",
								403,
							);
						}
						return await listOrganizationActivityLogs(db, {
							organizationId: params.orgId,
							userId: query.userId,
							action: query.action,
							from: query.from,
							to: query.to,
							page: query.page,
							limit: query.limit,
						});
					},
					{
						params: t.Object({ orgId: t.String({ minLength: 1 }) }),
						query: t.Object({
							userId: t.Optional(t.String({ minLength: 1 })),
							action: t.Optional(t.String({ minLength: 1 })),
							from: t.Optional(t.Number({ minimum: 0 })),
							to: t.Optional(t.Number({ minimum: 0 })),
							page: t.Optional(t.Number({ minimum: 1 })),
							limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
						}),
						response: {
							200: t.Object({
								logs: t.Array(activityLogSchema),
								page: t.Number({ minimum: 1 }),
								limit: t.Number({ minimum: 1 }),
							}),
							401: apiErrorSchema,
							403: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.get(
					"/orgs/:orgId/invitations",
					async ({ authContext, db, params, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						if (
							!(await ensureOrganizationManager(db, {
								organizationId: params.orgId,
								localUserId: localUserId,
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_MANAGER_REQUIRED",
								"Only permitted members can manage invitations",
								403,
							);
						}
						return {
							invitations: await listOrganizationInvitations(db, params.orgId),
							codes: await listOrganizationInvitationCodes(db, params.orgId),
						};
					},
					{
						params: t.Object({ orgId: t.String({ minLength: 1 }) }),
						response: {
							200: t.Object({
								invitations: t.Array(invitationSummarySchema),
								codes: t.Array(invitationCodeSchema),
							}),
							401: apiErrorSchema,
							403: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/orgs/:orgId/invitations",
					async ({
						authContext,
						body,
						db,
						params,
						request,
						requestId,
						set,
					}) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						if (
							!(await ensureOrganizationOwner(db, {
								organizationId: params.orgId,
								localUserId: localUserId,
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_INVITATION_CREATE_FORBIDDEN",
								"Only admins can create invitations",
								403,
							);
						}
						const invitation = await createOrganizationInvitation(db, {
							organizationId: params.orgId,
							email: body.email,
							role: body.role,
							invitedBy: localUserId,
							...(body.ttlMs !== undefined ? { ttlMs: body.ttlMs } : {}),
						});
						await recordOrganizationActivity(db, {
							organizationId: params.orgId,
							actorUserId: localUserId,
							action: "organization.invitation.created",
							entity: { type: "invitation", id: invitation.id },
							message: `Created invitation for ${invitation.email}`,
							metadata: { role: invitation.role },
							ipAddress: getRequestIpAddress(request),
						});
						return { invitation };
					},
					{
						params: t.Object({ orgId: t.String({ minLength: 1 }) }),
						body: createInvitationBodySchema,
						response: {
							200: t.Object({
								invitation: t.Composite([
									invitationSummarySchema,
									t.Object({ organizationId: t.String(), token: t.String() }),
								]),
							}),
							401: apiErrorSchema,
							403: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/orgs/:orgId/invitation-codes",
					async ({
						authContext,
						body,
						db,
						params,
						request,
						requestId,
						set,
					}) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						if (
							!(await ensureOrganizationOwner(db, {
								organizationId: params.orgId,
								localUserId: localUserId,
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_INVITATION_CREATE_FORBIDDEN",
								"Only admins can create invitation codes",
								403,
							);
						}
						try {
							const code = await createOrganizationInvitationCode(db, {
								organizationId: params.orgId,
								label: body.label,
								role: body.role,
								createdBy: localUserId,
								emailDomain: body.emailDomain ?? null,
								expiresAt: body.expiresAt ?? null,
								guestExpiresAfterDays: body.guestExpiresAfterDays ?? null,
								...(body.password ? { password: body.password } : {}),
							});
							await recordOrganizationActivity(db, {
								organizationId: params.orgId,
								actorUserId: localUserId,
								action: "organization.invitation_code.created",
								entity: { type: "invitation_code", id: code.id },
								message: `Created invitation link ${code.label}`,
								metadata: { role: code.role },
								ipAddress: getRequestIpAddress(request),
							});
							return { code };
						} catch (error) {
							set.status = 400;
							return createApiError(
								requestId,
								"INVITATION_CODE_CREATE_FAILED",
								error instanceof Error
									? error.message
									: "Unable to create invitation code",
								400,
							);
						}
					},
					{
						params: t.Object({ orgId: t.String() }),
						body: createInvitationCodeBodySchema,
						response: {
							200: t.Object({ code: createdInvitationCodeSchema }),
							400: apiErrorSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/orgs/:orgId/invitation-codes/:codeId/lock",
					async ({
						authContext,
						body,
						db,
						params,
						request,
						requestId,
						set,
					}) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: params.orgId,
								localUserId,
								permission: "invitations.disable",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_INVITATION_DISABLE_FORBIDDEN",
								"Only moderators and admins can disable invitation codes",
								403,
							);
						}
						const code = await setOrganizationInvitationCodeLocked(db, {
							organizationId: params.orgId,
							codeId: params.codeId,
							locked: body.locked,
						});
						if (!code) {
							set.status = 404;
							return createApiError(
								requestId,
								"INVITATION_CODE_NOT_FOUND",
								"Invitation code not found",
								404,
							);
						}
						await recordOrganizationActivity(db, {
							organizationId: params.orgId,
							actorUserId: localUserId,
							action: body.locked
								? "organization.invitation_code.locked"
								: "organization.invitation_code.unlocked",
							entity: { type: "invitation_code", id: code.id },
							message: `${body.locked ? "Locked" : "Unlocked"} invitation link ${code.label}`,
							metadata: { role: code.role, locked: body.locked },
							ipAddress: getRequestIpAddress(request),
						});
						return { code };
					},
					{
						params: t.Object({ orgId: t.String(), codeId: t.String() }),
						body: t.Object({ locked: t.Boolean() }),
						response: {
							200: t.Object({ code: invitationCodeSchema }),
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.delete(
					"/orgs/:orgId/invitation-codes/:codeId",
					async ({ authContext, db, params, request, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: params.orgId,
								localUserId,
								permission: "invitations.disable",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_INVITATION_DISABLE_FORBIDDEN",
								"Only moderators and admins can delete invitation codes",
								403,
							);
						}
						await deleteOrganizationInvitationCode(db, {
							organizationId: params.orgId,
							codeId: params.codeId,
						});
						await recordOrganizationActivity(db, {
							organizationId: params.orgId,
							actorUserId: localUserId,
							action: "organization.invitation_code.deleted",
							entity: { type: "invitation_code", id: params.codeId },
							message: "Deleted invitation link",
							metadata: { codeId: params.codeId },
							ipAddress: getRequestIpAddress(request),
						});
						return { ok: true };
					},
					{
						params: t.Object({ orgId: t.String(), codeId: t.String() }),
						response: {
							200: t.Object({ ok: t.Boolean() }),
							401: apiErrorSchema,
							403: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/orgs/:orgId/invitations/:invitationId/revoke",
					async ({ authContext, db, params, request, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: params.orgId,
								localUserId,
								permission: "invitations.disable",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_INVITATION_DISABLE_FORBIDDEN",
								"Only moderators and admins can revoke invitations",
								403,
							);
						}
						const revoked = await revokeOrganizationInvitation(db, {
							organizationId: params.orgId,
							invitationId: params.invitationId,
						});
						if (!revoked) {
							set.status = 404;
							return createApiError(
								requestId,
								"INVITATION_NOT_FOUND",
								"Invitation not found or already finalized",
								404,
							);
						}
						await recordOrganizationActivity(db, {
							organizationId: params.orgId,
							actorUserId: localUserId,
							action: "organization.invitation.revoked",
							entity: { type: "invitation", id: revoked.id },
							message: `Revoked invitation for ${revoked.email}`,
							metadata: { role: revoked.role },
							ipAddress: getRequestIpAddress(request),
						});
						return { invitation: revoked };
					},
					{
						params: t.Object({
							orgId: t.String({ minLength: 1 }),
							invitationId: t.String({ minLength: 1 }),
						}),
						response: {
							200: t.Object({ invitation: invitationSummarySchema }),
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/orgs/invitations/lookup",
					async ({ body, db, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const code = await lookupInvitationCode(db, body.token);
						if (!code) {
							set.status = 404;
							return createApiError(
								requestId,
								"INVITATION_CODE_NOT_FOUND",
								"Invitation code not found, expired, or locked",
								404,
							);
						}
						return { code };
					},
					{
						body: t.Object({ token: t.String({ minLength: 1 }) }),
						response: {
							200: t.Object({
								code: t.Object({
									codeId: t.String(),
									organizationId: t.String(),
									label: t.String(),
									requiresPassword: t.Boolean(),
									emailDomain: t.Union([t.String(), t.Null()]),
									guestExpiresAfterDays: t.Union([t.Number(), t.Null()]),
								}),
							}),
							404: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/orgs/invitations/accept",
					async ({
						authContext,
						body,
						db,
						request,
						requestId,
						runtime,
						set,
					}) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						const localUserId = requireLocalUser(
							authContext.localUserId,
							requestId,
							set,
						);
						if (typeof localUserId !== "string") return localUserId;
						try {
							const profile = await resolveClerkUserProfile(
								runtime,
								authContext.userId,
							).catch(() => fallbackClerkUserProfile(authContext.userId));
							const result = await acceptInvitationByToken(db, {
								token: body.token,
								localUserId: localUserId,
								userEmail: profile.email,
								...(body.password ? { password: body.password } : {}),
							});
							await recordOrganizationActivity(db, {
								organizationId: result.organizationId,
								actorUserId: localUserId,
								action:
									result.status === "accepted"
										? "organization.invitation.accepted"
										: "organization.join_request.created",
								entity: {
									type:
										result.status === "accepted"
											? "invitation"
											: "invitation_code",
									id: result.invitationId,
								},
								message:
									result.status === "accepted"
										? "Accepted organization invitation"
										: "Requested to join organization",
								metadata: { role: result.role, status: result.status },
								ipAddress: getRequestIpAddress(request),
							});
							return result;
						} catch (error) {
							set.status = 400;
							return createApiError(
								requestId,
								"INVITATION_NOT_ACCEPTABLE",
								error instanceof Error
									? error.message
									: "Unable to accept invitation",
								400,
							);
						}
					},
					{
						body: acceptInvitationBodySchema,
						response: {
							200: t.Object({
								organizationId: t.String(),
								role: roleSchema,
								invitationId: t.String(),
								status: t.Union([
									t.Literal("accepted"),
									t.Literal("pending_approval"),
								]),
							}),
							400: apiErrorSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				),
		);
