import { and, desc, eq, isNull } from "drizzle-orm";
import { Elysia, t } from "elysia";

import {
	aiAccessTokens,
	desktopRecordingSessions,
	evidenceArtifacts,
	evidences,
	organizations,
} from "../db/schema";
import {
	apiErrorSchema,
	createApiError,
	createDbUnavailableError,
} from "../http/api-error";
import type { ClerkAuthPlugin } from "../plugins/clerk-auth";
import {
	AI_ACCESS_TOKEN_SCOPE,
	createAiAccessToken,
	recordAiAccessTokenUsage,
	revokeAiAccessToken,
	verifyAiAccessToken,
} from "../services/ai-access-tokens";
import { createEvidencePolicy } from "../services/evidence-policy";
import { getRequestIpAddress } from "../services/organization-activity";

const DEFAULT_AI_TOKEN_EXPIRES_IN_DAYS = 90;
const MAX_AI_TOKEN_EXPIRES_IN_DAYS = 365;

const createAiTokenBodySchema = t.Object({
	label: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
	permanent: t.Optional(t.Boolean()),
	expiresInDays: t.Optional(
		t.Number({ minimum: 1, maximum: MAX_AI_TOKEN_EXPIRES_IN_DAYS }),
	),
});

const aiTokenParamsSchema = t.Object({
	id: t.String({ minLength: 1 }),
});

const evidenceDebugParamsSchema = t.Object({
	id: t.String({ minLength: 1 }),
});

const evidenceDebugQuerySchema = t.Object({
	orgId: t.Optional(t.String({ minLength: 1 })),
	includeReadUrls: t.Optional(t.Boolean()),
});

const aiAccessTokenSummarySchema = t.Object({
	id: t.String({ minLength: 1 }),
	label: t.String({ minLength: 1 }),
	tokenPrefix: t.String({ minLength: 1 }),
	scopes: t.Array(t.String({ minLength: 1 })),
	createdAt: t.Number(),
	expiresAt: t.Union([t.Number(), t.Null()]),
	lastUsedAt: t.Union([t.Number(), t.Null()]),
	revokedAt: t.Union([t.Number(), t.Null()]),
});

const createAiAccessTokenResponseSchema = t.Object({
	accessToken: aiAccessTokenSummarySchema,
	token: t.String({ minLength: 1 }),
});

const listAiAccessTokensResponseSchema = t.Object({
	accessTokens: t.Array(aiAccessTokenSummarySchema),
});

const revokeAiAccessTokenResponseSchema = t.Object({
	accessToken: t.Object({
		id: t.String({ minLength: 1 }),
		revokedAt: t.Number(),
	}),
});

const artifactReadUrlDebugSchema = t.Object({
	url: t.String({ minLength: 1 }),
	expiresAt: t.Number(),
	renewAfterMs: t.Number(),
});

const aiEvidenceDebugResponseSchema = t.Object({
	access: t.Object({
		tokenId: t.String({ minLength: 1 }),
		tokenLabel: t.String({ minLength: 1 }),
		userId: t.String({ minLength: 1 }),
		scopes: t.Array(t.String({ minLength: 1 })),
	}),
	organization: t.Object({
		id: t.String({ minLength: 1 }),
		name: t.String({ minLength: 1 }),
	}),
	evidence: t.Object({
		id: t.String({ minLength: 1 }),
		orgId: t.String({ minLength: 1 }),
		title: t.String({ minLength: 1 }),
		sourceType: t.String({ minLength: 1 }),
		sourceUri: t.Union([t.String({ minLength: 1 }), t.Null()]),
		sourceExternalId: t.Union([t.String({ minLength: 1 }), t.Null()]),
		sourceMetadata: t.Union([t.String(), t.Null()]),
		createdBy: t.String({ minLength: 1 }),
		createdAt: t.Number(),
		updatedAt: t.Number(),
		status: t.Union([t.Literal("ready"), t.Literal("pending")]),
	}),
	desktopSession: t.Union([
		t.Object({
			id: t.String({ minLength: 1 }),
			sessionId: t.String({ minLength: 1 }),
			sourceMetadata: t.Union([t.String(), t.Null()]),
			createdAt: t.Number(),
			updatedAt: t.Number(),
		}),
		t.Null(),
	]),
	artifacts: t.Array(
		t.Object({
			id: t.String({ minLength: 1 }),
			role: t.Union([
				t.Literal("recording"),
				t.Literal("session_archive"),
				t.Literal("other"),
			]),
			kind: t.String({ minLength: 1 }),
			mimeType: t.String({ minLength: 1 }),
			bytes: t.Number(),
			checksum: t.String({ minLength: 1 }),
			uploadStatus: t.String({ minLength: 1 }),
			createdAt: t.Number(),
			updatedAt: t.Number(),
			readUrl: t.Union([artifactReadUrlDebugSchema, t.Null()]),
			readUrlUnavailableReason: t.Union([t.String({ minLength: 1 }), t.Null()]),
		}),
	),
	debug: t.Object({
		llmsUrl: t.String({ minLength: 1 }),
		recommendedArtifactId: t.Union([t.String({ minLength: 1 }), t.Null()]),
		recommendedArtifactRole: t.Union([
			t.Literal("session_archive"),
			t.Literal("recording"),
			t.Null(),
		]),
		notes: t.Array(t.String({ minLength: 1 })),
	}),
});

