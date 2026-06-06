import { and, eq, isNull } from "drizzle-orm";
import { Elysia, t } from "elysia";

import {
	desktopRecordingSessions,
	evidenceArtifacts,
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
	}),
	deleted: t.Object({
		artifactObjects: t.Number({ minimum: 0 }),
		shareLinks: t.Number({ minimum: 0 }),
		desktopSessions: t.Number({ minimum: 0 }),
	}),
});

export const createEvidenceRoutes = (auth: ClerkAuthPlugin) =>
	new Elysia({ name: "evidence-routes" })
		.use(auth)
		.guard({ auth: true }, (app) =>
			app
				.delete(
					"/evidences/:id",
					async ({
						artifactStorage,
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

						const artifactKeys = (
							await db.query.evidenceArtifacts.findMany({
								where: eq(evidenceArtifacts.evidenceId, evidence.id),
								columns: { s3Key: true },
							})
						).map((artifact) => artifact.s3Key);

						const deleted = await db.transaction(async (tx) => {
							const deletedShareLinks = await tx
								.delete(shareLinks)
								.where(eq(shareLinks.evidenceId, evidence.id))
								.returning({ id: shareLinks.id });
							const deletedDesktopSessions = await tx
								.delete(desktopRecordingSessions)
								.where(eq(desktopRecordingSessions.evidenceId, evidence.id))
								.returning({ id: desktopRecordingSessions.id });
							const deletedEvidence = await tx
								.delete(evidences)
								.where(eq(evidences.id, evidence.id))
								.returning({ id: evidences.id, orgId: evidences.orgId });

							if (!deletedEvidence[0]) {
								throw new Error("Failed to delete evidence");
							}

							return {
								evidence: deletedEvidence[0],
								shareLinks: deletedShareLinks.length,
								desktopSessions: deletedDesktopSessions.length,
							};
						});

						if (artifactKeys.length > 0) {
							const results = await Promise.allSettled(
								artifactKeys.map((key) =>
									artifactStorage.deleteObject({ key }),
								),
							);
							const failedDeleteCount = results.filter(
								(result) => result.status === "rejected",
							).length;
							if (failedDeleteCount > 0) {
								requestLogger.warn(
									{
										event: "evidence.artifact-delete-failed",
										evidenceId: evidence.id,
										failedDeleteCount,
										requestId,
									},
									"failed to delete evidence artifact objects",
								);
							}
						}

						requestLogger.info(
							{
								event: "evidence.deleted",
								evidenceId: evidence.id,
								orgId: evidence.orgId,
								deletedByUserId: authContext.localUserId,
								artifactObjectCount: artifactKeys.length,
								requestId,
							},
							"evidence deleted",
						);

						return {
							evidence: deleted.evidence,
							deleted: {
								artifactObjects: artifactKeys.length,
								shareLinks: deleted.shareLinks,
								desktopSessions: deleted.desktopSessions,
							},
						};
					},
					{
						params: t.Object({
							id: t.String({ minLength: 1 }),
						}),
						detail: {
							tags: ["evidences"],
							summary: "Deletes an evidence record and its artifact objects",
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
