import { Buffer } from "node:buffer";
import {
	recordingFileName,
	safeParseSessionArchiveJson,
	sessionArchiveFileName,
} from "@jittle-lamp/shared";
import { and, desc, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { unzipSync } from "fflate";
import {
	automationApiTokens,
	desktopRecordingSessions,
	evidenceArtifacts,
	evidences,
} from "../db/schema";
import {
	apiErrorSchema,
	createApiError,
	createDbUnavailableError,
} from "../http/api-error";
import type { ClerkAuthPlugin } from "../plugins/clerk-auth";
import {
	AUTOMATION_API_TOKEN_SCOPE,
	createAutomationApiToken,
	revokeAutomationApiToken,
	verifyAutomationApiToken,
} from "../services/automation-api-tokens";
import {
	evidenceActivityEntity,
	getRequestIpAddress,
	recordOrganizationActivity,
} from "../services/organization-activity";
import { organizationMemberHasPermission } from "../services/organization-permissions";

const DEFAULT_AUTOMATION_TOKEN_EXPIRES_IN_DAYS = 365;
const MAX_AUTOMATION_TOKEN_EXPIRES_IN_DAYS = 3650;
const MAX_AUTOMATION_ZIP_BYTES = 20 * 1024 * 1024;

const createAutomationTokenBodySchema = t.Object({
	label: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
	orgId: t.Optional(t.String({ minLength: 1 })),
	permanent: t.Optional(t.Boolean()),
	expiresInDays: t.Optional(
		t.Number({ minimum: 1, maximum: MAX_AUTOMATION_TOKEN_EXPIRES_IN_DAYS }),
	),
});

const automationTokenParamsSchema = t.Object({
	id: t.String({ minLength: 1 }),
});

const automationUploadQuerySchema = t.Object({
	title: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
	sourceExternalId: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
});

const automationTokenSummarySchema = t.Object({
	id: t.String({ minLength: 1 }),
	orgId: t.String({ minLength: 1 }),
	label: t.String({ minLength: 1 }),
	token: t.Union([t.String({ minLength: 1 }), t.Null()]),
	tokenPrefix: t.String({ minLength: 1 }),
	scopes: t.Array(t.String({ minLength: 1 })),
	createdAt: t.Number(),
	expiresAt: t.Union([t.Number(), t.Null()]),
	lastUsedAt: t.Union([t.Number(), t.Null()]),
	revokedAt: t.Union([t.Number(), t.Null()]),
});

const createAutomationTokenResponseSchema = t.Object({
	apiToken: automationTokenSummarySchema,
	token: t.String({ minLength: 1 }),
});

const listAutomationTokensResponseSchema = t.Object({
	apiTokens: t.Array(automationTokenSummarySchema),
});

const revokeAutomationTokenResponseSchema = t.Object({
	apiToken: t.Object({
		id: t.String({ minLength: 1 }),
		revokedAt: t.Number(),
	}),
});

const automationUploadResponseSchema = t.Object({
	evidence: t.Object({
		id: t.String({ minLength: 1 }),
		orgId: t.String({ minLength: 1 }),
		title: t.String({ minLength: 1 }),
		sourceExternalId: t.String({ minLength: 1 }),
	}),
	artifacts: t.Array(
		t.Object({
			id: t.String({ minLength: 1 }),
			kind: t.String({ minLength: 1 }),
			mimeType: t.String({ minLength: 1 }),
			bytes: t.Number(),
			checksum: t.String({ minLength: 1 }),
		}),
	),
	limits: t.Object({
		maxZipBytes: t.Number(),
	}),
});

const parseScopes = (value: string): string[] =>
	value
		.split(" ")
		.map((scope) => scope.trim())
		.filter(Boolean);

const mapAutomationTokenSummary = (token: {
	id: string;
	orgId: string;
	label: string;
	tokenSecret: string;
	tokenPrefix: string;
	scopes: string;
	createdAt: number;
	expiresAt: number | null;
	lastUsedAt: number | null;
	revokedAt: number | null;
}) => ({
	id: token.id,
	orgId: token.orgId,
	label: token.label,
	token: token.tokenSecret,
	tokenPrefix: token.tokenPrefix,
	scopes: parseScopes(token.scopes),
	createdAt: token.createdAt,
	expiresAt: token.expiresAt,
	lastUsedAt: token.lastUsedAt,
	revokedAt: token.revokedAt,
});

const readBearerToken = (request: Request): string | null => {
	const authHeader = request.headers.get("authorization");
	return authHeader?.startsWith("Bearer ")
		? authHeader.slice("Bearer ".length).trim()
		: null;
};

const encodeSha256Hex = async (payload: Uint8Array): Promise<string> => {
	const copy = new Uint8Array(payload.byteLength);
	copy.set(payload);
	const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
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

const validateAutomationZip = (zipBytes: Uint8Array) => {
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(zipBytes);
	} catch {
		return {
			ok: false as const,
			message: "Upload body must be a readable ZIP archive",
		};
	}

	const fileNames = Object.keys(files).sort();
	const expected = [recordingFileName, sessionArchiveFileName].sort();
	if (
		fileNames.length !== expected.length ||
		fileNames.some((fileName, index) => fileName !== expected[index])
	) {
		return {
			ok: false as const,
			message: `ZIP must contain exactly ${sessionArchiveFileName} and ${recordingFileName} at the root`,
		};
	}

	const archiveJson = files[sessionArchiveFileName];
	const recordingWebm = files[recordingFileName];
	if (!archiveJson || !recordingWebm) {
		return {
			ok: false as const,
			message: "ZIP is missing required session files",
		};
	}
	if (recordingWebm.byteLength === 0) {
		return {
			ok: false as const,
			message: `${recordingFileName} must not be empty`,
		};
	}

	const parsedArchive = safeParseSessionArchiveJson(archiveJson);
	if (!parsedArchive.success) {
		return {
			ok: false as const,
			message: `Invalid ${sessionArchiveFileName}: ${parsedArchive.error.message}`,
		};
	}

	const artifactKinds = new Set(
		parsedArchive.data.artifacts.map((artifact) => artifact.kind),
	);
	if (
		!artifactKinds.has(recordingFileName) ||
		!artifactKinds.has(sessionArchiveFileName)
	) {
		return {
			ok: false as const,
			message: `${sessionArchiveFileName} must declare recording and archive artifacts`,
		};
	}

	return {
		ok: true as const,
		archive: parsedArchive.data,
		archiveJson,
		recordingWebm,
	};
};

export const createAutomationRoutes = (auth: ClerkAuthPlugin) =>
	new Elysia({ name: "automation-routes" })
		.use(auth)
		.guard({ auth: true }, (app) =>
			app
				.post(
					"/automation/api-tokens",
					async ({ authContext, body, db, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						if (!authContext.localUserId || !authContext.activeOrgId) {
							set.status = 403;
							return createApiError(
								requestId,
								"AUTOMATION_TOKEN_ACCOUNT_REQUIRED",
								"Only workspace accounts can issue automation API tokens",
								403,
							);
						}

						const orgId = body.orgId ?? authContext.activeOrgId;
						if (
							!(await organizationMemberHasPermission(db, {
								organizationId: orgId,
								localUserId: authContext.localUserId,
								permission: "evidence.create",
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"AUTOMATION_TOKEN_FORBIDDEN",
								"Your role cannot create evidence in this organization",
								403,
							);
						}

						const label = body.label?.trim() || "Automation evidence uploader";
						const days = Math.trunc(
							body.expiresInDays ?? DEFAULT_AUTOMATION_TOKEN_EXPIRES_IN_DAYS,
						);
						const expiresAt = body.permanent
							? null
							: Date.now() + days * 24 * 60 * 60 * 1000;
						return createAutomationApiToken(db, {
							userId: authContext.localUserId,
							orgId,
							label,
							expiresAt,
						});
					},
					{
						body: createAutomationTokenBodySchema,
						detail: {
							tags: ["automation"],
							summary: "Issues an API token for automation evidence uploads",
						},
						response: {
							200: createAutomationTokenResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.get(
					"/automation/api-tokens",
					async ({ authContext, db, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						if (!authContext.localUserId) {
							set.status = 403;
							return createApiError(
								requestId,
								"AUTOMATION_TOKEN_ACCOUNT_REQUIRED",
								"Only workspace accounts can list automation API tokens",
								403,
							);
						}

						const rows = await db.query.automationApiTokens.findMany({
							where: eq(automationApiTokens.userId, authContext.localUserId),
							columns: {
								id: true,
								orgId: true,
								label: true,
								tokenSecret: true,
								tokenPrefix: true,
								scopes: true,
								createdAt: true,
								expiresAt: true,
								lastUsedAt: true,
								revokedAt: true,
							},
							orderBy: desc(automationApiTokens.createdAt),
						});

						return { apiTokens: rows.map(mapAutomationTokenSummary) };
					},
					{
						detail: {
							tags: ["automation"],
							summary: "Lists automation API tokens for the current account",
						},
						response: {
							200: listAutomationTokensResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.delete(
					"/automation/api-tokens/:id",
					async ({ authContext, db, params, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						if (!authContext.localUserId) {
							set.status = 403;
							return createApiError(
								requestId,
								"AUTOMATION_TOKEN_ACCOUNT_REQUIRED",
								"Only workspace accounts can revoke automation API tokens",
								403,
							);
						}

						const revokedAt = Date.now();
						const revoked = await revokeAutomationApiToken(db, {
							tokenId: params.id,
							userId: authContext.localUserId,
						});
						if (!revoked) {
							set.status = 404;
							return createApiError(
								requestId,
								"AUTOMATION_TOKEN_NOT_FOUND",
								"Automation API token not found",
								404,
							);
						}

						return { apiToken: { id: params.id, revokedAt } };
					},
					{
						params: automationTokenParamsSchema,
						detail: {
							tags: ["automation"],
							summary: "Revokes an automation API token",
						},
						response: {
							200: revokeAutomationTokenResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				),
		)
		.post(
			"/automation/evidences/zip",
			async ({ artifactStorage, db, query, request, requestId, set }) => {
				if (!db) {
					set.status = 503;
					return createDbUnavailableError(requestId);
				}

				const bearerToken = readBearerToken(request);
				if (!bearerToken) {
					set.status = 401;
					return createApiError(
						requestId,
						"AUTOMATION_AUTH_REQUIRED",
						"Automation API token required",
						401,
					);
				}
				const apiToken = await verifyAutomationApiToken(db, bearerToken);
				if (!apiToken?.scopes.includes(AUTOMATION_API_TOKEN_SCOPE)) {
					set.status = 401;
					return createApiError(
						requestId,
						"AUTOMATION_AUTH_INVALID_TOKEN",
						"Invalid or expired automation API token",
						401,
					);
				}
				if (
					!(await organizationMemberHasPermission(db, {
						organizationId: apiToken.orgId,
						localUserId: apiToken.userId,
						permission: "evidence.create",
					}))
				) {
					set.status = 403;
					return createApiError(
						requestId,
						"AUTOMATION_EVIDENCE_CREATE_FORBIDDEN",
						"Token owner can no longer create evidence in this organization",
						403,
					);
				}

				const contentType = request.headers.get("content-type") ?? "";
				if (!contentType.toLowerCase().includes("application/zip")) {
					set.status = 415;
					return createApiError(
						requestId,
						"AUTOMATION_UPLOAD_CONTENT_TYPE_INVALID",
						"Upload content-type must be application/zip",
						415,
					);
				}

				const contentLength = Number.parseInt(
					request.headers.get("content-length") ?? "",
					10,
				);
				if (
					Number.isFinite(contentLength) &&
					contentLength > MAX_AUTOMATION_ZIP_BYTES
				) {
					set.status = 413;
					return createApiError(
						requestId,
						"AUTOMATION_UPLOAD_TOO_LARGE",
						"Automation evidence ZIP must be 20 MB or smaller",
						413,
					);
				}

				const zipBytes = new Uint8Array(await request.arrayBuffer());
				if (zipBytes.byteLength > MAX_AUTOMATION_ZIP_BYTES) {
					set.status = 413;
					return createApiError(
						requestId,
						"AUTOMATION_UPLOAD_TOO_LARGE",
						"Automation evidence ZIP must be 20 MB or smaller",
						413,
					);
				}

				const validated = validateAutomationZip(zipBytes);
				if (!validated.ok) {
					set.status = 400;
					return createApiError(
						requestId,
						"AUTOMATION_UPLOAD_ZIP_INVALID",
						validated.message,
						400,
					);
				}

				const archiveChecksum = await encodeSha256Hex(validated.archiveJson);
				const recordingChecksum = await encodeSha256Hex(
					validated.recordingWebm,
				);
				const now = Date.now();
				const title = query.title?.trim() || validated.archive.name;
				const sourceExternalId =
					query.sourceExternalId?.trim() || validated.archive.sessionId;
				const created = await db.transaction(async (tx) => {
					const [evidence] = await tx
						.insert(evidences)
						.values({
							orgId: apiToken.orgId,
							createdBy: apiToken.userId,
							title,
							sourceType: "automation-test",
							sourceExternalId,
							sourceMetadata: JSON.stringify({
								automationTokenId: apiToken.id,
								sessionId: validated.archive.sessionId,
							}),
							scopeType: "organization",
							scopeId: apiToken.orgId,
							updatedAt: now,
						})
						.returning({ id: evidences.id, orgId: evidences.orgId });
					if (!evidence) {
						throw new Error("Failed to create automation evidence");
					}

					await tx
						.insert(desktopRecordingSessions)
						.values({
							sessionId: validated.archive.sessionId,
							evidenceId: evidence.id,
							orgId: evidence.orgId,
							createdBy: apiToken.userId,
							sourceMetadata: JSON.stringify({
								source: "automation-api",
								automationTokenId: apiToken.id,
							}),
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: [
								desktopRecordingSessions.orgId,
								desktopRecordingSessions.sessionId,
							],
							set: {
								evidenceId: evidence.id,
								sourceMetadata: JSON.stringify({
									source: "automation-api",
									automationTokenId: apiToken.id,
								}),
								updatedAt: now,
							},
						});

					const [recordingArtifact, archiveArtifact] = await tx
						.insert(evidenceArtifacts)
						.values([
							{
								evidenceId: evidence.id,
								kind: "recording",
								s3Key: `uploads/${apiToken.orgId}/${evidence.id}/automation-recording-${crypto.randomUUID()}`,
								mimeType: "video/webm",
								bytes: validated.recordingWebm.byteLength,
								checksum: `sha256:${recordingChecksum}`,
								uploadStatus: "uploading",
								updatedAt: now,
							},
							{
								evidenceId: evidence.id,
								kind: "network-log",
								s3Key: `uploads/${apiToken.orgId}/${evidence.id}/automation-archive-${crypto.randomUUID()}`,
								mimeType: "application/json",
								bytes: validated.archiveJson.byteLength,
								checksum: `sha256:${archiveChecksum}`,
								uploadStatus: "uploading",
								updatedAt: now,
							},
						])
						.returning({
							id: evidenceArtifacts.id,
							kind: evidenceArtifacts.kind,
							s3Key: evidenceArtifacts.s3Key,
							mimeType: evidenceArtifacts.mimeType,
							bytes: evidenceArtifacts.bytes,
							checksum: evidenceArtifacts.checksum,
						});

					if (!recordingArtifact || !archiveArtifact) {
						throw new Error("Failed to create automation evidence artifacts");
					}

					return {
						evidence,
						artifacts: [recordingArtifact, archiveArtifact],
					};
				});

				const recordingArtifact = created.artifacts.find(
					(artifact) => artifact.kind === "recording",
				);
				const archiveArtifact = created.artifacts.find(
					(artifact) => artifact.kind === "network-log",
				);
				if (!recordingArtifact || !archiveArtifact) {
					throw new Error("Automation evidence artifacts were not created");
				}

				await Promise.all([
					artifactStorage.putObject({
						key: recordingArtifact.s3Key,
						body: validated.recordingWebm,
						contentType: "video/webm",
						checksumSha256: sha256HexToBase64(recordingChecksum),
					}),
					artifactStorage.putObject({
						key: archiveArtifact.s3Key,
						body: validated.archiveJson,
						contentType: "application/json",
						checksumSha256: sha256HexToBase64(archiveChecksum),
					}),
				]);

				await db
					.update(evidenceArtifacts)
					.set({ uploadStatus: "uploaded", updatedAt: Date.now() })
					.where(
						and(
							eq(evidenceArtifacts.evidenceId, created.evidence.id),
							eq(evidenceArtifacts.uploadStatus, "uploading"),
						),
					);

				await recordOrganizationActivity(db, {
					organizationId: created.evidence.orgId,
					actorUserId: apiToken.userId,
					action: "evidence.created",
					entity: evidenceActivityEntity(created.evidence.id),
					message: "Created automation evidence recording",
					metadata: {
						sourceType: "automation-test",
						sessionId: validated.archive.sessionId,
						automationTokenId: apiToken.id,
						maxZipBytes: MAX_AUTOMATION_ZIP_BYTES,
					},
					ipAddress: getRequestIpAddress(request),
				});

				return {
					evidence: {
						id: created.evidence.id,
						orgId: created.evidence.orgId,
						title,
						sourceExternalId,
					},
					artifacts: created.artifacts.map((artifact) => ({
						id: artifact.id,
						kind: artifact.kind,
						mimeType: artifact.mimeType,
						bytes: artifact.bytes,
						checksum: artifact.checksum,
					})),
					limits: {
						maxZipBytes: MAX_AUTOMATION_ZIP_BYTES,
					},
				};
			},
			{
				query: automationUploadQuerySchema,
				detail: {
					tags: ["automation"],
					summary: "Uploads a complete automation evidence ZIP",
				},
				response: {
					200: automationUploadResponseSchema,
					400: apiErrorSchema,
					401: apiErrorSchema,
					403: apiErrorSchema,
					413: apiErrorSchema,
					415: apiErrorSchema,
					500: apiErrorSchema,
					503: apiErrorSchema,
				},
			},
		);
