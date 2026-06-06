import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { evidences, organizations, shareLinks } from "../db/schema";
import {
	apiErrorSchema,
	createApiError,
	createDbUnavailableError,
} from "../http/api-error";
import {
	type ClerkAuthPlugin,
	requireSessionScope,
} from "../plugins/clerk-auth";
import { createEvidencePolicy } from "../services/evidence-policy";

const createShareLinkBodySchema = t.Object({
	expiresInMs: t.Optional(
		t.Number({
			minimum: 60_000,
			maximum: 1000 * 60 * 60 * 24 * 365,
		}),
	),
});

const evidenceIdParamsSchema = t.Object({
	id: t.String({ minLength: 1 }),
});

const tokenParamsSchema = t.Object({
	token: t.String({ minLength: 1 }),
});

const shareLinkResponseSchema = t.Object({
	shareLink: t.Object({
		id: t.String({ minLength: 1 }),
		token: t.String({ minLength: 1 }),
		evidenceId: t.String({ minLength: 1 }),
		orgId: t.String({ minLength: 1 }),
		expiresAt: t.Number(),
		scope: t.Literal("internal"),
	}),
});

const resolvedShareLinkResponseSchema = t.Object({
	shareLink: t.Object({
		id: t.String({ minLength: 1 }),
		evidenceId: t.String({ minLength: 1 }),
		orgId: t.String({ minLength: 1 }),
		expiresAt: t.Number(),
		access: t.Union([t.Literal("granted"), t.Literal("denied")]),
	}),
	organization: t.Object({
		id: t.String({ minLength: 1 }),
		name: t.String({ minLength: 1 }),
	}),
});

const revokedShareLinkResponseSchema = t.Object({
	shareLink: t.Object({
		id: t.String({ minLength: 1 }),
		revokedAt: t.Number(),
	}),
});

const shareLinkSummarySchema = t.Object({
	id: t.String({ minLength: 1 }),
	evidenceId: t.String({ minLength: 1 }),
	orgId: t.String({ minLength: 1 }),
	scope: t.Literal("internal"),
	createdAt: t.Number(),
	expiresAt: t.Number(),
	revokedAt: t.Union([t.Number(), t.Null()]),
	createdBy: t.String({ minLength: 1 }),
});

const listShareLinksResponseSchema = t.Object({
	shareLinks: t.Array(shareLinkSummarySchema),
});

const hashToken = async (token: string): Promise<string> => {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return Array.from(new Uint8Array(digest))
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
};

const createForbiddenPayload = (requestId: string) =>
	createApiError(
		requestId,
		"SHARE_LINK_FORBIDDEN",
		"You do not have access to this evidence share link",
		403,
	);

