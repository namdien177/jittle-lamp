import { and, eq, inArray, isNull } from "drizzle-orm";
import { Elysia, t } from "elysia";

import {
	desktopRecordingSessions,
	evidences,
	organizationMembers,
	organizations,
	shareLinks,
} from "../db/schema";
import {
	apiErrorSchema,
	createApiError,
	createDbUnavailableError,
} from "../http/api-error";
import {
	type ClerkAuthPlugin,
	requireSessionScope,
} from "../plugins/clerk-auth";
import { EVIDENCE_BIN_RETENTION_MS } from "../services/evidence-maintenance";
import { createEvidencePolicy } from "../services/evidence-policy";

const moveEvidenceBodySchema = t.Object({
	targetOrgId: t.String({ minLength: 1 }),
});

const moveEvidenceResponseSchema = t.Object({
	evidence: t.Object({
		id: t.String({ minLength: 1 }),
		orgId: t.String({ minLength: 1 }),
	}),
	move: t.Object({
		movedAt: t.Number(),
		movedBy: t.String({ minLength: 1 }),
		fromOrgId: t.String({ minLength: 1 }),
		toOrgId: t.String({ minLength: 1 }),
		invalidatedShareLinks: t.Number({ minimum: 0 }),
	}),
});

const renameEvidenceBodySchema = t.Object({
	title: t.String({ minLength: 1, maxLength: 200 }),
});

const bulkDeleteEvidenceBodySchema = t.Object({
	ids: t.Array(t.String({ minLength: 1 }), { minItems: 1, maxItems: 100 }),
});

const renameEvidenceResponseSchema = t.Object({
	evidence: t.Object({
		id: t.String({ minLength: 1 }),
		orgId: t.String({ minLength: 1 }),
		title: t.String({ minLength: 1 }),
		updatedAt: t.Number(),
	}),
});

const deleteEvidenceResponseSchema = t.Object({
	evidence: t.Object({
		id: t.String({ minLength: 1 }),
		orgId: t.String({ minLength: 1 }),
		deletedAt: t.Number(),
		deletePurgesAt: t.Number(),
	}),
	deleted: t.Object({ mode: t.Literal("soft") }),
});

const bulkDeleteEvidenceResponseSchema = t.Object({
	evidences: t.Array(
		t.Object({
			id: t.String({ minLength: 1 }),
			orgId: t.String({ minLength: 1 }),
			deletedAt: t.Number(),
			deletePurgesAt: t.Number(),
		}),
	),
	deleted: t.Object({
		mode: t.Literal("soft"),
		count: t.Number({ minimum: 0 }),
	}),
});

const isElevatedEvidenceManager = (role: string): boolean =>
	role === "owner" || role === "admin" || role === "moderator";

