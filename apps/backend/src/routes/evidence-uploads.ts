import { Buffer } from "node:buffer";
import { and, count, desc, eq, inArray, isNull, like, or } from "drizzle-orm";
import { Elysia, t } from "elysia";
import type { RuntimeConfig } from "../config/runtime";
import {
	desktopRecordingSessions,
	evidenceArtifactKindSchema,
	evidenceArtifacts,
	evidences,
	evidenceTagAssignments,
	organizationEvidenceTags,
	organizationMembers,
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
import {
	evidenceActivityEntity,
	getRequestIpAddress,
	recordOrganizationActivity,
} from "../services/organization-activity";
import { organizationMemberHasPermission } from "../services/organization-permissions";
import type { BackendDb } from "../services/user-provisioning";
import { MAX_VIDEO_UPLOAD_BYTES } from "../services/video-normalizer";

const startUploadBodySchema = t.Object({
	title: t.String({ minLength: 1 }),
	sourceType: t.String({ minLength: 1 }),
	sourceUri: t.Optional(t.String({ format: "uri" })),
	sourceExternalId: t.Optional(t.String({ minLength: 1 })),
	sourceMetadata: t.Optional(t.String()),
	thumbnailBase64: t.Optional(t.String({ maxLength: 20_000 })),
	thumbnailMimeType: t.Optional(t.String({ minLength: 1 })),
	artifact: t.Object({
		kind: t.Union(
			evidenceArtifactKindSchema.options.map((value) => t.Literal(value)),
		),
		mimeType: t.String({ minLength: 1 }),
		bytes: t.Number({ minimum: 0 }),
		checksum: t.String({ minLength: 1 }),
	}),
	orgId: t.Optional(t.String()),
});

const startDesktopSessionSyncBodySchema = t.Object({
	sessionId: t.String({ minLength: 1 }),
	title: t.String({ minLength: 1 }),
	sourceMetadata: t.Optional(t.String()),
	thumbnailBase64: t.Optional(t.String({ maxLength: 20_000 })),
	thumbnailMimeType: t.Optional(t.String({ minLength: 1 })),
	replaceEvidenceId: t.Optional(t.String({ minLength: 1 })),
	artifacts: t.Array(
		t.Object({
			key: t.Union([
				t.Literal("recording"),
				t.Literal("archive"),
				t.Literal("playback"),
			]),
			kind: t.Union(
				evidenceArtifactKindSchema.options.map((value) => t.Literal(value)),
			),
			mimeType: t.String({ minLength: 1 }),
			bytes: t.Number({ minimum: 0 }),
			checksum: t.String({ minLength: 1 }),
		}),
		{ minItems: 2, maxItems: 3 },
	),
});

const startManualUploadBodySchema = t.Object({
	sessionId: t.String({ minLength: 1 }),
	title: t.String({ minLength: 1 }),
	sourceMetadata: t.Optional(t.String()),
	thumbnailBase64: t.Optional(t.String({ maxLength: 20_000 })),
	thumbnailMimeType: t.Optional(t.String({ minLength: 1 })),
	artifacts: t.Array(
		t.Object({
			key: t.Union([t.Literal("recording"), t.Literal("archive")]),
			kind: t.Union(
				evidenceArtifactKindSchema.options.map((value) => t.Literal(value)),
			),
			mimeType: t.String({ minLength: 1 }),
			bytes: t.Number({ minimum: 0 }),
			checksum: t.String({ minLength: 1 }),
		}),
		{ minItems: 2, maxItems: 2 },
	),
});

const completeUploadBodySchema = t.Object({
	bytes: t.Number({ minimum: 0 }),
	checksum: t.String({ minLength: 1 }),
	mimeType: t.String({ minLength: 1 }),
});

const uploadParamsSchema = t.Object({
	uploadId: t.String({ minLength: 1 }),
});

const artifactReadUrlParamsSchema = t.Object({
	id: t.String({ minLength: 1 }),
	artifactId: t.String({ minLength: 1 }),
});

const startUploadResponseSchema = t.Object({
	uploadId: t.String({ minLength: 1 }),
	evidenceId: t.String({ minLength: 1 }),
	organizationId: t.String({ minLength: 1 }),
	uploadSession: t.Object({
		expiresAt: t.Number(),
		uploadUrl: t.String({ format: "uri" }),
		method: t.Literal("PUT"),
		headers: t.Object({
			"content-type": t.String({ minLength: 1 }),
		}),
		storageKey: t.String({ minLength: 1 }),
	}),
});

const uploadSessionSchema = t.Object({
	key: t.String({ minLength: 1 }),
	uploadId: t.String({ minLength: 1 }),
	expiresAt: t.Number(),
	uploadUrl: t.String({ format: "uri" }),
	method: t.Literal("PUT"),
	headers: t.Object({
		"content-type": t.String({ minLength: 1 }),
	}),
	storageKey: t.String({ minLength: 1 }),
});

const startDesktopSessionSyncResponseSchema = t.Object({
	evidenceId: t.String({ minLength: 1 }),
	organizationId: t.String({ minLength: 1 }),
	uploadSessions: t.Array(uploadSessionSchema),
});

const completeUploadResponseSchema = t.Object({
	uploadId: t.String({ minLength: 1 }),
	evidenceId: t.String({ minLength: 1 }),
	status: t.Literal("committed"),
});

const evidenceQuerySchema = t.Object({
	orgId: t.Optional(t.String({ minLength: 1 })),
});

const listEvidenceQuerySchema = t.Object({
	orgId: t.Optional(t.String({ minLength: 1 })),
	createdBy: t.Optional(t.String()),
	tagIds: t.Optional(t.String()),
	search: t.Optional(t.String()),
	page: t.Optional(t.Number({ minimum: 1 })),
	limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
});

const evidenceSummarySchema = t.Object({
	id: t.String({ minLength: 1 }),
	orgId: t.String({ minLength: 1 }),
	title: t.String({ minLength: 1 }),
	sourceType: t.String({ minLength: 1 }),
	sourceExternalId: t.Nullable(t.String()),
	sourceMetadata: t.Nullable(t.String()),
	thumbnailBase64: t.Nullable(t.String()),
	thumbnailMimeType: t.Nullable(t.String()),
	createdBy: t.String({ minLength: 1 }),
	createdAt: t.Number(),
	updatedAt: t.Number(),
	status: t.Union([t.Literal("ready"), t.Literal("pending")]),
	durationMs: t.Union([t.Number(), t.Null()]),
	actionCount: t.Union([t.Number(), t.Null()]),
	requestCount: t.Union([t.Number(), t.Null()]),
	tags: t.Array(
		t.Object({
			id: t.String({ minLength: 1 }),
			name: t.String({ minLength: 1 }),
			color: t.String({ minLength: 1 }),
		}),
	),
});

const evidenceTagSchema = t.Object({
	id: t.String({ minLength: 1 }),
	name: t.String({ minLength: 1 }),
	color: t.String({ minLength: 1 }),
});

const listEvidenceTagsResponseSchema = t.Object({
	tags: t.Array(evidenceTagSchema),
});

const evidenceTagBodySchema = t.Object({
	orgId: t.Optional(t.String({ minLength: 1 })),
	name: t.String({ minLength: 1, maxLength: 40 }),
	color: t.String({ minLength: 1, maxLength: 40 }),
});

const evidenceTagResponseSchema = t.Object({
	tag: evidenceTagSchema,
});

const updateEvidenceTagsBodySchema = t.Object({
	tagIds: t.Array(t.String({ minLength: 1 }), { maxItems: 20 }),
});

const updateEvidenceTagsResponseSchema = t.Object({
	evidence: t.Object({
		id: t.String({ minLength: 1 }),
		orgId: t.String({ minLength: 1 }),
		tags: t.Array(evidenceTagSchema),
	}),
});

/**
 * Evidence is "ready" once it has at least one artifact and every artifact has
 * finished uploading; otherwise it is still a draft/in-flight upload. Lets
 * clients distinguish viewable evidence from incomplete upload drafts.
 */
const deriveEvidenceStatus = (
	artifacts: { uploadStatus: string }[],
): "ready" | "pending" =>
	artifacts.length > 0 &&
	artifacts.every((artifact) => artifact.uploadStatus === "uploaded")
		? "ready"
		: "pending";

const evidenceArtifactSummarySchema = t.Object({
	id: t.String({ minLength: 1 }),
	evidenceId: t.String({ minLength: 1 }),
	kind: t.String({ minLength: 1 }),
	mimeType: t.String({ minLength: 1 }),
	bytes: t.Number(),
	checksum: t.String({ minLength: 1 }),
	uploadStatus: t.String({ minLength: 1 }),
	createdAt: t.Number(),
	updatedAt: t.Number(),
});

const listEvidencesResponseSchema = t.Object({
	evidences: t.Array(evidenceSummarySchema),
	orgId: t.String({ minLength: 1 }),
	total: t.Number({ minimum: 0 }),
	page: t.Number({ minimum: 1 }),
	limit: t.Number({ minimum: 1 }),
});

const loadEvidenceResponseSchema = t.Object({
	evidence: evidenceSummarySchema,
});

const listEvidenceArtifactsResponseSchema = t.Object({
	artifacts: t.Array(evidenceArtifactSummarySchema),
});

const artifactReadUrlResponseSchema = t.Object({
	url: t.String({ minLength: 1 }),
	expiresAt: t.Number(),
	renewAfterMs: t.Number(),
});

type UploadedBlobMetadata = {
	bytes: number;
	checksum: string;
	mimeType: string;
};

const UPLOAD_SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB
const DEFAULT_EVIDENCE_PAGE_SIZE = 24;
const MAX_EVIDENCE_PAGE_SIZE = 100;
const defaultEvidenceTags = [
	{ name: "Bug", color: "#ef4444" },
	{ name: "Smoke Test", color: "#f59e0b" },
	{ name: "Evidence", color: "#22c55e" },
] as const;

const parseEvidenceStats = (
	sourceMetadata: string | null,
): {
	durationMs: number | null;
	actionCount: number | null;
	requestCount: number | null;
} => {
	if (!sourceMetadata) {
		return { durationMs: null, actionCount: null, requestCount: null };
	}
	try {
		const metadata = JSON.parse(sourceMetadata) as {
			durationMs?: unknown;
			actionCount?: unknown;
			requestCount?: unknown;
		};
		return {
			durationMs:
				typeof metadata.durationMs === "number" &&
				Number.isFinite(metadata.durationMs)
					? metadata.durationMs
					: null,
			actionCount:
				typeof metadata.actionCount === "number" &&
				Number.isFinite(metadata.actionCount)
					? metadata.actionCount
					: null,
			requestCount:
				typeof metadata.requestCount === "number" &&
				Number.isFinite(metadata.requestCount)
					? metadata.requestCount
					: null,
		};
	} catch {
		return { durationMs: null, actionCount: null, requestCount: null };
	}
};

const ensureDefaultEvidenceTags = async (
	db: BackendDb,
	orgId: string,
): Promise<void> => {
	const now = Date.now();
	for (const tag of defaultEvidenceTags) {
		await db
			.insert(organizationEvidenceTags)
			.values({
				orgId,
				name: tag.name,
				color: tag.color,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing();
	}
};

const listEvidenceTags = async (db: BackendDb, orgId: string) => {
	await ensureDefaultEvidenceTags(db, orgId);
	return await db.query.organizationEvidenceTags.findMany({
		where: eq(organizationEvidenceTags.orgId, orgId),
		columns: { id: true, name: true, color: true },
		orderBy: organizationEvidenceTags.name,
	});
};

const firstHeaderValue = (value: string | null): string | undefined =>
	value?.split(",")[0]?.trim().replace(/^"|"$/g, "") || undefined;

const parseCreatorFilter = (value: string | undefined): string[] =>
	Array.from(
		new Set(
			(value ?? "")
				.split(",")
				.map((part) => part.trim())
				.filter(Boolean),
		),
	);

const forwardedHeaderValue = (
	forwarded: string | null,
	key: "host" | "proto",
): string | undefined => {
	const firstForwarded = firstHeaderValue(forwarded);
	if (!firstForwarded) {
		return undefined;
	}

	for (const part of firstForwarded.split(";")) {
		const [name, rawValue] = part.split("=");
		if (name?.trim().toLowerCase() === key && rawValue) {
			return rawValue.trim().replace(/^"|"$/g, "");
		}
	}

	return undefined;
};

const normalizeOrigin = (origin: string) => origin.replace(/\/+$/, "");

const isDevelopmentRuntime = (runtime: RuntimeConfig) =>
	runtime.nodeEnv === "local" || runtime.nodeEnv === "development";

const buildAllowedOriginSet = (runtime: RuntimeConfig): Set<string> => {
	const origins = [
		runtime.apiOrigin,
		runtime.webAppOrigin,
		...(runtime.clerkAuthorizedParties ?? []),
	]
		.filter((value): value is string => Boolean(value))
		.map(normalizeOrigin);

	if (isDevelopmentRuntime(runtime)) {
		origins.push(
			"http://127.0.0.1:4173",
			"http://localhost:4173",
			"http://127.0.0.1:3001",
			"http://localhost:3001",
		);
	}

	return new Set(origins);
};

/**
 * Builds the public origin used to construct upload URLs handed back to
 * clients. Proxy-forwarded host/proto headers are attacker-controllable, so we
 * only honor a forwarded origin when it matches a configured allowlist. This
 * prevents host-header injection from redirecting authenticated uploads (and
 * their bearer tokens) to an arbitrary host. When a public API origin is
 * configured it wins over the connection origin because production requests may
 * arrive from an internal HTTP hop behind a TLS-terminating proxy.
 */
const resolveExternalRequestOrigin = (
	request: Request,
	runtime: RuntimeConfig,
): string => {
	const requestUrl = new URL(request.url);
	const connectionOrigin = `${requestUrl.protocol.replace(/:$/, "")}://${requestUrl.host}`;
	const secureConnectionOrigin =
		!isDevelopmentRuntime(runtime) && requestUrl.protocol === "http:"
			? `https://${requestUrl.host}`
			: connectionOrigin;

	const forwarded = request.headers.get("forwarded");
	const forwardedHost =
		firstHeaderValue(request.headers.get("x-forwarded-host")) ??
		forwardedHeaderValue(forwarded, "host");

	if (forwardedHost) {
		const forwardedProto =
			firstHeaderValue(request.headers.get("x-forwarded-proto")) ??
			forwardedHeaderValue(forwarded, "proto") ??
			requestUrl.protocol.replace(/:$/, "");
		const forwardedOrigin = normalizeOrigin(
			`${forwardedProto}://${forwardedHost}`,
		);

		if (buildAllowedOriginSet(runtime).has(forwardedOrigin)) {
			return forwardedOrigin;
		}
	}

	return runtime.apiOrigin ?? secureConnectionOrigin;
};

const encodeSha256 = async (payload: ArrayBuffer): Promise<string> => {
	const digest = await crypto.subtle.digest("SHA-256", payload);
	return Array.from(new Uint8Array(digest))
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
};

const sha256HexToBase64 = (hex: string): string => {
	const bytes = new Uint8Array(
		hex.match(/.{1,2}/g)?.map((part) => Number.parseInt(part, 16)) ?? [],
	);
	return Buffer.from(bytes).toString("base64");
};

const checksumMatches = (
	expected: string,
	actualSha256Hex: string,
): boolean => {
	const normalizedExpected = expected.toLowerCase();
	const normalizedActual = actualSha256Hex.toLowerCase();
	return (
		normalizedExpected === normalizedActual ||
		normalizedExpected === `sha256:${normalizedActual}`
	);
};

const resolveActiveWorkspace = (
	activeOrgId: string | null,
	localUserId: string | null,
) =>
	activeOrgId && localUserId
		? {
				activeOrgId,
				localUserId,
			}
		: null;

const resolveRequestedOrgId = async (args: {
	authContext: {
		activeOrgId: string | null;
		localUserId: string | null;
	};
	db: BackendDb;
	requestedOrgId: string | undefined;
	requestId: string;
	set: {
		status?: number | string;
	};
}): Promise<
	| {
			ok: true;
			orgId: string;
			localUserId: string;
	  }
	| { ok: false; error: ReturnType<typeof createApiError> }
> => {
	const workspace = resolveActiveWorkspace(
		args.authContext.activeOrgId,
		args.authContext.localUserId,
	);
	if (!workspace) {
		args.set.status = 403;
		return {
			ok: false,
			error: createApiError(
				args.requestId,
				"ORG_CONTEXT_UNRESOLVED",
				"No active organization found for current user",
				403,
			),
		};
	}

	const resolvedOrgId = args.requestedOrgId ?? workspace.activeOrgId;

	const membership = await args.db.query.organizationMembers.findFirst({
		where: and(
			eq(organizationMembers.organizationId, resolvedOrgId),
			eq(organizationMembers.userId, workspace.localUserId),
			isNull(organizationMembers.teamId),
		),
		columns: { id: true },
	});
	if (!membership) {
		args.set.status = 403;
		return {
			ok: false,
			error: createApiError(
				args.requestId,
				"ORG_MEMBERSHIP_REQUIRED",
				"Selected organization must be a member organization",
				403,
			),
		};
	}

	return {
		ok: true,
		orgId: resolvedOrgId,
		localUserId: workspace.localUserId,
	};
};

export const createEvidenceUploadRoutes = (auth: ClerkAuthPlugin) =>
	new Elysia({
		name: "evidence-upload-routes",
	})
		.use(auth)
		.guard({ auth: true }, (app) =>
			app
				.post(
					"/evidences/desktop-sessions/sync/start",
					async ({
						artifactStorage,
						authContext,
						body,
						db,
						request,
						requestId,
						requestLogger,
						runtime,
						set,
					}) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						const scopeDenied = requireSessionScope(
							authContext,
							"evidence:write",
							requestId,
							set,
						);
						if (scopeDenied) {
							return scopeDenied;
						}

						const workspace = resolveActiveWorkspace(
							authContext.activeOrgId,
							authContext.localUserId,
						);
						if (!workspace) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_CONTEXT_UNRESOLVED",
								"No active organization found for current user",
								403,
							);
						}
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: workspace.activeOrgId,
								localUserId: workspace.localUserId,
								permission: "evidence.create",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_CREATE_FORBIDDEN",
								"Your role cannot create evidence in this organization",
								403,
							);
						}

						const artifactKeys = new Set(
							body.artifacts.map((artifact) => artifact.key),
						);
						if (
							!artifactKeys.has("recording") ||
							!artifactKeys.has("archive")
						) {
							set.status = 400;
							return createApiError(
								requestId,
								"DESKTOP_SESSION_ARTIFACTS_REQUIRED",
								"Desktop session sync requires recording and archive artifacts",
								400,
							);
						}
						if (
							body.artifacts.some(
								(artifact) =>
									artifact.kind === "recording" &&
									artifact.bytes > MAX_VIDEO_UPLOAD_BYTES,
							)
						) {
							set.status = 413;
							return createApiError(
								requestId,
								"VIDEO_UPLOAD_TOO_LARGE",
								"Video files must be 60 MB or smaller",
								413,
							);
						}

						const existingEvidence = body.replaceEvidenceId
							? await db.query.evidences.findFirst({
									where: and(
										eq(evidences.id, body.replaceEvidenceId),
										eq(evidences.orgId, workspace.activeOrgId),
									),
									columns: {
										id: true,
										orgId: true,
										sourceType: true,
										sourceExternalId: true,
									},
								})
							: null;
						if (
							existingEvidence &&
							(existingEvidence.sourceType !== "desktop-session" ||
								existingEvidence.sourceExternalId !== body.sessionId)
						) {
							set.status = 409;
							return createApiError(
								requestId,
								"DESKTOP_SESSION_RESYNC_MISMATCH",
								"Replacement evidence does not match the requested desktop session",
								409,
							);
						}

						const replacedArtifactKeys = existingEvidence
							? (
									await db.query.evidenceArtifacts.findMany({
										where: eq(
											evidenceArtifacts.evidenceId,
											existingEvidence.id,
										),
										columns: { s3Key: true },
									})
								).map((artifact) => artifact.s3Key)
							: [];

						const now = Date.now();
						const created = await db.transaction(async (tx) => {
							const [evidence] = existingEvidence
								? await tx
										.update(evidences)
										.set({
											title: body.title,
											sourceMetadata: body.sourceMetadata,
											thumbnailBase64: body.thumbnailBase64,
											thumbnailMimeType: body.thumbnailMimeType,
											updatedAt: now,
										})
										.where(eq(evidences.id, existingEvidence.id))
										.returning({ id: evidences.id, orgId: evidences.orgId })
								: await tx
										.insert(evidences)
										.values({
											orgId: workspace.activeOrgId,
											createdBy: workspace.localUserId,
											title: body.title,
											sourceType: "desktop-session",
											sourceExternalId: body.sessionId,
											sourceMetadata: body.sourceMetadata,
											thumbnailBase64: body.thumbnailBase64,
											thumbnailMimeType: body.thumbnailMimeType,
											scopeType: "organization",
											scopeId: workspace.activeOrgId,
											updatedAt: now,
										})
										.returning({ id: evidences.id, orgId: evidences.orgId });

							if (!evidence) {
								throw new Error("Failed to save desktop session evidence");
							}

							if (existingEvidence) {
								await tx
									.delete(evidenceArtifacts)
									.where(eq(evidenceArtifacts.evidenceId, evidence.id));
							}

							await tx
								.insert(desktopRecordingSessions)
								.values({
									sessionId: body.sessionId,
									evidenceId: evidence.id,
									orgId: evidence.orgId,
									createdBy: workspace.localUserId,
									sourceMetadata: body.sourceMetadata,
									updatedAt: now,
								})
								.onConflictDoUpdate({
									target: [
										desktopRecordingSessions.orgId,
										desktopRecordingSessions.sessionId,
									],
									set: {
										evidenceId: evidence.id,
										sourceMetadata: body.sourceMetadata,
										updatedAt: now,
									},
								});

							const uploadSessions = [];
							for (const artifactInput of body.artifacts) {
								const [artifact] = await tx
									.insert(evidenceArtifacts)
									.values({
										evidenceId: evidence.id,
										kind: artifactInput.kind,
										s3Key: `uploads/${workspace.activeOrgId}/${evidence.id}/${artifactInput.key}-${crypto.randomUUID()}`,
										mimeType: artifactInput.mimeType,
										bytes: Math.trunc(artifactInput.bytes),
										checksum: artifactInput.checksum,
										uploadStatus: "uploading",
										updatedAt: now,
									})
									.returning({
										id: evidenceArtifacts.id,
										s3Key: evidenceArtifacts.s3Key,
									});

								if (!artifact) {
									throw new Error("Failed to create desktop session artifact");
								}

								uploadSessions.push({
									key: artifactInput.key,
									uploadId: artifact.id,
									expiresAt: now + UPLOAD_SESSION_TTL_MS,
									uploadUrl: `${resolveExternalRequestOrigin(request, runtime)}/evidences/uploads/${artifact.id}/blob`,
									method: "PUT" as const,
									headers: {
										"content-type": artifactInput.mimeType,
									},
									storageKey: artifact.s3Key,
								});
							}

							return {
								evidenceId: evidence.id,
								organizationId: evidence.orgId,
								uploadSessions,
							};
						});

						if (replacedArtifactKeys.length > 0) {
							const results = await Promise.allSettled(
								replacedArtifactKeys.map((key) =>
									artifactStorage.deleteObject({ key }),
								),
							);
							const failedDeleteCount = results.filter(
								(result) => result.status === "rejected",
							).length;
							if (failedDeleteCount > 0) {
								requestLogger.warn(
									{
										event: "desktop-session.resync.artifact-delete-failed",
										evidenceId: created.evidenceId,
										failedDeleteCount,
										requestId,
									},
									"failed to delete replaced desktop session artifact objects",
								);
							}
						}
						await recordOrganizationActivity(db, {
							organizationId: created.organizationId,
							actorUserId: workspace.localUserId,
							action: existingEvidence
								? "evidence.recording.resynced"
								: "evidence.created",
							entity: evidenceActivityEntity(created.evidenceId),
							message: existingEvidence
								? "Re-synced evidence recording"
								: "Created evidence recording",
							metadata: {
								sourceType: "desktop-session",
								sessionId: body.sessionId,
								replacedEvidenceId: existingEvidence?.id ?? null,
							},
							ipAddress: getRequestIpAddress(request),
						});

						return created;
					},
					{
						body: startDesktopSessionSyncBodySchema,
						detail: {
							tags: ["evidences"],
							summary:
								"Starts a desktop recording session sync with separate recording and archive artifacts",
						},
						response: {
							200: startDesktopSessionSyncResponseSchema,
							400: apiErrorSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/evidences/uploads/start",
					async ({
						authContext,
						body,
						db,
						request,
						requestId,
						runtime,
						set,
					}) => {
						if (body.orgId) {
							set.status = 400;
							return createApiError(
								requestId,
								"EVIDENCE_UPLOAD_CLIENT_ORG_FORBIDDEN",
								"Client-provided orgId is not allowed",
								400,
							);
						}

						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						const scopeDenied = requireSessionScope(
							authContext,
							"evidence:write",
							requestId,
							set,
						);
						if (scopeDenied) {
							return scopeDenied;
						}

						const workspace = resolveActiveWorkspace(
							authContext.activeOrgId,
							authContext.localUserId,
						);
						if (!workspace) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_CONTEXT_UNRESOLVED",
								"No active organization found for current user",
								403,
							);
						}
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: workspace.activeOrgId,
								localUserId: workspace.localUserId,
								permission: "evidence.create",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_CREATE_FORBIDDEN",
								"Your role cannot create evidence in this organization",
								403,
							);
						}

						const now = Date.now();
						const created = await db.transaction(async (tx) => {
							const [evidence] = await tx
								.insert(evidences)
								.values({
									orgId: workspace.activeOrgId,
									createdBy: workspace.localUserId,
									title: body.title,
									sourceType: body.sourceType,
									sourceUri: body.sourceUri,
									sourceExternalId: body.sourceExternalId,
									sourceMetadata: body.sourceMetadata,
									thumbnailBase64: body.thumbnailBase64,
									thumbnailMimeType: body.thumbnailMimeType,
									scopeType: "organization",
									scopeId: workspace.activeOrgId,
									updatedAt: now,
								})
								.returning({ id: evidences.id, orgId: evidences.orgId });

							if (!evidence) {
								throw new Error("Failed to create draft evidence");
							}

							const [artifact] = await tx
								.insert(evidenceArtifacts)
								.values({
									evidenceId: evidence.id,
									kind: body.artifact.kind,
									s3Key: `uploads/${workspace.activeOrgId}/${evidence.id}/${crypto.randomUUID()}`,
									mimeType: body.artifact.mimeType,
									bytes: Math.trunc(body.artifact.bytes),
									checksum: body.artifact.checksum,
									uploadStatus: "uploading",
									updatedAt: now,
								})
								.returning({
									id: evidenceArtifacts.id,
									s3Key: evidenceArtifacts.s3Key,
								});

							if (!artifact) {
								throw new Error("Failed to create upload artifact");
							}

							if (
								body.sourceType === "desktop-session" &&
								body.sourceExternalId
							) {
								await tx
									.insert(desktopRecordingSessions)
									.values({
										sessionId: body.sourceExternalId,
										evidenceId: evidence.id,
										orgId: evidence.orgId,
										createdBy: workspace.localUserId,
										sourceMetadata: body.sourceMetadata,
										updatedAt: now,
									})
									.onConflictDoUpdate({
										target: [
											desktopRecordingSessions.orgId,
											desktopRecordingSessions.sessionId,
										],
										set: {
											evidenceId: evidence.id,
											sourceMetadata: body.sourceMetadata,
											updatedAt: now,
										},
									});
							}

							return {
								evidenceId: evidence.id,
								uploadId: artifact.id,
								organizationId: evidence.orgId,
								s3Key: artifact.s3Key,
							};
						});
						await recordOrganizationActivity(db, {
							organizationId: created.organizationId,
							actorUserId: workspace.localUserId,
							action: "evidence.created",
							entity: evidenceActivityEntity(created.evidenceId),
							message: "Created evidence session",
							metadata: {
								sourceType: body.sourceType,
								sourceExternalId: body.sourceExternalId ?? null,
								artifactKind: body.artifact.kind,
							},
							ipAddress: getRequestIpAddress(request),
						});

						return {
							uploadId: created.uploadId,
							evidenceId: created.evidenceId,
							organizationId: created.organizationId,
							uploadSession: {
								expiresAt: now + UPLOAD_SESSION_TTL_MS,
								uploadUrl: `${resolveExternalRequestOrigin(request, runtime)}/evidences/uploads/${created.uploadId}/blob`,
								method: "PUT",
								headers: {
									"content-type": body.artifact.mimeType,
								},
								storageKey: created.s3Key,
							},
						};
					},
					{
						body: startUploadBodySchema,
						detail: {
							tags: ["evidences"],
							summary: "Starts a server-scoped evidence upload",
						},
						response: {
							200: startUploadResponseSchema,
							400: apiErrorSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/evidences/manual-uploads/start",
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

						const scopeDenied = requireSessionScope(
							authContext,
							"evidence:write",
							requestId,
							set,
						);
						if (scopeDenied) {
							return scopeDenied;
						}

						const workspace = resolveActiveWorkspace(
							authContext.activeOrgId,
							authContext.localUserId,
						);
						if (!workspace) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_CONTEXT_UNRESOLVED",
								"No active organization found for current user",
								403,
							);
						}
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: workspace.activeOrgId,
								localUserId: workspace.localUserId,
								permission: "evidence.create",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_CREATE_FORBIDDEN",
								"Your role cannot create evidence in this organization",
								403,
							);
						}

						const artifactKeys = new Set(
							body.artifacts.map((artifact) => artifact.key),
						);
						const hasRequiredArtifacts =
							artifactKeys.has("recording") && artifactKeys.has("archive");
						const hasValidKinds = body.artifacts.every((artifact) =>
							artifact.key === "recording"
								? artifact.kind === "recording"
								: artifact.kind === "network-log",
						);
						if (!hasRequiredArtifacts || !hasValidKinds) {
							set.status = 400;
							return createApiError(
								requestId,
								"MANUAL_UPLOAD_ARTIFACTS_REQUIRED",
								"Manual upload requires a recording video and a session archive artifact",
								400,
							);
						}
						const recordingArtifact = body.artifacts.find(
							(artifact) => artifact.key === "recording",
						);
						if (
							recordingArtifact &&
							recordingArtifact.bytes > MAX_VIDEO_UPLOAD_BYTES
						) {
							set.status = 413;
							return createApiError(
								requestId,
								"VIDEO_UPLOAD_TOO_LARGE",
								"Video files must be 60 MB or smaller",
								413,
							);
						}

						const now = Date.now();
						const created = await db.transaction(async (tx) => {
							const [evidence] = await tx
								.insert(evidences)
								.values({
									orgId: workspace.activeOrgId,
									createdBy: workspace.localUserId,
									title: body.title,
									sourceType: "manual-upload",
									sourceExternalId: body.sessionId,
									sourceMetadata: body.sourceMetadata,
									thumbnailBase64: body.thumbnailBase64,
									thumbnailMimeType: body.thumbnailMimeType,
									scopeType: "organization",
									scopeId: workspace.activeOrgId,
									updatedAt: now,
								})
								.returning({ id: evidences.id, orgId: evidences.orgId });

							if (!evidence) {
								throw new Error("Failed to create manual upload evidence");
							}

							const uploadSessions = [];
							for (const artifactInput of body.artifacts) {
								const [artifact] = await tx
									.insert(evidenceArtifacts)
									.values({
										evidenceId: evidence.id,
										kind: artifactInput.kind,
										s3Key: `uploads/${workspace.activeOrgId}/${evidence.id}/${artifactInput.key}-${crypto.randomUUID()}`,
										mimeType: artifactInput.mimeType,
										bytes: Math.trunc(artifactInput.bytes),
										checksum: artifactInput.checksum,
										uploadStatus: "uploading",
										updatedAt: now,
									})
									.returning({
										id: evidenceArtifacts.id,
										s3Key: evidenceArtifacts.s3Key,
									});

								if (!artifact) {
									throw new Error("Failed to create manual upload artifact");
								}

								uploadSessions.push({
									key: artifactInput.key,
									uploadId: artifact.id,
									expiresAt: now + UPLOAD_SESSION_TTL_MS,
									uploadUrl: `${resolveExternalRequestOrigin(request, runtime)}/evidences/uploads/${artifact.id}/blob`,
									method: "PUT" as const,
									headers: {
										"content-type": artifactInput.mimeType,
									},
									storageKey: artifact.s3Key,
								});
							}

							return {
								evidenceId: evidence.id,
								organizationId: evidence.orgId,
								uploadSessions,
							};
						});

						await recordOrganizationActivity(db, {
							organizationId: created.organizationId,
							actorUserId: workspace.localUserId,
							action: "evidence.created",
							entity: evidenceActivityEntity(created.evidenceId),
							message: "Created manual evidence upload",
							metadata: {
								sourceType: "manual-upload",
								sourceExternalId: body.sessionId,
							},
							ipAddress: getRequestIpAddress(request),
						});

						return created;
					},
					{
						body: startManualUploadBodySchema,
						detail: {
							tags: ["evidences"],
							summary:
								"Starts a manual evidence upload with recording and generated archive artifacts",
						},
						response: {
							200: startDesktopSessionSyncResponseSchema,
							400: apiErrorSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							413: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.get(
					"/evidences",
					async ({ authContext, db, query, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						const resolvedOrg = await resolveRequestedOrgId({
							authContext,
							db,
							requestedOrgId: query.orgId,
							requestId,
							set,
						});
						if (!resolvedOrg.ok) {
							return resolvedOrg.error;
						}
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: resolvedOrg.orgId,
								localUserId: resolvedOrg.localUserId,
								permission: "evidence.view",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_VIEW_FORBIDDEN",
								"Your role cannot view evidence in this organization",
								403,
							);
						}

						const page = Math.max(1, Math.trunc(query.page ?? 1));
						const limit = Math.min(
							MAX_EVIDENCE_PAGE_SIZE,
							Math.max(
								1,
								Math.trunc(query.limit ?? DEFAULT_EVIDENCE_PAGE_SIZE),
							),
						);
						const creatorIds = parseCreatorFilter(query.createdBy);
						const tagIds = parseCreatorFilter(query.tagIds);
						const search = query.search?.trim();
						const searchPattern = search ? `%${search}%` : undefined;
						const where = and(
							eq(evidences.orgId, resolvedOrg.orgId),
							isNull(evidences.deletedAt),
							creatorIds.length > 0
								? inArray(evidences.createdBy, creatorIds)
								: undefined,
							tagIds.length > 0
								? inArray(
										evidences.id,
										db
											.select({ evidenceId: evidenceTagAssignments.evidenceId })
											.from(evidenceTagAssignments)
											.where(inArray(evidenceTagAssignments.tagId, tagIds)),
									)
								: undefined,
							searchPattern
								? or(
										like(evidences.title, searchPattern),
										like(evidences.id, searchPattern),
										like(evidences.sourceType, searchPattern),
										like(evidences.createdBy, searchPattern),
									)
								: undefined,
						);

						const rows = await db.query.evidences.findMany({
							where,
							columns: {
								id: true,
								orgId: true,
								title: true,
								sourceType: true,
								sourceExternalId: true,
								sourceMetadata: true,
								thumbnailBase64: true,
								thumbnailMimeType: true,
								createdBy: true,
								createdAt: true,
								updatedAt: true,
							},
							with: {
								artifacts: { columns: { uploadStatus: true } },
								tags: {
									with: {
										tag: { columns: { id: true, name: true, color: true } },
									},
								},
							},
							orderBy: desc(evidences.createdAt),
							limit,
							offset: (page - 1) * limit,
						});
						const totalRows = await db
							.select({ value: count() })
							.from(evidences)
							.where(where);

						return {
							evidences: rows.map(({ artifacts, tags, ...evidence }) => ({
								...evidence,
								...parseEvidenceStats(evidence.sourceMetadata),
								status: deriveEvidenceStatus(artifacts),
								tags: tags.map((assignment) => assignment.tag),
							})),
							orgId: resolvedOrg.orgId,
							total: totalRows[0]?.value ?? 0,
							page,
							limit,
						};
					},
					{
						query: listEvidenceQuerySchema,
						detail: {
							tags: ["evidences"],
							summary:
								"Lists evidence for active org by default; orgId query is allowed for member orgs",
						},
						response: {
							200: listEvidencesResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.get(
					"/evidences/tags",
					async ({ authContext, db, query, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						const resolvedOrg = await resolveRequestedOrgId({
							authContext,
							db,
							requestedOrgId: query.orgId,
							requestId,
							set,
						});
						if (!resolvedOrg.ok) return resolvedOrg.error;
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: resolvedOrg.orgId,
								localUserId: resolvedOrg.localUserId,
								permission: "evidence.view",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_TAGS_FORBIDDEN",
								"Your role cannot view evidence tags in this organization",
								403,
							);
						}

						return { tags: await listEvidenceTags(db, resolvedOrg.orgId) };
					},
					{
						query: evidenceQuerySchema,
						detail: {
							tags: ["evidences"],
							summary: "Lists organization-level evidence tags",
						},
						response: {
							200: listEvidenceTagsResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/evidences/tags",
					async ({ authContext, body, db, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						const resolvedOrg = await resolveRequestedOrgId({
							authContext,
							db,
							requestedOrgId: body.orgId,
							requestId,
							set,
						});
						if (!resolvedOrg.ok) return resolvedOrg.error;
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: resolvedOrg.orgId,
								localUserId: resolvedOrg.localUserId,
								permission: "evidence.tags.manage",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_TAGS_MANAGE_FORBIDDEN",
								"Your role cannot manage evidence tags",
								403,
							);
						}

						const name = body.name.trim();
						const color = body.color.trim();
						try {
							const [tag] = await db
								.insert(organizationEvidenceTags)
								.values({
									orgId: resolvedOrg.orgId,
									name,
									color,
									createdAt: Date.now(),
									updatedAt: Date.now(),
								})
								.returning({
									id: organizationEvidenceTags.id,
									name: organizationEvidenceTags.name,
									color: organizationEvidenceTags.color,
								});
							if (!tag) throw new Error("Tag was not created.");
							return { tag };
						} catch {
							set.status = 409;
							return createApiError(
								requestId,
								"EVIDENCE_TAG_EXISTS",
								"An evidence tag with this name already exists",
								409,
							);
						}
					},
					{
						body: evidenceTagBodySchema,
						detail: {
							tags: ["evidences"],
							summary: "Creates an organization-level evidence tag",
						},
						response: {
							200: evidenceTagResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							409: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.patch(
					"/evidences/tags/:tagId",
					async ({ authContext, body, db, params, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						const resolvedOrg = await resolveRequestedOrgId({
							authContext,
							db,
							requestedOrgId: body.orgId,
							requestId,
							set,
						});
						if (!resolvedOrg.ok) return resolvedOrg.error;
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: resolvedOrg.orgId,
								localUserId: resolvedOrg.localUserId,
								permission: "evidence.tags.manage",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_TAGS_MANAGE_FORBIDDEN",
								"Your role cannot manage evidence tags",
								403,
							);
						}

						const name = body.name.trim();
						const color = body.color.trim();
						try {
							const [tag] = await db
								.update(organizationEvidenceTags)
								.set({ name, color, updatedAt: Date.now() })
								.where(
									and(
										eq(organizationEvidenceTags.id, params.tagId),
										eq(organizationEvidenceTags.orgId, resolvedOrg.orgId),
									),
								)
								.returning({
									id: organizationEvidenceTags.id,
									name: organizationEvidenceTags.name,
									color: organizationEvidenceTags.color,
								});
							if (!tag) {
								set.status = 404;
								return createApiError(
									requestId,
									"EVIDENCE_TAG_NOT_FOUND",
									"Evidence tag was not found",
									404,
								);
							}
							return { tag };
						} catch {
							set.status = 409;
							return createApiError(
								requestId,
								"EVIDENCE_TAG_EXISTS",
								"An evidence tag with this name already exists",
								409,
							);
						}
					},
					{
						body: evidenceTagBodySchema,
						params: t.Object({ tagId: t.String({ minLength: 1 }) }),
						detail: {
							tags: ["evidences"],
							summary: "Updates an organization-level evidence tag",
						},
						response: {
							200: evidenceTagResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							409: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.delete(
					"/evidences/tags/:tagId",
					async ({ authContext, db, params, query, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						const resolvedOrg = await resolveRequestedOrgId({
							authContext,
							db,
							requestedOrgId: query.orgId,
							requestId,
							set,
						});
						if (!resolvedOrg.ok) return resolvedOrg.error;
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: resolvedOrg.orgId,
								localUserId: resolvedOrg.localUserId,
								permission: "evidence.tags.manage",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_TAGS_MANAGE_FORBIDDEN",
								"Your role cannot manage evidence tags",
								403,
							);
						}

						const [deleted] = await db
							.delete(organizationEvidenceTags)
							.where(
								and(
									eq(organizationEvidenceTags.id, params.tagId),
									eq(organizationEvidenceTags.orgId, resolvedOrg.orgId),
								),
							)
							.returning({ id: organizationEvidenceTags.id });
						if (!deleted) {
							set.status = 404;
							return createApiError(
								requestId,
								"EVIDENCE_TAG_NOT_FOUND",
								"Evidence tag was not found",
								404,
							);
						}

						return { tagId: deleted.id };
					},
					{
						query: evidenceQuerySchema,
						params: t.Object({ tagId: t.String({ minLength: 1 }) }),
						detail: {
							tags: ["evidences"],
							summary: "Deletes an organization-level evidence tag",
						},
						response: {
							200: t.Object({ tagId: t.String({ minLength: 1 }) }),
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.get(
					"/evidences/:id",
					async ({ authContext, db, params, query, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						const resolvedOrg = await resolveRequestedOrgId({
							authContext,
							db,
							requestedOrgId: query.orgId,
							requestId,
							set,
						});
						if (!resolvedOrg.ok) {
							return resolvedOrg.error;
						}
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: resolvedOrg.orgId,
								localUserId: resolvedOrg.localUserId,
								permission: "evidence.view",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_VIEW_FORBIDDEN",
								"Your role cannot view evidence in this organization",
								403,
							);
						}

						const evidence = await db.query.evidences.findFirst({
							where: and(
								eq(evidences.id, params.id),
								eq(evidences.orgId, resolvedOrg.orgId),
								isNull(evidences.deletedAt),
							),
							columns: {
								id: true,
								orgId: true,
								title: true,
								sourceType: true,
								sourceExternalId: true,
								sourceMetadata: true,
								thumbnailBase64: true,
								thumbnailMimeType: true,
								createdBy: true,
								createdAt: true,
								updatedAt: true,
							},
							with: {
								artifacts: { columns: { uploadStatus: true } },
								tags: {
									with: {
										tag: { columns: { id: true, name: true, color: true } },
									},
								},
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

						const { artifacts, tags, ...evidenceSummary } = evidence;
						return {
							evidence: {
								...evidenceSummary,
								...parseEvidenceStats(evidenceSummary.sourceMetadata),
								status: deriveEvidenceStatus(artifacts),
								tags: tags.map((assignment) => assignment.tag),
							},
						};
					},
					{
						params: t.Object({
							id: t.String({ minLength: 1 }),
						}),
						query: evidenceQuerySchema,
						detail: {
							tags: ["evidences"],
							summary:
								"Loads evidence scoped to active org by default; orgId query is allowed for member orgs",
						},
						response: {
							200: loadEvidenceResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.patch(
					"/evidences/:id/tags",
					async ({ authContext, body, db, params, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						const evidence = await db.query.evidences.findFirst({
							where: and(
								eq(evidences.id, params.id),
								isNull(evidences.deletedAt),
							),
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

						if (!authContext.localUserId) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_TAGS_FORBIDDEN",
								"Only workspace members can update evidence tags",
								403,
							);
						}

						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: evidence.orgId,
								localUserId: authContext.localUserId,
								permission: "evidence.tags.manage",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_TAGS_FORBIDDEN",
								"Your role cannot update evidence tags",
								403,
							);
						}

						await ensureDefaultEvidenceTags(db, evidence.orgId);
						const tagIds = Array.from(new Set(body.tagIds));
						const tags =
							tagIds.length > 0
								? await db.query.organizationEvidenceTags.findMany({
										where: and(
											eq(organizationEvidenceTags.orgId, evidence.orgId),
											inArray(organizationEvidenceTags.id, tagIds),
										),
										columns: { id: true, name: true, color: true },
									})
								: [];

						if (tags.length !== tagIds.length) {
							set.status = 400;
							return createApiError(
								requestId,
								"EVIDENCE_TAGS_INVALID",
								"One or more tags are not available in this organization",
								400,
							);
						}

						await db.transaction(async (tx) => {
							await tx
								.delete(evidenceTagAssignments)
								.where(eq(evidenceTagAssignments.evidenceId, evidence.id));
							if (tagIds.length > 0) {
								await tx.insert(evidenceTagAssignments).values(
									tagIds.map((tagId) => ({
										evidenceId: evidence.id,
										tagId,
										assignedBy: authContext.localUserId,
										createdAt: Date.now(),
									})),
								);
							}
							await tx
								.update(evidences)
								.set({ updatedAt: Date.now() })
								.where(eq(evidences.id, evidence.id));
						});

						return { evidence: { ...evidence, tags } };
					},
					{
						params: t.Object({ id: t.String({ minLength: 1 }) }),
						body: updateEvidenceTagsBodySchema,
						detail: {
							tags: ["evidences"],
							summary: "Updates evidence tag assignments",
						},
						response: {
							200: updateEvidenceTagsResponseSchema,
							400: apiErrorSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.get(
					"/evidences/:id/artifacts",
					async ({ authContext, db, params, query, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						const resolvedOrg = await resolveRequestedOrgId({
							authContext,
							db,
							requestedOrgId: query.orgId,
							requestId,
							set,
						});
						if (!resolvedOrg.ok) {
							return resolvedOrg.error;
						}
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: resolvedOrg.orgId,
								localUserId: resolvedOrg.localUserId,
								permission: "evidence.view",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_VIEW_FORBIDDEN",
								"Your role cannot view evidence in this organization",
								403,
							);
						}

						const evidence = await db.query.evidences.findFirst({
							where: and(
								eq(evidences.id, params.id),
								eq(evidences.orgId, resolvedOrg.orgId),
								isNull(evidences.deletedAt),
							),
							columns: { id: true },
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

						const artifacts = await db.query.evidenceArtifacts.findMany({
							where: eq(evidenceArtifacts.evidenceId, evidence.id),
							columns: {
								id: true,
								evidenceId: true,
								kind: true,
								mimeType: true,
								bytes: true,
								checksum: true,
								uploadStatus: true,
								createdAt: true,
								updatedAt: true,
							},
							orderBy: desc(evidenceArtifacts.createdAt),
						});

						return { artifacts };
					},
					{
						params: t.Object({
							id: t.String({ minLength: 1 }),
						}),
						query: evidenceQuerySchema,
						detail: {
							tags: ["evidences"],
							summary: "Lists artifacts for an evidence",
						},
						response: {
							200: listEvidenceArtifactsResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.get(
					"/evidences/:id/artifacts/:artifactId/read-url",
					async ({
						artifactStorage,
						authContext,
						db,
						params,
						query,
						request,
						requestId,
						set,
					}) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						if (artifactStorage.mode !== "s3") {
							set.status = 503;
							return createApiError(
								requestId,
								"ARTIFACT_STORAGE_NOT_CONFIGURED",
								"S3 artifact storage is not configured",
								503,
							);
						}

						const resolvedOrg = await resolveRequestedOrgId({
							authContext,
							db,
							requestedOrgId: query.orgId,
							requestId,
							set,
						});
						if (!resolvedOrg.ok) {
							return resolvedOrg.error;
						}
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: resolvedOrg.orgId,
								localUserId: resolvedOrg.localUserId,
								permission: "evidence.download",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"EVIDENCE_DOWNLOAD_FORBIDDEN",
								"Your role cannot download evidence in this organization",
								403,
							);
						}

						const artifact = await db.query.evidenceArtifacts.findFirst({
							where: and(
								eq(evidenceArtifacts.id, params.artifactId),
								eq(evidenceArtifacts.evidenceId, params.id),
							),
							columns: {
								id: true,
								s3Key: true,
								mimeType: true,
								uploadStatus: true,
							},
							with: {
								evidence: {
									columns: { id: true, orgId: true, deletedAt: true },
								},
							},
						});
						if (
							!artifact ||
							artifact.evidence.orgId !== resolvedOrg.orgId ||
							artifact.evidence.deletedAt !== null
						) {
							set.status = 404;
							return createApiError(
								requestId,
								"ARTIFACT_NOT_FOUND",
								"Artifact not found",
								404,
							);
						}

						if (artifact.uploadStatus !== "uploaded") {
							set.status = 409;
							return createApiError(
								requestId,
								"ARTIFACT_NOT_READY",
								"Artifact is not uploaded yet",
								409,
							);
						}

						const signed = await artifactStorage.createReadUrl({
							key: artifact.s3Key,
							responseContentType: artifact.mimeType,
						});
						await recordOrganizationActivity(db, {
							organizationId: resolvedOrg.orgId,
							actorUserId: resolvedOrg.localUserId,
							action: "evidence.download_url.created",
							entity: evidenceActivityEntity(artifact.evidence.id),
							message: "Created evidence download link",
							metadata: {
								artifactId: artifact.id,
								mimeType: artifact.mimeType,
								expiresAt: signed.expiresAt,
							},
							ipAddress: getRequestIpAddress(request),
						});

						return {
							url: signed.url,
							expiresAt: signed.expiresAt,
							renewAfterMs: Math.max(30_000, signed.ttlSeconds * 1000 * 0.7),
						};
					},
					{
						params: artifactReadUrlParamsSchema,
						query: evidenceQuerySchema,
						detail: {
							tags: ["evidences"],
							summary: "Creates a short-lived signed read URL for an artifact",
						},
						response: {
							200: artifactReadUrlResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							409: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.put(
					"/evidences/uploads/:uploadId/blob",
					async ({
						artifactStorage,
						authContext,
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

						const scopeDenied = requireSessionScope(
							authContext,
							"evidence:write",
							requestId,
							set,
						);
						if (scopeDenied) {
							return scopeDenied;
						}

						const workspace = resolveActiveWorkspace(
							authContext.activeOrgId,
							authContext.localUserId,
						);
						if (!workspace) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_CONTEXT_UNRESOLVED",
								"No active organization found for current user",
								403,
							);
						}

						const artifact = await db.query.evidenceArtifacts.findFirst({
							where: eq(evidenceArtifacts.id, params.uploadId),
							columns: {
								id: true,
								s3Key: true,
								kind: true,
								mimeType: true,
								uploadStatus: true,
								createdAt: true,
							},
							with: {
								evidence: {
									columns: { orgId: true },
								},
							},
						});

						if (
							!artifact ||
							artifact.evidence.orgId !== workspace.activeOrgId
						) {
							set.status = 404;
							return createApiError(
								requestId,
								"UPLOAD_NOT_FOUND",
								"Upload not found for active organization",
								404,
							);
						}

						if (Date.now() > artifact.createdAt + UPLOAD_SESSION_TTL_MS) {
							set.status = 410;
							return createApiError(
								requestId,
								"UPLOAD_SESSION_EXPIRED",
								"Upload session has expired; start a new upload",
								410,
							);
						}

						if (artifact.uploadStatus !== "uploading") {
							set.status = 409;
							return createApiError(
								requestId,
								"UPLOAD_NOT_ACCEPTING_BLOB",
								"Upload is not accepting blob writes in current state",
								409,
							);
						}

						const contentType = request.headers.get("content-type");
						if (!contentType || contentType !== artifact.mimeType) {
							set.status = 422;
							return createApiError(
								requestId,
								"UPLOAD_CONTENT_TYPE_MISMATCH",
								"Uploaded blob content-type did not match expected mimeType",
								422,
							);
						}

						const maximumBytes =
							artifact.kind === "recording"
								? MAX_VIDEO_UPLOAD_BYTES
								: MAX_UPLOAD_BYTES;
						const tooLargeResponse = createApiError(
							requestId,
							"UPLOAD_TOO_LARGE",
							artifact.kind === "recording"
								? "Video files must be 60 MB or smaller"
								: `Upload exceeds maximum allowed size of ${MAX_UPLOAD_BYTES} bytes`,
							413,
						);

						const contentLengthHeader = request.headers.get("content-length");
						const contentLength = contentLengthHeader
							? Number.parseInt(contentLengthHeader, 10)
							: null;
						if (contentLength !== null && contentLength > maximumBytes) {
							set.status = 413;
							return tooLargeResponse;
						}

						const payload = await request.arrayBuffer();
						if (payload.byteLength > maximumBytes) {
							set.status = 413;
							return tooLargeResponse;
						}

						const uploadedBlob: UploadedBlobMetadata = {
							bytes: payload.byteLength,
							checksum: await encodeSha256(payload),
							mimeType: artifact.mimeType,
						};

						await artifactStorage.putObject({
							key: artifact.s3Key,
							body: new Uint8Array(payload),
							contentType: artifact.mimeType,
							checksumSha256: sha256HexToBase64(uploadedBlob.checksum),
						});

						const updated = await db
							.update(evidenceArtifacts)
							.set({
								bytes: uploadedBlob.bytes,
								checksum: uploadedBlob.checksum,
								mimeType: uploadedBlob.mimeType,
								uploadStatus: "pending",
								updatedAt: Date.now(),
							})
							.where(
								and(
									eq(evidenceArtifacts.id, artifact.id),
									eq(evidenceArtifacts.uploadStatus, "uploading"),
								),
							)
							.returning({ id: evidenceArtifacts.id });

						if (!updated[0]) {
							set.status = 409;
							return createApiError(
								requestId,
								"UPLOAD_STATE_CONFLICT",
								"Upload state changed concurrently; check current status and retry",
								409,
							);
						}

						set.status = 204;
						return;
					},
					{
						params: uploadParamsSchema,
						detail: {
							tags: ["evidences"],
							summary:
								"Accepts upload binary for a server-scoped evidence upload",
						},
						response: {
							204: t.Void(),
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							409: apiErrorSchema,
							410: apiErrorSchema,
							413: apiErrorSchema,
							422: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.post(
					"/evidences/uploads/:uploadId/complete",
					async ({
						artifactStorage,
						authContext,
						body,
						db,
						params,
						requestId,
						set,
						videoNormalizationQueue,
						videoNormalizer,
					}) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}

						const scopeDenied = requireSessionScope(
							authContext,
							"evidence:write",
							requestId,
							set,
						);
						if (scopeDenied) {
							return scopeDenied;
						}

						const workspace = resolveActiveWorkspace(
							authContext.activeOrgId,
							authContext.localUserId,
						);
						if (!workspace) {
							set.status = 403;
							return createApiError(
								requestId,
								"ORG_CONTEXT_UNRESOLVED",
								"No active organization found for current user",
								403,
							);
						}

						const artifact = await db.query.evidenceArtifacts.findFirst({
							where: eq(evidenceArtifacts.id, params.uploadId),
							columns: {
								id: true,
								evidenceId: true,
								kind: true,
								s3Key: true,
								bytes: true,
								checksum: true,
								mimeType: true,
								uploadStatus: true,
								createdAt: true,
							},
							with: {
								evidence: {
									columns: { id: true, orgId: true, sourceType: true },
								},
							},
						});

						if (
							!artifact ||
							artifact.evidence.orgId !== workspace.activeOrgId
						) {
							set.status = 404;
							return createApiError(
								requestId,
								"UPLOAD_NOT_FOUND",
								"Upload not found for active organization",
								404,
							);
						}

						if (Date.now() > artifact.createdAt + UPLOAD_SESSION_TTL_MS) {
							set.status = 410;
							return createApiError(
								requestId,
								"UPLOAD_SESSION_EXPIRED",
								"Upload session has expired; start a new upload",
								410,
							);
						}

						if (artifact.uploadStatus === "uploading") {
							set.status = 409;
							return createApiError(
								requestId,
								"UPLOAD_BLOB_MISSING",
								"Upload blob was not found; upload binary before completing",
								409,
							);
						}

						if (artifact.uploadStatus !== "pending") {
							set.status = 409;
							return createApiError(
								requestId,
								"UPLOAD_NOT_COMPLETABLE",
								"Upload is not in a completable state",
								409,
							);
						}

						if (
							artifact.bytes !== Math.trunc(body.bytes) ||
							artifact.mimeType !== body.mimeType ||
							!checksumMatches(body.checksum, artifact.checksum)
						) {
							set.status = 422;
							return createApiError(
								requestId,
								"UPLOAD_BLOB_METADATA_MISMATCH",
								"Uploaded blob did not match completion metadata",
								422,
							);
						}

						let finalizedBlob: UploadedBlobMetadata = {
							bytes: artifact.bytes,
							checksum: artifact.checksum,
							mimeType: artifact.mimeType,
						};
						if (
							artifact.kind === "recording" &&
							artifact.evidence.sourceType === "manual-upload"
						) {
							try {
								finalizedBlob = await videoNormalizationQueue.run(async () => {
									const sourcePayload = await artifactStorage.getObject({
										key: artifact.s3Key,
									});
									const normalized = await videoNormalizer({
										payload: sourcePayload,
										mimeType: artifact.mimeType,
									});
									if (normalized.payload.byteLength > MAX_VIDEO_UPLOAD_BYTES) {
										throw new Error("Normalized video exceeds the 60 MB limit");
									}
									const checksum = await encodeSha256(
										normalized.payload.slice().buffer,
									);
									await artifactStorage.putObject({
										key: artifact.s3Key,
										body: normalized.payload,
										contentType: normalized.mimeType,
										checksumSha256: sha256HexToBase64(checksum),
									});
									return {
										bytes: normalized.payload.byteLength,
										checksum,
										mimeType: normalized.mimeType,
									};
								});
							} catch (error) {
								set.status = 422;
								return createApiError(
									requestId,
									"VIDEO_NORMALIZATION_FAILED",
									error instanceof Error
										? error.message
										: "Video could not be converted to 720p",
									422,
								);
							}
						}

						const now = Date.now();
						await db.transaction(async (tx) => {
							await tx
								.update(evidenceArtifacts)
								.set({
									...finalizedBlob,
									uploadStatus: "uploaded",
									updatedAt: now,
								})
								.where(eq(evidenceArtifacts.id, artifact.id));

							await tx
								.update(evidences)
								.set({ updatedAt: now })
								.where(
									and(
										eq(evidences.id, artifact.evidenceId),
										eq(evidences.orgId, workspace.activeOrgId),
									),
								);
						});

						return {
							uploadId: artifact.id,
							evidenceId: artifact.evidenceId,
							status: "committed",
						};
					},
					{
						params: uploadParamsSchema,
						body: completeUploadBodySchema,
						detail: {
							tags: ["evidences"],
							summary: "Completes a server-scoped evidence upload",
						},
						response: {
							200: completeUploadResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							409: apiErrorSchema,
							410: apiErrorSchema,
							422: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				),
		);
