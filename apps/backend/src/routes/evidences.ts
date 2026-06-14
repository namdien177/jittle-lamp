import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Elysia, t } from "elysia";

import {
	desktopRecordingSessions,
	evidenceArtifacts,
	evidenceComments,
	evidences,
	type OrganizationPermission,
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
import {
	evidenceActivityEntity,
	getRequestIpAddress,
	recordOrganizationActivity,
} from "../services/organization-activity";
import {
	getOrganizationRolePermissions,
	normalizeOrganizationRoleKey,
} from "../services/organization-permissions";
import type { BackendDb } from "../services/user-provisioning";

const moveEvidenceBodySchema = t.Object({
	targetOrgId: t.String({ minLength: 1 }),
});

const copyEvidenceBodySchema = t.Object({
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

const copyEvidenceResponseSchema = t.Object({
	evidence: t.Object({
		id: t.String({ minLength: 1 }),
		orgId: t.String({ minLength: 1 }),
		sourceEvidenceId: t.String({ minLength: 1 }),
	}),
	copy: t.Object({
		copiedAt: t.Number(),
		copiedBy: t.String({ minLength: 1 }),
		fromOrgId: t.String({ minLength: 1 }),
		toOrgId: t.String({ minLength: 1 }),
		artifactCount: t.Number({ minimum: 0 }),
	}),
});

const renameEvidenceBodySchema = t.Object({
	title: t.String({ minLength: 1, maxLength: 200 }),
});

const createEvidenceCommentBodySchema = t.Object({
	body: t.String({ minLength: 1, maxLength: 4000 }),
});

const evidenceOrgQuerySchema = t.Object({
	orgId: t.Optional(t.String({ minLength: 1 })),
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

const evidenceCommentSchema = t.Object({
	id: t.String({ minLength: 1 }),
	evidenceId: t.String({ minLength: 1 }),
	body: t.String({ minLength: 1 }),
	createdBy: t.String({ minLength: 1 }),
	authorLabel: t.String({ minLength: 1 }),
	createdAt: t.Number(),
	updatedAt: t.Number(),
});

const listEvidenceCommentsResponseSchema = t.Object({
	comments: t.Array(evidenceCommentSchema),
});

const createEvidenceCommentResponseSchema = t.Object({
	comment: evidenceCommentSchema,
});

const roleCanManageEvidence = async (
	db: BackendDb,
	input: {
		orgId: string;
		role: string;
		action: "update" | "delete";
		isCreator: boolean;
	},
): Promise<boolean> => {
	if (
		(input.action === "delete" || input.action === "update") &&
		input.isCreator
	) {
		return true;
	}

	const permissions = await getOrganizationRolePermissions(db, {
		organizationId: input.orgId,
		role: normalizeOrganizationRoleKey(input.role),
	});
	const anyPermission =
		`evidence.${input.action}.any` as OrganizationPermission;
	const ownPermission =
		`evidence.${input.action}.own` as OrganizationPermission;
	if (permissions.has(anyPermission)) return true;
	return input.isCreator && permissions.has(ownPermission);
};

const createAuthorLabel = (userId: string): string =>
	`User ${userId.slice(0, 8)}`;

const findAccessibleEvidence = async (
	db: BackendDb,
	input: {
		evidenceId: string;
		orgId?: string | undefined;
		userId: string;
		permission?: "evidence.view" | "evidence.comment";
	},
) => {
	const evidence = await db.query.evidences.findFirst({
		where: and(
			eq(evidences.id, input.evidenceId),
			input.orgId ? eq(evidences.orgId, input.orgId) : undefined,
			isNull(evidences.deletedAt),
		),
		columns: { id: true, orgId: true },
	});
	if (!evidence) return null;

	const membership = await db.query.organizationMembers.findFirst({
		where: and(
			eq(organizationMembers.organizationId, evidence.orgId),
			eq(organizationMembers.userId, input.userId),
			isNull(organizationMembers.teamId),
		),
		columns: { id: true, role: true },
	});

	if (!membership) return null;
	if (input.permission) {
		const permissions = await getOrganizationRolePermissions(db, {
			organizationId: evidence.orgId,
			role: normalizeOrganizationRoleKey(membership.role),
		});
		if (!permissions.has(input.permission)) return null;
	}

	return evidence;
};

const memberHasOrganizationPermission = async (
	db: BackendDb,
	input: {
		orgId: string;
		userId: string;
		permission: OrganizationPermission;
	},
): Promise<boolean> => {
	const membership = await db.query.organizationMembers.findFirst({
		where: and(
			eq(organizationMembers.organizationId, input.orgId),
			eq(organizationMembers.userId, input.userId),
			isNull(organizationMembers.teamId),
		),
		columns: { role: true },
	});
	if (!membership) return false;

	const permissions = await getOrganizationRolePermissions(db, {
		organizationId: input.orgId,
		role: normalizeOrganizationRoleKey(membership.role),
	});
	return permissions.has(input.permission);
};

export const createEvidenceRoutes = (auth: ClerkAuthPlugin) =>
	new Elysia({ name: "evidence-routes" })
		.use(auth)
		.guard({ auth: true }, (app) =>
			app
				.get(
					"/evidences/:id/comments",
					async ({ authContext, db, params, query, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						if (!authContext.localUserId) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_COMMENTS_FORBIDDEN",
								"Only workspace members can view this discussion",
								403,
							);
						}
						const evidence = await findAccessibleEvidence(db, {
							evidenceId: params.id,
							orgId: query.orgId,
							userId: authContext.localUserId,
							permission: "evidence.view",
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

						const comments = await db.query.evidenceComments.findMany({
							where: eq(evidenceComments.evidenceId, evidence.id),
							columns: {
								id: true,
								evidenceId: true,
								body: true,
								createdBy: true,
								createdAt: true,
								updatedAt: true,
							},
							orderBy: asc(evidenceComments.createdAt),
						});

						return {
							comments: comments.map((comment) => ({
								...comment,
								authorLabel: createAuthorLabel(comment.createdBy),
							})),
						};
					},
					{
						params: t.Object({ id: t.String({ minLength: 1 }) }),
						query: evidenceOrgQuerySchema,
						detail: {
							tags: ["evidences"],
							summary: "Lists discussion comments for an evidence record",
						},
						response: {
							200: listEvidenceCommentsResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/evidences/:id/comments",
					async ({
						authContext,
						body,
						db,
						params,
						query,
						request,
						requestId,
						requestLogger,
						set,
					}) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						if (!authContext.localUserId) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_COMMENTS_FORBIDDEN",
								"Only workspace members can comment on this evidence",
								403,
							);
						}

						const bodyText = body.body.trim();
						if (!bodyText) {
							set.status = 422;
							return createApiError(
								requestId,
								"EVIDENCE_COMMENT_REQUIRED",
								"Comment body is required",
								422,
							);
						}

						const evidence = await findAccessibleEvidence(db, {
							evidenceId: params.id,
							orgId: query.orgId,
							userId: authContext.localUserId,
							permission: "evidence.comment",
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

						const now = Date.now();
						const [inserted] = await db
							.insert(evidenceComments)
							.values({
								evidenceId: evidence.id,
								createdBy: authContext.localUserId,
								body: bodyText,
								createdAt: now,
								updatedAt: now,
							})
							.returning({
								id: evidenceComments.id,
								evidenceId: evidenceComments.evidenceId,
								body: evidenceComments.body,
								createdBy: evidenceComments.createdBy,
								createdAt: evidenceComments.createdAt,
								updatedAt: evidenceComments.updatedAt,
							});

						if (!inserted) {
							set.status = 500;
							return createApiError(
								requestId,
								"EVIDENCE_COMMENT_CREATE_FAILED",
								"Failed to add comment",
								500,
							);
						}

						requestLogger.info(
							{
								event: "evidence.comment-created",
								evidenceId: evidence.id,
								orgId: evidence.orgId,
								commentId: inserted.id,
								createdByUserId: authContext.localUserId,
								requestId,
							},
							"evidence comment created",
						);
						await recordOrganizationActivity(db, {
							organizationId: evidence.orgId,
							actorUserId: authContext.localUserId,
							action: "evidence.comment.created",
							entity: evidenceActivityEntity(evidence.id),
							message: "Commented on evidence",
							metadata: { commentId: inserted.id },
							ipAddress: getRequestIpAddress(request),
						});

						return {
							comment: {
								...inserted,
								authorLabel: createAuthorLabel(inserted.createdBy),
							},
						};
					},
					{
						params: t.Object({ id: t.String({ minLength: 1 }) }),
						query: evidenceOrgQuerySchema,
						body: createEvidenceCommentBodySchema,
						detail: {
							tags: ["evidences"],
							summary: "Adds a discussion comment to an evidence record",
						},
						response: {
							200: createEvidenceCommentResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							422: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.delete(
					"/evidences/:id",
					async ({
						authContext,
						db,
						params,
						request,
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
						if (
							!(await roleCanManageEvidence(db, {
								orgId: evidence.orgId,
								role: membership.role,
								action: "delete",
								isCreator,
							}))
						) {
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
						await recordOrganizationActivity(db, {
							organizationId: evidence.orgId,
							actorUserId: authContext.localUserId,
							action: "evidence.deleted",
							entity: evidenceActivityEntity(evidence.id),
							message: "Deleted evidence",
							metadata: { mode: "soft" },
							ipAddress: getRequestIpAddress(request),
						});

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
					async ({
						authContext,
						body,
						db,
						request,
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

						const forbiddenChecks = await Promise.all(
							rows.map(async (row) => {
								const role = roleByOrgId.get(row.orgId) ?? "";
								return {
									row,
									allowed: await roleCanManageEvidence(db, {
										orgId: row.orgId,
										role,
										action: "delete",
										isCreator: row.createdBy === authContext.localUserId,
									}),
								};
							}),
						);
						const forbidden = forbiddenChecks.find((check) => !check.allowed);
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
						await Promise.all(
							deleted.map((evidence) =>
								recordOrganizationActivity(db, {
									organizationId: evidence.orgId,
									actorUserId: authContext.localUserId,
									action: "evidence.deleted",
									entity: evidenceActivityEntity(evidence.id),
									message: "Deleted evidence",
									metadata: { mode: "soft", bulk: true },
									ipAddress: getRequestIpAddress(request),
								}),
							),
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
					"/evidences/:id/copy",
					async ({
						authContext,
						body,
						db,
						params,
						request,
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
								"EVIDENCE_COPY_FORBIDDEN",
								"Only workspace members can copy evidence",
								403,
							);
						}
						const actorUserId = authContext.localUserId;

						const evidence = await db.query.evidences.findFirst({
							where: and(
								eq(evidences.id, params.id),
								isNull(evidences.deletedAt),
							),
							columns: {
								id: true,
								orgId: true,
								createdBy: true,
								title: true,
								sourceType: true,
								sourceUri: true,
								sourceExternalId: true,
								sourceMetadata: true,
								thumbnailBase64: true,
								thumbnailMimeType: true,
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
								"EVIDENCE_COPY_SAME_ORG",
								"Evidence is already in the target organization",
								409,
							);
						}

						const [canViewSource, canCreateTarget] = await Promise.all([
							memberHasOrganizationPermission(db, {
								orgId: evidence.orgId,
								userId: actorUserId,
								permission: "evidence.view",
							}),
							memberHasOrganizationPermission(db, {
								orgId: body.targetOrgId,
								userId: actorUserId,
								permission: "evidence.create",
							}),
						]);
						if (!canViewSource) {
							set.status = 404;
							return createApiError(
								requestId,
								"EVIDENCE_NOT_FOUND",
								"Evidence not found",
								404,
							);
						}
						if (!canCreateTarget) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_COPY_TARGET_FORBIDDEN",
								"Your role cannot create evidence in the target organization",
								403,
							);
						}

						const artifacts = await db.query.evidenceArtifacts.findMany({
							where: eq(evidenceArtifacts.evidenceId, evidence.id),
							columns: {
								kind: true,
								s3Key: true,
								mimeType: true,
								bytes: true,
								checksum: true,
								uploadStatus: true,
							},
						});

						const now = Date.now();
						const copied = await db.transaction(async (tx) => {
							const [created] = await tx
								.insert(evidences)
								.values({
									orgId: body.targetOrgId,
									createdBy: actorUserId,
									title: evidence.title,
									sourceType: evidence.sourceType,
									sourceUri: evidence.sourceUri ?? undefined,
									sourceExternalId: evidence.sourceExternalId ?? undefined,
									sourceMetadata: evidence.sourceMetadata ?? undefined,
									thumbnailBase64: evidence.thumbnailBase64 ?? undefined,
									thumbnailMimeType: evidence.thumbnailMimeType ?? undefined,
									scopeType: "organization",
									scopeId: body.targetOrgId,
									updatedAt: now,
								})
								.returning({ id: evidences.id, orgId: evidences.orgId });

							if (!created) {
								throw new Error("Failed to copy evidence");
							}

							if (artifacts.length > 0) {
								await tx.insert(evidenceArtifacts).values(
									artifacts.map((artifact) => ({
										evidenceId: created.id,
										kind: artifact.kind,
										s3Key: artifact.s3Key,
										mimeType: artifact.mimeType,
										bytes: artifact.bytes,
										checksum: artifact.checksum,
										uploadStatus: artifact.uploadStatus,
										updatedAt: now,
									})),
								);
							}

							return created;
						});

						requestLogger.info(
							{
								event: "evidence.copied",
								sourceEvidenceId: evidence.id,
								copiedEvidenceId: copied.id,
								copiedByUserId: actorUserId,
								fromOrgId: evidence.orgId,
								toOrgId: copied.orgId,
								artifactCount: artifacts.length,
								requestId,
							},
							"evidence copy completed",
						);
						await Promise.all([
							recordOrganizationActivity(db, {
								organizationId: evidence.orgId,
								actorUserId,
								action: "evidence.copied.out",
								entity: evidenceActivityEntity(evidence.id),
								message: "Copied evidence out of this organization",
								metadata: {
									fromOrgId: evidence.orgId,
									toOrgId: copied.orgId,
									copiedEvidenceId: copied.id,
									artifactCount: artifacts.length,
								},
								ipAddress: getRequestIpAddress(request),
							}),
							recordOrganizationActivity(db, {
								organizationId: copied.orgId,
								actorUserId,
								action: "evidence.copied.in",
								entity: evidenceActivityEntity(copied.id),
								message: "Copied evidence into this organization",
								metadata: {
									fromOrgId: evidence.orgId,
									toOrgId: copied.orgId,
									sourceEvidenceId: evidence.id,
									artifactCount: artifacts.length,
								},
								ipAddress: getRequestIpAddress(request),
							}),
						]);

						return {
							evidence: {
								id: copied.id,
								orgId: copied.orgId,
								sourceEvidenceId: evidence.id,
							},
							copy: {
								copiedAt: now,
								copiedBy: actorUserId,
								fromOrgId: evidence.orgId,
								toOrgId: copied.orgId,
								artifactCount: artifacts.length,
							},
						};
					},
					{
						params: t.Object({
							id: t.String({ minLength: 1 }),
						}),
						body: copyEvidenceBodySchema,
						detail: {
							tags: ["evidences"],
							summary: "Copies evidence to another organization",
						},
						response: {
							200: copyEvidenceResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							409: apiErrorSchema,
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
						request,
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
							where: and(
								eq(evidences.id, params.id),
								isNull(evidences.deletedAt),
							),
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

						if (evidence.createdBy !== authContext.localUserId) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_MOVE_FORBIDDEN",
								"Only the recorder can move this evidence",
								403,
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
						await Promise.all([
							recordOrganizationActivity(db, {
								organizationId: evidence.orgId,
								actorUserId: authContext.localUserId,
								action: "evidence.moved.out",
								entity: evidenceActivityEntity(moved.evidenceId),
								message: "Moved evidence out of this organization",
								metadata: {
									fromOrgId: evidence.orgId,
									toOrgId: moved.orgId,
									invalidatedShareLinks: moved.invalidatedShareLinks,
								},
								ipAddress: getRequestIpAddress(request),
							}),
							recordOrganizationActivity(db, {
								organizationId: moved.orgId,
								actorUserId: authContext.localUserId,
								action: "evidence.moved.in",
								entity: evidenceActivityEntity(moved.evidenceId),
								message: "Moved evidence into this organization",
								metadata: {
									fromOrgId: evidence.orgId,
									toOrgId: moved.orgId,
									invalidatedShareLinks: moved.invalidatedShareLinks,
								},
								ipAddress: getRequestIpAddress(request),
							}),
						]);

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
						request,
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
						if (
							!(await roleCanManageEvidence(db, {
								orgId: evidence.orgId,
								role: membership.role,
								action: "update",
								isCreator: evidence.createdBy === authContext.localUserId,
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_RENAME_FORBIDDEN",
								"Only permitted owners or evidence managers can rename this evidence",
								403,
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
						await recordOrganizationActivity(db, {
							organizationId: updated.orgId,
							actorUserId: authContext.localUserId,
							action: "evidence.renamed",
							entity: evidenceActivityEntity(updated.id),
							message: `Renamed evidence to ${updated.title}`,
							metadata: { title: updated.title },
							ipAddress: getRequestIpAddress(request),
						});

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
