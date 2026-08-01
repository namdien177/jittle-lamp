import {
	MIGRATION_PROTOCOL_VERSION,
	migrationCommitSchema,
	migrationHandshakeRequestSchema,
	migrationManifestPageSchema,
	migrationRecordPageSchema,
	openMigrationRunSchema,
} from "@jittle-lamp/shared";
import { and, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";

import { organizationMigrationRuns } from "../db/schema";
import { createApiError, createDbUnavailableError } from "../http/api-error";
import type { ClerkAuthPlugin } from "../plugins/clerk-auth";
import type { CorePlugin } from "../plugins/core";
import { ensureOrganizationOwner } from "../services/organization-management";
import {
	OrganizationMigrationError,
	type OrganizationMigrationService,
} from "../services/organization-migration";

const migrationError = (
	error: unknown,
	requestId: string,
	set: { status?: number | string },
) => {
	if (error instanceof OrganizationMigrationError) {
		set.status = error.status;
		return createApiError(requestId, error.code, error.message, error.status);
	}
	throw error;
};

const localActor = (
	localUserId: string | null,
	requestId: string,
	set: { status?: number | string },
): string | ReturnType<typeof createApiError> => {
	if (localUserId) return localUserId;
	set.status = 403;
	return createApiError(
		requestId,
		"MIGRATION_ACTOR_UNAVAILABLE",
		"Local user is unavailable",
		403,
	);
};

const peerToken = (request: Request): string => {
	const authorization = request.headers.get("authorization") ?? "";
	if (!authorization.startsWith("Migration ")) {
		throw new OrganizationMigrationError(
			"MIGRATION_PEER_UNAUTHORIZED",
			"Migration link authentication is required",
			401,
		);
	}
	return authorization.slice("Migration ".length).trim();
};

const runBelongsToOrganization = async (
	db: NonNullable<Parameters<typeof ensureOrganizationOwner>[0]>,
	runId: string,
	organizationId: string,
): Promise<boolean> =>
	Boolean(
		await db.query.organizationMigrationRuns.findFirst({
			where: and(
				eq(organizationMigrationRuns.id, runId),
				eq(organizationMigrationRuns.organizationId, organizationId),
			),
			columns: { id: true },
		}),
	);

export const createMigrationDiscoveryRoutes = (
	core: CorePlugin,
	migration: OrganizationMigrationService | null,
) =>
	new Elysia({ name: "migration-peer-discovery-routes" })
		.use(core)
		.get(
			"/.well-known/jittle-lamp-migration",
			async ({ runtime, requestId, set }) => {
				if (!migration || !runtime.apiOrigin || !runtime.webAppOrigin) {
					set.status = 503;
					return createApiError(
						requestId,
						"MIGRATION_NOT_CONFIGURED",
						"Organization migration is not configured",
						503,
					);
				}
				return {
					product: "jittle-lamp" as const,
					instanceId: await migration.getInstanceId(),
					applicationVersion: runtime.version,
					protocolVersion: MIGRATION_PROTOCOL_VERSION,
					features: [
						"resumable-import",
						"delta-sync",
						"two-phase-finalization",
						"checksum-verification",
					],
					apiOrigin: runtime.apiOrigin,
					webOrigin: runtime.webAppOrigin,
					limits: {
						maxRecordsPerPage: 100,
						maxArtifactBytes: 100 * 1024 * 1024,
					},
				};
			},
		)
		.post(
			"/migrations/v1/handshakes",
			async ({ body, requestId, set }) => {
				if (!migration) {
					set.status = 503;
					return createApiError(
						requestId,
						"MIGRATION_NOT_CONFIGURED",
						"Organization migration is not configured",
						503,
					);
				}
				try {
					return await migration.acceptHandshake(
						migrationHandshakeRequestSchema.parse(body),
					);
				} catch (error) {
					return migrationError(error, requestId, set);
				}
			},
			{ body: t.Any() },
		)
		.post(
			"/migrations/v1/imports/:linkId/runs",
			async ({ body, params, request, requestId, set }) => {
				if (!migration) return createDbUnavailableError(requestId);
				try {
					return await migration.openInboundRun(
						params.linkId,
						peerToken(request),
						openMigrationRunSchema.parse(body),
					);
				} catch (error) {
					return migrationError(error, requestId, set);
				}
			},
			{ body: t.Any() },
		)
		.put(
			"/migrations/v1/imports/:linkId/runs/:runId/manifest/:page",
			async ({ body, params, request, requestId, set }) => {
				if (!migration) return createDbUnavailableError(requestId);
				try {
					const parsed = migrationManifestPageSchema.parse(body);
					await migration.putInboundManifestPage(
						params.linkId,
						peerToken(request),
						params.runId,
						Number(params.page),
						parsed,
					);
					return { ok: true };
				} catch (error) {
					return migrationError(error, requestId, set);
				}
			},
			{ body: t.Any() },
		)
		.put(
			"/migrations/v1/imports/:linkId/runs/:runId/records/:page",
			async ({ body, params, request, requestId, set }) => {
				if (!migration) return createDbUnavailableError(requestId);
				try {
					const parsed = migrationRecordPageSchema.parse(body);
					await migration.putInboundRecordPage(
						params.linkId,
						peerToken(request),
						params.runId,
						Number(params.page),
						parsed,
					);
					return { ok: true };
				} catch (error) {
					return migrationError(error, requestId, set);
				}
			},
			{ body: t.Any() },
		)
		.put(
			"/migrations/v1/imports/:linkId/runs/:runId/artifacts/:artifactId",
			async ({ params, request, requestId, set }) => {
				if (!migration) return createDbUnavailableError(requestId);
				try {
					const contentHash = request.headers.get("x-content-sha256") ?? "";
					const size = Number(request.headers.get("content-length"));
					const contentType =
						request.headers.get("content-type") ?? "application/octet-stream";
					await migration.putInboundArtifact(
						params.linkId,
						peerToken(request),
						params.runId,
						params.artifactId,
						{
							body: new Uint8Array(await request.arrayBuffer()),
							contentHash,
							contentType,
							size,
						},
					);
					return { ok: true };
				} catch (error) {
					return migrationError(error, requestId, set);
				}
			},
		)
		.post(
			"/migrations/v1/imports/:linkId/runs/:runId/commit",
			async ({ body, params, request, requestId, set }) => {
				if (!migration) return createDbUnavailableError(requestId);
				try {
					return await migration.commitInboundRun(
						params.linkId,
						peerToken(request),
						params.runId,
						migrationCommitSchema.parse(body),
					);
				} catch (error) {
					return migrationError(error, requestId, set);
				}
			},
			{ body: t.Any() },
		)
		.get(
			"/migrations/v1/imports/:linkId/runs/:runId",
			async ({ params, request, requestId, set }) => {
				if (!migration) return createDbUnavailableError(requestId);
				try {
					return await migration.getInboundRun(
						params.linkId,
						peerToken(request),
						params.runId,
					);
				} catch (error) {
					return migrationError(error, requestId, set);
				}
			},
		)
		.post(
			"/migrations/v1/imports/:linkId/finalize-ack",
			async ({ body, params, request, requestId, set }) => {
				if (!migration) return createDbUnavailableError(requestId);
				try {
					const receipt = (body as { receipt?: unknown }).receipt;
					if (typeof receipt !== "string")
						throw new Error("receipt is required");
					await migration.finalizeInbound(
						params.linkId,
						peerToken(request),
						receipt,
					);
					return { ok: true };
				} catch (error) {
					return migrationError(error, requestId, set);
				}
			},
			{ body: t.Any() },
		)
		.post(
			"/migrations/v1/imports/:linkId/diverged",
			async ({ params, request, requestId, set }) => {
				if (!migration) return createDbUnavailableError(requestId);
				try {
					await migration.markInboundDiverged(
						params.linkId,
						peerToken(request),
					);
					return { ok: true };
				} catch (error) {
					return migrationError(error, requestId, set);
				}
			},
		);

export const createMigrationManagementRoutes = (
	auth: ClerkAuthPlugin,
	migration: OrganizationMigrationService | null,
) =>
	new Elysia({ name: "migration-management-routes" })
		.use(auth)
		.guard({ auth: true }, (app) =>
			app
				.post(
					"/migrations/receiver-codes",
					async ({ authContext, requestId, set }) => {
						if (!migration) {
							set.status = 503;
							return createDbUnavailableError(
								requestId,
								"Organization migration is not configured",
							);
						}
						const actor = localActor(authContext.localUserId, requestId, set);
						if (typeof actor !== "string") return actor;
						try {
							return {
								receiverCode: await migration.createReceiverCode(actor),
							};
						} catch (error) {
							return migrationError(error, requestId, set);
						}
					},
				)
				.delete(
					"/migrations/receiver-codes/:id",
					async ({ authContext, params, requestId, set }) => {
						if (!migration) return createDbUnavailableError(requestId);
						const actor = localActor(authContext.localUserId, requestId, set);
						if (typeof actor !== "string") return actor;
						try {
							await migration.revokeReceiverCode(actor, params.id);
							return { ok: true };
						} catch (error) {
							return migrationError(error, requestId, set);
						}
					},
				)
				.get("/migrations/inbound", async ({ authContext, requestId, set }) => {
					if (!migration) return createDbUnavailableError(requestId);
					const actor = localActor(authContext.localUserId, requestId, set);
					if (typeof actor !== "string") return actor;
					return { migrations: await migration.listInbound(actor) };
				})
				.post(
					"/orgs/:orgId/migrations/preflight",
					async ({ authContext, body, params, requestId, set }) => {
						if (!migration) return createDbUnavailableError(requestId);
						const actor = localActor(authContext.localUserId, requestId, set);
						if (typeof actor !== "string") return actor;
						try {
							return {
								compatibility: await migration.checkCompatibility(
									actor,
									params.orgId,
									body.targetApiOrigin,
								),
							};
						} catch (error) {
							return migrationError(error, requestId, set);
						}
					},
					{
						body: t.Object({ targetApiOrigin: t.String({ format: "uri" }) }),
					},
				)
				.post(
					"/orgs/:orgId/migrations/pair",
					async ({ authContext, body, params, requestId, set }) => {
						if (!migration) return createDbUnavailableError(requestId);
						const actor = localActor(authContext.localUserId, requestId, set);
						if (typeof actor !== "string") return actor;
						try {
							return {
								link: await migration.pairOutbound({
									actorUserId: actor,
									organizationId: params.orgId,
									targetApiOrigin: body.targetApiOrigin,
									passphrase: body.passphrase,
								}),
							};
						} catch (error) {
							return migrationError(error, requestId, set);
						}
					},
					{
						body: t.Object({
							targetApiOrigin: t.String({ format: "uri" }),
							passphrase: t.String({ minLength: 50 }),
						}),
					},
				)
				.get(
					"/orgs/:orgId/migration",
					async ({ authContext, params, requestId, set }) => {
						if (!migration) return createDbUnavailableError(requestId);
						const actor = localActor(authContext.localUserId, requestId, set);
						if (typeof actor !== "string") return actor;
						try {
							return await migration.getStatus(actor, params.orgId);
						} catch (error) {
							return migrationError(error, requestId, set);
						}
					},
				)
				.post(
					"/orgs/:orgId/migration/runs",
					async ({ authContext, body, db, params, requestId, set }) => {
						if (!migration || !db) return createDbUnavailableError(requestId);
						const actor = localActor(authContext.localUserId, requestId, set);
						if (typeof actor !== "string") return actor;
						if (
							!(await ensureOrganizationOwner(db, {
								organizationId: params.orgId,
								localUserId: actor,
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"MIGRATION_ADMIN_REQUIRED",
								"Organization admin access is required",
								403,
							);
						}
						try {
							return { run: await migration.startRun(params.orgId, body.kind) };
						} catch (error) {
							return migrationError(error, requestId, set);
						}
					},
					{
						body: t.Object({
							kind: t.Union([
								t.Literal("full"),
								t.Literal("delta"),
								t.Literal("final"),
							]),
						}),
					},
				)
				.post(
					"/orgs/:orgId/migration/runs/:runId/pause",
					async ({ authContext, db, params, requestId, set }) => {
						if (!migration || !db) return createDbUnavailableError(requestId);
						const actor = localActor(authContext.localUserId, requestId, set);
						if (typeof actor !== "string") return actor;
						if (
							!(await ensureOrganizationOwner(db, {
								organizationId: params.orgId,
								localUserId: actor,
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"MIGRATION_ADMIN_REQUIRED",
								"Organization admin access is required",
								403,
							);
						}
						if (
							!(await runBelongsToOrganization(db, params.runId, params.orgId))
						) {
							set.status = 404;
							return createApiError(
								requestId,
								"MIGRATION_RUN_NOT_FOUND",
								"Migration run was not found for this organization",
								404,
							);
						}
						try {
							await migration.pauseRun(params.runId);
							return { ok: true };
						} catch (error) {
							return migrationError(error, requestId, set);
						}
					},
				)
				.post(
					"/orgs/:orgId/migration/runs/:runId/resume",
					async ({ authContext, db, params, requestId, set }) => {
						if (!migration || !db) return createDbUnavailableError(requestId);
						const actor = localActor(authContext.localUserId, requestId, set);
						if (typeof actor !== "string") return actor;
						if (
							!(await ensureOrganizationOwner(db, {
								organizationId: params.orgId,
								localUserId: actor,
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"MIGRATION_ADMIN_REQUIRED",
								"Organization admin access is required",
								403,
							);
						}
						if (
							!(await runBelongsToOrganization(db, params.runId, params.orgId))
						) {
							set.status = 404;
							return createApiError(
								requestId,
								"MIGRATION_RUN_NOT_FOUND",
								"Migration run was not found for this organization",
								404,
							);
						}
						try {
							await migration.resumeRun(params.runId);
							return { ok: true };
						} catch (error) {
							return migrationError(error, requestId, set);
						}
					},
				)
				.post(
					"/orgs/:orgId/migration/runs/:runId/retry",
					async ({ authContext, body, db, params, requestId, set }) => {
						if (!migration || !db) return createDbUnavailableError(requestId);
						const actor = localActor(authContext.localUserId, requestId, set);
						if (typeof actor !== "string") return actor;
						if (
							!(await ensureOrganizationOwner(db, {
								organizationId: params.orgId,
								localUserId: actor,
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"MIGRATION_ADMIN_REQUIRED",
								"Organization admin access is required",
								403,
							);
						}
						if (
							!(await runBelongsToOrganization(db, params.runId, params.orgId))
						) {
							set.status = 404;
							return createApiError(
								requestId,
								"MIGRATION_RUN_NOT_FOUND",
								"Migration run was not found for this organization",
								404,
							);
						}
						try {
							await migration.retryRun(params.runId, body.override ?? false);
							return { ok: true };
						} catch (error) {
							return migrationError(error, requestId, set);
						}
					},
					{ body: t.Object({ override: t.Optional(t.Boolean()) }) },
				)
				.post(
					"/orgs/:orgId/migration/finalize",
					async ({ authContext, db, params, requestId, set }) => {
						if (!migration || !db) return createDbUnavailableError(requestId);
						const actor = localActor(authContext.localUserId, requestId, set);
						if (typeof actor !== "string") return actor;
						if (
							!(await ensureOrganizationOwner(db, {
								organizationId: params.orgId,
								localUserId: actor,
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"MIGRATION_ADMIN_REQUIRED",
								"Organization admin access is required",
								403,
							);
						}
						try {
							return { run: await migration.startRun(params.orgId, "final") };
						} catch (error) {
							return migrationError(error, requestId, set);
						}
					},
				)
				.post(
					"/orgs/:orgId/migration/finalization/abort",
					async ({ authContext, db, params, requestId, set }) => {
						if (!migration || !db) return createDbUnavailableError(requestId);
						const actor = localActor(authContext.localUserId, requestId, set);
						if (typeof actor !== "string") return actor;
						if (
							!(await ensureOrganizationOwner(db, {
								organizationId: params.orgId,
								localUserId: actor,
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"MIGRATION_ADMIN_REQUIRED",
								"Organization admin access is required",
								403,
							);
						}
						try {
							await migration.abortFinalization(params.orgId);
							return { ok: true };
						} catch (error) {
							return migrationError(error, requestId, set);
						}
					},
				)
				.post(
					"/orgs/:orgId/migration/break",
					async ({ authContext, db, params, requestId, set }) => {
						if (!migration || !db) return createDbUnavailableError(requestId);
						const actor = localActor(authContext.localUserId, requestId, set);
						if (typeof actor !== "string") return actor;
						if (
							!(await ensureOrganizationOwner(db, {
								organizationId: params.orgId,
								localUserId: actor,
							}))
						) {
							set.status = 403;
							return createApiError(
								requestId,
								"MIGRATION_ADMIN_REQUIRED",
								"Organization admin access is required",
								403,
							);
						}
						try {
							await migration.breakFinalizedLink(params.orgId);
							return { ok: true };
						} catch (error) {
							return migrationError(error, requestId, set);
						}
					},
				),
		);