const readBearerToken = (request: Request): string | null => {
	const authHeader = request.headers.get("authorization");
	return authHeader?.startsWith("Bearer ")
		? authHeader.slice("Bearer ".length).trim()
		: null;
};

const parseScopes = (value: string): string[] =>
	value
		.split(" ")
		.map((scope) => scope.trim())
		.filter(Boolean);

const deriveEvidenceStatus = (
	artifacts: { uploadStatus: string }[],
): "ready" | "pending" =>
	artifacts.length > 0 &&
	artifacts.every((artifact) => artifact.uploadStatus === "uploaded")
		? "ready"
		: "pending";

const classifyArtifactRole = (artifact: {
	kind: string;
	mimeType: string;
	s3Key: string;
}): "recording" | "session_archive" | "other" => {
	if (artifact.kind === "recording") {
		return "recording";
	}
	if (
		artifact.s3Key.includes("/archive-") ||
		(artifact.kind === "network-log" &&
			artifact.mimeType === "application/json")
	) {
		return "session_archive";
	}
	return "other";
};

const resolveExternalOrigin = (request: Request, apiOrigin?: string) => {
	if (apiOrigin) return apiOrigin;
	const url = new URL(request.url);
	return `${url.protocol}//${url.host}`;
};

const resolveRequestPath = (request: Request): string => {
	const url = new URL(request.url);
	return `${url.pathname}${url.search}`;
};

const buildLlmsTxt = (
	baseOrigin: string,
) => `# Jittle Lamp AI Evidence Debugging

Use this document when a user asks you to inspect, debug, or explain a Jittle Lamp evidence recording.

## Authentication

Ask the user for a Jittle Lamp AI access token. It starts with "jl_ai_". Send it as:

Authorization: Bearer <token>

The token is account-scoped, read-only for AI debugging, and can only access evidence the issuing account can view and download.

## Primary Endpoint

GET ${baseOrigin}/ai/evidences/{evidenceId}/debug

Optional query parameters:
- orgId: require the evidence to belong to this organization.
- includeReadUrls: set to false when you only need metadata.

The response includes evidence metadata, organization metadata, desktop session metadata, artifact metadata, and short-lived read URLs for uploaded artifacts when object storage is configured.

## Debugging Workflow

1. Call the debug endpoint with the evidence id.
2. Prefer the artifact whose role is "session_archive"; it is the JSON session archive.
3. Fetch the session archive readUrl, parse the JSON, and inspect actions, console entries, network entries, errors, and lifecycle events.
4. Use the recording artifact only when visual playback is needed.
5. Keep conclusions tied to the returned evidence, session, artifact checksums, timestamps, request/response data, console entries, and errors. Say when a cause is not proven.
`;

const mapTokenSummary = (token: {
	id: string;
	label: string;
	tokenPrefix: string;
	scopes: string;
	createdAt: number;
	expiresAt: number | null;
	lastUsedAt: number | null;
	revokedAt: number | null;
}) => ({
	...token,
	scopes: parseScopes(token.scopes),
});

