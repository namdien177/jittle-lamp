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
	acceptInvitationByToken,
	createOrganization,
	createOrganizationInvitation,
	createOrganizationInvitationCode,
	deleteOrganizationInvitationCode,
	ensureOrganizationManager,
	ensureOrganizationMember,
	ensureOrganizationOwner,
	leaveOrganization,
	listOrganizationInvitationCodes,
	listOrganizationInvitations,
	listOrganizationMembers,
	listOrganizationsForUser,
	lookupInvitationCode,
	removeOrganizationMember,
	renameOrganization,
	revokeOrganizationInvitation,
	setOrganizationInvitationCodeLocked,
	updateOrganizationMemberRole,
} from "../services/organization-management";

const roleSchema = t.Union([
	t.Literal("owner"),
	t.Literal("moderator"),
	t.Literal("member"),
]);

const organizationSummarySchema = t.Object({
	id: t.String({ minLength: 1 }),
	name: t.String({ minLength: 1 }),
	role: t.String({ minLength: 1 }),
	isPersonal: t.Boolean(),
	memberCount: t.Number({ minimum: 0 }),
	createdAt: t.Number(),
	joinedAt: t.Number(),
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
	role: t.Union([t.Literal("moderator"), t.Literal("member")]),
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
	role: t.Optional(roleSchema),
	ttlMs: t.Optional(
		t.Number({ minimum: 60_000, maximum: 1000 * 60 * 60 * 24 * 60 }),
	),
});

const createInvitationCodeBodySchema = t.Object({
	label: t.String({ minLength: 1, maxLength: 80 }),
	role: t.Optional(t.Union([t.Literal("moderator"), t.Literal("member")])),
	password: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
	emailDomain: t.Optional(
		t.Union([t.String({ minLength: 3, maxLength: 120 }), t.Null()]),
	),
	expiresAt: t.Optional(t.Union([t.Number(), t.Null()])),
	guestExpiresAfterDays: t.Optional(
		t.Union([t.Number({ minimum: 1, maximum: 365 }), t.Null()]),
	),
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
					async ({ authContext, body, db, params, requestId, set }) => {
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
							await leaveOrganization(db, {
								organizationId: params.orgId,
								localUserId,
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
									t.Literal("owner"),
									t.Literal("moderator"),
									t.Literal("member"),
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
					async ({ authContext, body, db, params, requestId, set }) => {
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
							role: t.Union([t.Literal("moderator"), t.Literal("member")]),
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
							await removeOrganizationMember(db, {
								organizationId: params.orgId,
								actorLocalUserId: localUserId,
								membershipId: params.membershipId,
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
								"Only owners and moderators can manage invitations",
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
					async ({ authContext, body, db, params, requestId, set }) => {
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
								"Only owners and moderators can create invitations",
								403,
							);
						}
						const invitation = await createOrganizationInvitation(db, {
							organizationId: params.orgId,
							email: body.email,
							role: body.role ?? "member",
							invitedBy: localUserId,
							...(body.ttlMs !== undefined ? { ttlMs: body.ttlMs } : {}),
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
					async ({ authContext, body, db, params, requestId, set }) => {
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
								"Only owners and moderators can create invitation codes",
								403,
							);
						}
						try {
							const code = await createOrganizationInvitationCode(db, {
								organizationId: params.orgId,
								label: body.label,
								role: body.role ?? "member",
								createdBy: localUserId,
								emailDomain: body.emailDomain ?? null,
								expiresAt: body.expiresAt ?? null,
								guestExpiresAfterDays: body.guestExpiresAfterDays ?? null,
								...(body.password ? { password: body.password } : {}),
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
					async ({ authContext, body, db, params, requestId, set }) => {
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
								"Only owners can lock invitation codes",
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
								"Only owners and moderators can delete invitation codes",
								403,
							);
						}
						await deleteOrganizationInvitationCode(db, {
							organizationId: params.orgId,
							codeId: params.codeId,
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
								"Only owners and moderators can revoke invitations",
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
					async ({ authContext, body, db, requestId, runtime, set }) => {
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