export const createShareLinkRoutes = (auth: ClerkAuthPlugin) =>
	new Elysia({ name: "share-link-routes" })
		.use(auth)
		.guard({ auth: true }, (app) =>
			app
				.post(
					"/evidences/:id/share-links",
					async ({ authContext, body, db, params, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						const scopeDenied = requireSessionScope(
							authContext,
							"share:write",
							requestId,
							set,
						);
						if (scopeDenied) {
							return scopeDenied;
						}

						if (!authContext.localUserId) {
							set.status = 403;
							return createForbiddenPayload(requestId);
						}

						const evidencePolicy = createEvidencePolicy();
						const evidence = await db.query.evidences.findFirst({
							where: eq(evidences.id, params.id),
							columns: { id: true, orgId: true, teamId: true },
						});
						if (!evidence) {
							set.status = 404;
							return createApiError(
								requestId,
								"EVIDENCE_NOT_FOUND",
								"Evidence not found",
								404,
							);
						}

						const canAccess = await evidencePolicy.canShareEvidence(db, {
							organizationId: evidence.orgId,
							teamId: evidence.teamId,
							userId: authContext.localUserId,
						});
						if (!canAccess) {
							set.status = 403;
							return createForbiddenPayload(requestId);
						}

						const rawToken = crypto.randomUUID();
						const now = Date.now();
						const expiresAt = now + (body.expiresInMs ?? 1000 * 60 * 60 * 24);
						const tokenHash = await hashToken(rawToken);

						const [inserted] = await db
							.insert(shareLinks)
							.values({
								tokenHash,
								evidenceId: evidence.id,
								orgId: evidence.orgId,
								teamId: evidence.teamId,
								scopeType: "organization",
								scopeId: evidence.orgId,
								expiresAt,
								createdBy: authContext.localUserId,
								updatedAt: now,
							})
							.returning({
								id: shareLinks.id,
								evidenceId: shareLinks.evidenceId,
								orgId: shareLinks.orgId,
								expiresAt: shareLinks.expiresAt,
							});

						if (!inserted) {
							set.status = 500;
							return createApiError(
								requestId,
								"SHARE_LINK_CREATE_FAILED",
								"Failed to create share link",
								500,
							);
						}

						return {
							shareLink: {
								id: inserted.id,
								token: rawToken,
								evidenceId: inserted.evidenceId,
								orgId: inserted.orgId,
								expiresAt: inserted.expiresAt,
								scope: "internal",
							},
						};
					},
					{
						params: evidenceIdParamsSchema,
						body: createShareLinkBodySchema,
						detail: {
							tags: ["evidences"],
							summary: "Creates an internal organization-scoped share link",
						},
						response: {
							200: shareLinkResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.get(
					"/evidences/:id/share-links",
					async ({ authContext, db, params, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						if (!authContext.localUserId) {
							set.status = 403;
							return createForbiddenPayload(requestId);
						}

						const evidence = await db.query.evidences.findFirst({
							where: eq(evidences.id, params.id),
							columns: { id: true, orgId: true, teamId: true },
						});
						if (!evidence) {
							set.status = 404;
							return createApiError(
								requestId,
								"EVIDENCE_NOT_FOUND",
								"Evidence not found",
								404,
							);
						}

						const evidencePolicy = createEvidencePolicy();
						const canAccess = await evidencePolicy.canViewEvidence(db, {
							organizationId: evidence.orgId,
							teamId: evidence.teamId,
							userId: authContext.localUserId,
						});
						if (!canAccess) {
							set.status = 403;
							return createForbiddenPayload(requestId);
						}

						const rows = await db
							.select({
								id: shareLinks.id,
								evidenceId: shareLinks.evidenceId,
								orgId: shareLinks.orgId,
								createdAt: shareLinks.createdAt,
								expiresAt: shareLinks.expiresAt,
								revokedAt: shareLinks.revokedAt,
								createdBy: shareLinks.createdBy,
							})
							.from(shareLinks)
							.where(eq(shareLinks.evidenceId, evidence.id))
							.orderBy(desc(shareLinks.createdAt));

						return {
							shareLinks: rows.map((row) => ({
								id: row.id,
								evidenceId: row.evidenceId,
								orgId: row.orgId,
								scope: "internal" as const,
								createdAt: row.createdAt,
								expiresAt: row.expiresAt,
								revokedAt: row.revokedAt,
								createdBy: row.createdBy,
							})),
						};
					},
					{
						params: evidenceIdParamsSchema,
						detail: {
							tags: ["evidences"],
							summary: "Lists share links for an evidence",
						},
						response: {
							200: listShareLinksResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.get(
					"/share-links/:token/resolve",
					async ({ authContext, db, params, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						if (!authContext.localUserId) {
							set.status = 403;
							return createForbiddenPayload(requestId);
						}

						const tokenHash = await hashToken(params.token);
						const evidencePolicy = createEvidencePolicy();
						const shareLink = await db.query.shareLinks.findFirst({
							where: and(
								eq(shareLinks.tokenHash, tokenHash),
								gt(shareLinks.expiresAt, Date.now()),
								isNull(shareLinks.revokedAt),
							),
							columns: {
								id: true,
								evidenceId: true,
								orgId: true,
								teamId: true,
								expiresAt: true,
								revokedAt: true,
							},
						});

						if (!shareLink) {
							set.status = 404;
							return createApiError(
								requestId,
								"SHARE_LINK_NOT_FOUND",
								"Share link is invalid, expired, or revoked",
								404,
							);
						}

						const organization = await db.query.organizations.findFirst({
							where: eq(organizations.id, shareLink.orgId),
							columns: { id: true, name: true },
						});
						if (!organization) {
							set.status = 404;
							return createApiError(
								requestId,
								"SHARE_LINK_NOT_FOUND",
								"Share link is invalid, expired, or revoked",
								404,
							);
						}

						const canAccess = await evidencePolicy.canViewEvidence(db, {
							organizationId: shareLink.orgId,
							teamId: shareLink.teamId,
							userId: authContext.localUserId,
						});

						return {
							shareLink: {
								id: shareLink.id,
								evidenceId: shareLink.evidenceId,
								orgId: shareLink.orgId,
								expiresAt: shareLink.expiresAt,
								access: canAccess ? ("granted" as const) : ("denied" as const),
							},
							organization: {
								id: organization.id,
								name: organization.name,
							},
						};
					},
					{
						params: tokenParamsSchema,
						detail: {
							tags: ["evidences"],
							summary:
								"Resolves internal share links for authenticated org members",
						},
						response: {
							200: resolvedShareLinkResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/share-links/:id/revoke",
					async ({ authContext, db, params, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						const scopeDenied = requireSessionScope(
							authContext,
							"share:write",
							requestId,
							set,
						);
						if (scopeDenied) {
							return scopeDenied;
						}

						if (!authContext.localUserId) {
							set.status = 403;
							return createForbiddenPayload(requestId);
						}

						const shareLink = await db.query.shareLinks.findFirst({
							where: eq(shareLinks.id, params.id),
							columns: { id: true, orgId: true, teamId: true, revokedAt: true },
						});
						if (!shareLink) {
							set.status = 404;
							return createApiError(
								requestId,
								"SHARE_LINK_NOT_FOUND",
								"Share link not found",
								404,
							);
						}

						const evidencePolicy = createEvidencePolicy();
						const canAccess = await evidencePolicy.canShareEvidence(db, {
							organizationId: shareLink.orgId,
							teamId: shareLink.teamId,
							userId: authContext.localUserId,
						});
						if (!canAccess) {
							set.status = 403;
							return createForbiddenPayload(requestId);
						}

						if (shareLink.revokedAt !== null) {
							const revokedAt = shareLink.revokedAt;
							return {
								shareLink: {
									id: shareLink.id,
									revokedAt,
								},
							};
						}

						const revokedAt = Date.now();
						const [updated] = await db
							.update(shareLinks)
							.set({ revokedAt, updatedAt: revokedAt })
							.where(eq(shareLinks.id, params.id))
							.returning({
								id: shareLinks.id,
								revokedAt: shareLinks.revokedAt,
							});

						if (!updated) {
							set.status = 500;
							return createApiError(
								requestId,
								"SHARE_LINK_REVOKE_FAILED",
								"Failed to revoke share link",
								500,
							);
						}

						return {
							shareLink: {
								id: updated.id,
								revokedAt: updated.revokedAt ?? revokedAt,
							},
						};
					},
					{
						params: evidenceIdParamsSchema,
						detail: {
							tags: ["evidences"],
							summary: "Revokes an internal share link",
						},
						response: {
							200: revokedShareLinkResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				),
		);