export const createEvidenceRoutes = (auth: ClerkAuthPlugin) =>
	new Elysia({ name: "evidence-routes" })
		.use(auth)
		.guard({ auth: true }, (app) =>
			app
				.delete(
					"/evidences/:id",
					async ({
						authContext,
						db,
						params,
						requestId,
						requestLogger,
						set,
					}) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						const scopeDenied = requireSessionScope(
							authContext,
							"evidence:manage",
							requestId,
							set,
						);
						if (scopeDenied) {
							return scopeDenied;
						}

						if (!authContext.localUserId) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_DELETE_FORBIDDEN",
								"Only workspace members can delete this evidence",
								403,
							);
						}

						const evidence = await db.query.evidences.findFirst({
							where: and(
								eq(evidences.id, params.id),
								isNull(evidences.deletedAt),
							),
							columns: { id: true, orgId: true, createdBy: true },
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

						const membership = await db.query.organizationMembers.findFirst({
							where: and(
								eq(organizationMembers.organizationId, evidence.orgId),
								eq(organizationMembers.userId, authContext.localUserId),
								isNull(organizationMembers.teamId),
							),
							columns: { id: true, role: true },
						});
						if (!membership) {
							// Non-members get the same 404 as a missing record so the
							// endpoint cannot be used to probe which evidence IDs exist
							// in other organizations.
							set.status = 404;
							return createApiError(
								requestId,
								"EVIDENCE_NOT_FOUND",
								"Evidence not found",
								404,
							);
						}

						const isCreator = evidence.createdBy === authContext.localUserId;
						if (!isCreator && !isElevatedEvidenceManager(membership.role)) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_DELETE_FORBIDDEN",
								"Only the recorder, admins, or moderators can delete this evidence",
								403,
							);
						}

						const now = Date.now();
						const [deleted] = await db
							.update(evidences)
							.set({
								deletedAt: now,
								deletedBy: authContext.localUserId,
								deletePurgesAt: now + EVIDENCE_BIN_RETENTION_MS,
								updatedAt: now,
							})
							.where(
								and(eq(evidences.id, evidence.id), isNull(evidences.deletedAt)),
							)
							.returning({
								id: evidences.id,
								orgId: evidences.orgId,
								deletedAt: evidences.deletedAt,
								deletePurgesAt: evidences.deletePurgesAt,
							});

						if (!deleted?.deletedAt || !deleted.deletePurgesAt) {
							set.status = 500;
							return createApiError(
								requestId,
								"EVIDENCE_DELETE_FAILED",
								"Failed to delete evidence",
								500,
							);
						}

						requestLogger.info(
							{
								event: "evidence.deleted",
								evidenceId: evidence.id,
								orgId: evidence.orgId,
								deletedByUserId: authContext.localUserId,
								mode: "soft",
								requestId,
							},
							"evidence deleted",
						);

						return {
							evidence: {
								id: deleted.id,
								orgId: deleted.orgId,
								deletedAt: deleted.deletedAt,
								deletePurgesAt: deleted.deletePurgesAt,
							},
							deleted: { mode: "soft" as const },
						};
					},
					{
						params: t.Object({
							id: t.String({ minLength: 1 }),
						}),
						detail: {
							tags: ["evidences"],
							summary: "Moves an evidence record to the bin for 30 days",
						},
						response: {
							200: deleteEvidenceResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/evidences/bulk-delete",
					async ({ authContext, body, db, requestId, requestLogger, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						const scopeDenied = requireSessionScope(
							authContext,
							"evidence:manage",
							requestId,
							set,
						);
						if (scopeDenied) {
							return scopeDenied;
						}

						if (!authContext.localUserId) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_DELETE_FORBIDDEN",
								"Only workspace members can delete evidence",
								403,
							);
						}

						const ids = Array.from(new Set(body.ids));
						const rows = await db.query.evidences.findMany({
							where: and(
								inArray(evidences.id, ids),
								isNull(evidences.deletedAt),
							),
							columns: { id: true, orgId: true, createdBy: true },
						});

						if (rows.length !== ids.length) {
							set.status = 404;
							return createApiError(
								requestId,
								"EVIDENCE_NOT_FOUND",
								"One or more evidence records were not found",
								404,
							);
						}

						const orgIds = Array.from(new Set(rows.map((row) => row.orgId)));
						const memberships = await db.query.organizationMembers.findMany({
							where: and(
								inArray(organizationMembers.organizationId, orgIds),
								eq(organizationMembers.userId, authContext.localUserId),
								isNull(organizationMembers.teamId),
							),
							columns: { organizationId: true, role: true },
						});
						const roleByOrgId = new Map(
							memberships.map((membership) => [
								membership.organizationId,
								membership.role,
							]),
						);

						const inaccessible = rows.find(
							(row) => !roleByOrgId.has(row.orgId),
						);
						if (inaccessible) {
							set.status = 404;
							return createApiError(
								requestId,
								"EVIDENCE_NOT_FOUND",
								"One or more evidence records were not found",
								404,
							);
						}

						const forbidden = rows.find((row) => {
							const role = roleByOrgId.get(row.orgId) ?? "";
							return (
								row.createdBy !== authContext.localUserId &&
								!isElevatedEvidenceManager(role)
							);
						});
						if (forbidden) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_DELETE_FORBIDDEN",
								"Only the recorder, admins, or moderators can delete selected evidence",
								403,
							);
						}

						const now = Date.now();
						const deleted = await db
							.update(evidences)
							.set({
								deletedAt: now,
								deletedBy: authContext.localUserId,
								deletePurgesAt: now + EVIDENCE_BIN_RETENTION_MS,
								updatedAt: now,
							})
							.where(
								and(inArray(evidences.id, ids), isNull(evidences.deletedAt)),
							)
							.returning({
								id: evidences.id,
								orgId: evidences.orgId,
								deletedAt: evidences.deletedAt,
								deletePurgesAt: evidences.deletePurgesAt,
							});

						requestLogger.info(
							{
								event: "evidence.bulk-deleted",
								evidenceIds: ids,
								deletedByUserId: authContext.localUserId,
								count: deleted.length,
								mode: "soft",
								requestId,
							},
							"evidence bulk delete completed",
						);

						return {
							evidences: deleted.map((evidence) => ({
								id: evidence.id,
								orgId: evidence.orgId,
								deletedAt: evidence.deletedAt ?? now,
								deletePurgesAt:
									evidence.deletePurgesAt ?? now + EVIDENCE_BIN_RETENTION_MS,
							})),
							deleted: { mode: "soft" as const, count: deleted.length },
						};
					},
					{
						body: bulkDeleteEvidenceBodySchema,
						detail: {
							tags: ["evidences"],
							summary:
								"Moves multiple evidence records to the bin in one operation",
						},
						response: {
							200: bulkDeleteEvidenceResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/evidences/:id/move",
					async ({
						authContext,
						body,
						db,
						params,
						requestId,
						requestLogger,
						set,
					}) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						const scopeDenied = requireSessionScope(
							authContext,
							"evidence:manage",
							requestId,
							set,
						);
						if (scopeDenied) {
							return scopeDenied;
						}

						if (!authContext.localUserId) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_MOVE_FORBIDDEN",
								"Only permitted creators can move this evidence",
								403,
							);
						}

						const evidence = await db.query.evidences.findFirst({
							where: eq(evidences.id, params.id),
							columns: {
								id: true,
								orgId: true,
								teamId: true,
								createdBy: true,
								scopeType: true,
								scopeId: true,
							},
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

						if (evidence.orgId === body.targetOrgId) {
							set.status = 409;
							return createApiError(
								requestId,
								"EVIDENCE_MOVE_SAME_ORG",
								"Evidence is already in the target organization",
								409,
							);
						}

						const evidencePolicy = createEvidencePolicy();
						const sourceOrg = await db.query.organizations.findFirst({
							where: eq(organizations.id, evidence.orgId),
							columns: { personalOwnerUserId: true },
						});

						const canMove = await evidencePolicy.canMoveEvidence(db, {
							organizationId: evidence.orgId,
							teamId: evidence.teamId,
							userId: authContext.localUserId,
							sourceOrganizationId: evidence.orgId,
							targetOrganizationId: body.targetOrgId,
							isEvidenceCreator: evidence.createdBy === authContext.localUserId,
							isSourceOrganizationCreator:
								sourceOrg?.personalOwnerUserId === authContext.localUserId,
						});

						const hasTargetMembership =
							await db.query.organizationMembers.findFirst({
								where: and(
									eq(organizationMembers.organizationId, body.targetOrgId),
									eq(organizationMembers.userId, authContext.localUserId),
									isNull(organizationMembers.teamId),
								),
								columns: { id: true },
							});

						if (!hasTargetMembership) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_MOVE_TARGET_MEMBERSHIP_REQUIRED",
								"You must be a member of both source and target organizations",
								403,
							);
						}

						if (!canMove) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_MOVE_FORBIDDEN",
								"Only permitted creators can move this evidence",
								403,
							);
						}

						const now = Date.now();
						const moved = await db.transaction(async (tx) => {
							const invalidatedShareLinks = await tx
								.delete(shareLinks)
								.where(eq(shareLinks.evidenceId, evidence.id))
								.returning({ id: shareLinks.id });

							const [updatedEvidence] = await tx
								.update(evidences)
								.set({
									orgId: body.targetOrgId,
									scopeId:
										evidence.scopeType === "organization"
											? body.targetOrgId
											: evidence.scopeId,
									updatedAt: now,
								})
								.where(eq(evidences.id, evidence.id))
								.returning({ id: evidences.id, orgId: evidences.orgId });

							if (!updatedEvidence) {
								throw new Error("Failed to move evidence");
							}

							// Keep the desktop recording session attributed to the new
							// org so its (orgId, sessionId) uniqueness and org scoping
							// stay consistent with the evidence it points at.
							await tx
								.update(desktopRecordingSessions)
								.set({ orgId: body.targetOrgId, updatedAt: now })
								.where(eq(desktopRecordingSessions.evidenceId, evidence.id));

							return {
								evidenceId: updatedEvidence.id,
								orgId: updatedEvidence.orgId,
								invalidatedShareLinks: invalidatedShareLinks.length,
							};
						});

						requestLogger.info(
							{
								event: "evidence.moved",
								evidenceId: moved.evidenceId,
								movedByUserId: authContext.localUserId,
								fromOrgId: evidence.orgId,
								toOrgId: moved.orgId,
								invalidatedShareLinks: moved.invalidatedShareLinks,
								requestId,
							},
							"evidence move completed",
						);

						return {
							evidence: {
								id: moved.evidenceId,
								orgId: moved.orgId,
							},
							move: {
								movedAt: now,
								movedBy: authContext.localUserId,
								fromOrgId: evidence.orgId,
								toOrgId: moved.orgId,
								invalidatedShareLinks: moved.invalidatedShareLinks,
							},
						};
					},
					{
						params: t.Object({
							id: t.String({ minLength: 1 }),
						}),
						body: moveEvidenceBodySchema,
						detail: {
							tags: ["evidences"],
							summary: "Moves evidence to another organization",
						},
						response: {
							200: moveEvidenceResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							409: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.patch(
					"/evidences/:id",
					async ({
						authContext,
						body,
						db,
						params,
						requestId,
						requestLogger,
						set,
					}) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						const scopeDenied = requireSessionScope(
							authContext,
							"evidence:manage",
							requestId,
							set,
						);
						if (scopeDenied) {
							return scopeDenied;
						}

						if (!authContext.localUserId) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_RENAME_FORBIDDEN",
								"Only workspace members can rename this evidence",
								403,
							);
						}

						const evidence = await db.query.evidences.findFirst({
							where: eq(evidences.id, params.id),
							columns: { id: true, orgId: true },
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

						const membership = await db.query.organizationMembers.findFirst({
							where: and(
								eq(organizationMembers.organizationId, evidence.orgId),
								eq(organizationMembers.userId, authContext.localUserId),
								isNull(organizationMembers.teamId),
							),
							columns: { id: true },
						});
						if (!membership) {
							// Non-members get the same 404 as a missing record so the
							// endpoint cannot be used to probe which evidence IDs exist
							// in other organizations.
							set.status = 404;
							return createApiError(
								requestId,
								"EVIDENCE_NOT_FOUND",
								"Evidence not found",
								404,
							);
						}

						const title = body.title.trim();
						if (!title) {
							set.status = 422;
							return createApiError(
								requestId,
								"EVIDENCE_TITLE_REQUIRED",
								"Evidence title is required",
								422,
							);
						}

						const now = Date.now();
						const [updated] = await db
							.update(evidences)
							.set({ title, updatedAt: now })
							.where(eq(evidences.id, evidence.id))
							.returning({
								id: evidences.id,
								orgId: evidences.orgId,
								title: evidences.title,
								updatedAt: evidences.updatedAt,
							});

						if (!updated) {
							set.status = 500;
							return createApiError(
								requestId,
								"EVIDENCE_RENAME_FAILED",
								"Failed to rename evidence",
								500,
							);
						}

						requestLogger.info(
							{
								event: "evidence.renamed",
								evidenceId: updated.id,
								orgId: updated.orgId,
								renamedByUserId: authContext.localUserId,
								requestId,
							},
							"evidence renamed",
						);

						return { evidence: updated };
					},
					{
						params: t.Object({
							id: t.String({ minLength: 1 }),
						}),
						body: renameEvidenceBodySchema,
						detail: {
							tags: ["evidences"],
							summary: "Renames an evidence record",
						},
						response: {
							200: renameEvidenceResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							422: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				),
		);