export const createAiRoutes = (auth: ClerkAuthPlugin) =>
	new Elysia({ name: "ai-routes" })
		.use(auth)
		.get(
			"/llms.txt",
			({ request, runtime, set }) => {
				set.headers["content-type"] = "text/plain; charset=utf-8";
				return buildLlmsTxt(resolveExternalOrigin(request, runtime.apiOrigin));
			},
			{
				detail: {
					tags: ["ai"],
					summary: "Returns instructions for AI agents debugging evidence",
				},
			},
		)
		.guard({ auth: true }, (app) =>
			app
				.post(
					"/ai/access-tokens",
					async ({ authContext, body, db, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						if (!authContext.localUserId) {
							set.status = 403;
							return createApiError(
								requestId,
								"AI_TOKEN_ACCOUNT_REQUIRED",
								"Only workspace accounts can issue AI access tokens",
								403,
							);
						}

						const label = body.label?.trim() || "AI evidence debugger";
						const days = Math.trunc(
							body.expiresInDays ?? DEFAULT_AI_TOKEN_EXPIRES_IN_DAYS,
						);
						const expiresAt = body.permanent
							? null
							: Date.now() + days * 24 * 60 * 60 * 1000;
						return createAiAccessToken(db, {
							userId: authContext.localUserId,
							label,
							expiresAt,
						});
					},
					{
						body: createAiTokenBodySchema,
						detail: {
							tags: ["ai"],
							summary: "Issues a read-only AI access token for this account",
						},
						response: {
							200: createAiAccessTokenResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.get(
					"/ai/access-tokens",
					async ({ authContext, db, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						if (!authContext.localUserId) {
							set.status = 403;
							return createApiError(
								requestId,
								"AI_TOKEN_ACCOUNT_REQUIRED",
								"Only workspace accounts can list AI access tokens",
								403,
							);
						}

						const rows = await db.query.aiAccessTokens.findMany({
							where: eq(aiAccessTokens.userId, authContext.localUserId),
							columns: {
								id: true,
								label: true,
								tokenPrefix: true,
								scopes: true,
								createdAt: true,
								expiresAt: true,
								lastUsedAt: true,
								revokedAt: true,
							},
							orderBy: desc(aiAccessTokens.createdAt),
						});

						return { accessTokens: rows.map(mapTokenSummary) };
					},
					{
						detail: {
							tags: ["ai"],
							summary: "Lists AI access tokens for this account",
						},
						response: {
							200: listAiAccessTokensResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				)
				.delete(
					"/ai/access-tokens/:id",
					async ({ authContext, db, params, requestId, set }) => {
						if (!db) {
							set.status = 503;
							return createDbUnavailableError(requestId);
						}
						if (!authContext.localUserId) {
							set.status = 403;
							return createApiError(
								requestId,
								"AI_TOKEN_ACCOUNT_REQUIRED",
								"Only workspace accounts can revoke AI access tokens",
								403,
							);
						}

						const revokedAt = Date.now();
						const revoked = await revokeAiAccessToken(db, {
							tokenId: params.id,
							userId: authContext.localUserId,
						});
						if (!revoked) {
							set.status = 404;
							return createApiError(
								requestId,
								"AI_TOKEN_NOT_FOUND",
								"AI access token not found",
								404,
							);
						}

						return { accessToken: { id: params.id, revokedAt } };
					},
					{
						params: aiTokenParamsSchema,
						detail: {
							tags: ["ai"],
							summary: "Revokes an AI access token for this account",
						},
						response: {
							200: revokeAiAccessTokenResponseSchema,
							401: apiErrorSchema,
							403: apiErrorSchema,
							404: apiErrorSchema,
							500: apiErrorSchema,
							503: apiErrorSchema,
						},
					},
				),
		)
		.get(
			"/ai/evidences/:id/debug",
			async ({
				artifactStorage,
				db,
				params,
				query,
				request,
				requestId,
				runtime,
				set,
			}) => {
				if (!db) {
					set.status = 503;
					return createDbUnavailableError(requestId);
				}

				const token = readBearerToken(request);
				if (!token) {
					set.status = 401;
					return createApiError(
						requestId,
						"AI_AUTH_UNAUTHENTICATED",
						"AI access token required",
						401,
					);
				}

				const aiToken = await verifyAiAccessToken(db, token);
				if (!aiToken?.scopes.includes(AI_ACCESS_TOKEN_SCOPE)) {
					set.status = 401;
					return createApiError(
						requestId,
						"AI_AUTH_INVALID_TOKEN",
						"Invalid or expired AI access token",
						401,
					);
				}
				await recordAiAccessTokenUsage(db, {
					tokenId: aiToken.id,
					userId: aiToken.userId,
					evidenceId: params.id,
					method: request.method,
					path: resolveRequestPath(request),
					ipAddress: getRequestIpAddress(request),
					userAgent: request.headers.get("user-agent"),
				});

				const evidence = await db.query.evidences.findFirst({
					where: and(
						eq(evidences.id, params.id),
						query.orgId ? eq(evidences.orgId, query.orgId) : undefined,
						isNull(evidences.deletedAt),
					),
					columns: {
						id: true,
						orgId: true,
						teamId: true,
						title: true,
						sourceType: true,
						sourceUri: true,
						sourceExternalId: true,
						sourceMetadata: true,
						createdBy: true,
						createdAt: true,
						updatedAt: true,
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

				const evidencePolicy = createEvidencePolicy();
				const [canView, canDownload] = await Promise.all([
					evidencePolicy.canViewEvidence(db, {
						organizationId: evidence.orgId,
						teamId: evidence.teamId,
						userId: aiToken.userId,
					}),
					evidencePolicy.canShareEvidence(db, {
						organizationId: evidence.orgId,
						teamId: evidence.teamId,
						userId: aiToken.userId,
					}),
				]);
				if (!canView) {
					set.status = 404;
					return createApiError(
						requestId,
						"EVIDENCE_NOT_FOUND",
						"Evidence not found",
						404,
					);
				}
				if (!canDownload) {
					set.status = 403;
					return createApiError(
						requestId,
						"EVIDENCE_DOWNLOAD_FORBIDDEN",
						"AI access requires evidence download permission for this organization",
						403,
					);
				}

				const [organization, desktopSession, artifacts] = await Promise.all([
					db.query.organizations.findFirst({
						where: eq(organizations.id, evidence.orgId),
						columns: { id: true, name: true },
					}),
					db.query.desktopRecordingSessions.findFirst({
						where: eq(desktopRecordingSessions.evidenceId, evidence.id),
						columns: {
							id: true,
							sessionId: true,
							sourceMetadata: true,
							createdAt: true,
							updatedAt: true,
						},
					}),
					db.query.evidenceArtifacts.findMany({
						where: eq(evidenceArtifacts.evidenceId, evidence.id),
						columns: {
							id: true,
							kind: true,
							s3Key: true,
							mimeType: true,
							bytes: true,
							checksum: true,
							uploadStatus: true,
							createdAt: true,
							updatedAt: true,
						},
						orderBy: desc(evidenceArtifacts.createdAt),
					}),
				]);

				if (!organization) {
					set.status = 404;
					return createApiError(
						requestId,
						"ORGANIZATION_NOT_FOUND",
						"Evidence organization not found",
						404,
					);
				}

				const includeReadUrls = query.includeReadUrls !== false;
				const debugArtifacts = await Promise.all(
					artifacts.map(async (artifact) => {
						const role = classifyArtifactRole(artifact);
						if (!includeReadUrls) {
							return {
								...artifact,
								s3Key: undefined,
								role,
								readUrl: null,
								readUrlUnavailableReason: "read_urls_disabled",
							};
						}
						if (artifact.uploadStatus !== "uploaded") {
							return {
								...artifact,
								s3Key: undefined,
								role,
								readUrl: null,
								readUrlUnavailableReason: "artifact_not_uploaded",
							};
						}
						if (artifactStorage.mode !== "s3") {
							return {
								...artifact,
								s3Key: undefined,
								role,
								readUrl: null,
								readUrlUnavailableReason: "s3_storage_not_configured",
							};
						}

						const signed = await artifactStorage.createReadUrl({
							key: artifact.s3Key,
							responseContentType: artifact.mimeType,
						});
						return {
							...artifact,
							s3Key: undefined,
							role,
							readUrl: {
								url: signed.url,
								expiresAt: signed.expiresAt,
								renewAfterMs: Math.max(30_000, signed.ttlSeconds * 1000 * 0.7),
							},
							readUrlUnavailableReason: null,
						};
					}),
				);

				const recommended =
					debugArtifacts.find(
						(artifact) => artifact.role === "session_archive",
					) ??
					debugArtifacts.find((artifact) => artifact.role === "recording") ??
					null;
				const notes = [
					"Use the session_archive artifact first; it contains the structured session timeline.",
					"Use recording only when visual playback is needed to confirm behavior.",
				];
				if (!desktopSession) {
					notes.push(
						"No desktop recording session row is linked to this evidence.",
					);
				}
				if (!includeReadUrls) {
					notes.push(
						"Read URLs were disabled by query; call again without includeReadUrls=false to fetch artifacts.",
					);
				}

				return {
					access: {
						tokenId: aiToken.id,
						tokenLabel: aiToken.label,
						userId: aiToken.userId,
						scopes: aiToken.scopes,
					},
					organization,
					evidence: {
						...evidence,
						teamId: undefined,
						status: deriveEvidenceStatus(artifacts),
					},
					desktopSession: desktopSession ?? null,
					artifacts: debugArtifacts,
					debug: {
						llmsUrl: `${resolveExternalOrigin(request, runtime.apiOrigin)}/llms.txt`,
						recommendedArtifactId: recommended?.id ?? null,
						recommendedArtifactRole:
							recommended?.role === "session_archive" ||
							recommended?.role === "recording"
								? recommended.role
								: null,
						notes,
					},
				};
			},
			{
				params: evidenceDebugParamsSchema,
				query: evidenceDebugQuerySchema,
				detail: {
					tags: ["ai"],
					summary:
						"Returns AI-oriented evidence, session, and artifact debug context",
				},
				response: {
					200: aiEvidenceDebugResponseSchema,
					401: apiErrorSchema,
					403: apiErrorSchema,
					404: apiErrorSchema,
					500: apiErrorSchema,
					503: apiErrorSchema,
				},
			},
		);
