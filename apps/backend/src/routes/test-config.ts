import {
	agentNotesSchema,
	modelCostReportSchema,
	modelPriceSchema,
	modelSettingsSchema,
	testCredentialSchema,
	testEnvironmentSchema,
	testMacroSchema,
	testRunSettingsSchema,
	testTagSchema,
	updateModelSettingsRequestSchema,
	upsertTestCredentialRequestSchema,
	upsertTestEnvironmentRequestSchema,
	upsertTestMacroRequestSchema,
	upsertTestTagRequestSchema,
} from "@jittle-lamp/shared";
import { and, asc, eq, isNull } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod/v4";

import {
	organizationAgentNotes,
	organizationTestTags,
	testCredentials,
	testEnvironments,
	testMacros,
} from "../db/schema";
import {
	conflict,
	handleTestRoute,
	normalizeQuery,
	notFound,
	parseInput,
	requireAnyTestPermission,
	requireDb,
	requireTestPermission,
	resolveTestActor,
	respond,
} from "../http/test-http";
import type { ClerkAuthPlugin } from "../plugins/clerk-auth";
import {
	getRequestIpAddress,
	recordOrganizationActivity,
} from "../services/organization-activity";
import { createTestSecrets } from "../services/test-config";
import { releaseBudgetBlockedRuns } from "../services/test-run-budget";
import { getRunSettings } from "../services/test-runs";
import {
	buildCostReport,
	environmentResponse,
	getCredentialRow,
	getEnvironmentRow,
	getMacroRow,
	getModelSettings,
	listCredentials,
	listEnvironments,
	renderEnvironmentFile,
	resolvePriceTable,
	saveCredential,
	saveEnvironment,
	saveMacro,
	saveModelSettings,
	saveOrganizationModelPrices,
	saveRunSettings,
	tagCountsForOrg,
	toCredential,
	toMacro,
	toTag,
} from "../services/test-settings";

const idParams = z.object({ id: z.string().min(1) });

// Organisation agent notes, prepended to every run's agent instructions (phase 2 unit 2.4).
export const AGENT_NOTES_MAX_BYTES = 16_384;

const isUniqueViolation = (error: unknown) =>
	/UNIQUE constraint failed/i.test(
		String((error as { cause?: unknown })?.cause ?? error),
	);

const toModelSettingsResponse = (
	settings: Awaited<ReturnType<typeof getModelSettings>>,
) =>
	respond(modelSettingsSchema, {
		actModel: settings.actModel,
		judgeModel: settings.judgeModel,
		provider: settings.provider,
		keyConfigured: settings.keyConfigured,
		keyLast4: settings.keyLast4,
	});

export const createTestConfigRoutes = (auth: ClerkAuthPlugin) =>
	new Elysia({ name: "test-config-routes" })
		.use(auth)
		// --- Environments ---------------------------------------------------------------
		.get("/test-environments", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireAnyTestPermission(
					db,
					who,
					"test_config.use",
					"test_config.manage",
					"test_case.view",
				);
				return {
					items: (await listEnvironments(db, who.orgId)).map((item) =>
						respond(testEnvironmentSchema, item),
					),
				};
			}),
		)
		.post("/test-environments", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const body = parseInput(upsertTestEnvironmentRequestSchema, ctx.body);
				const row = await saveEnvironment(db, {
					orgId: who.orgId,
					userId: who.userId,
					request: body,
				});
				ctx.set.status = 201;
				return respond(
					testEnvironmentSchema,
					await environmentResponse(db, row),
				);
			}),
		)
		.get("/test-environments/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireAnyTestPermission(
					db,
					who,
					"test_config.use",
					"test_config.manage",
					"test_case.view",
				);
				const { id } = parseInput(idParams, ctx.params);
				return respond(
					testEnvironmentSchema,
					await environmentResponse(
						db,
						await getEnvironmentRow(db, who.orgId, id),
					),
				);
			}),
		)
		.patch("/test-environments/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(idParams, ctx.params);
				const existing = await getEnvironmentRow(db, who.orgId, id);
				const body = parseInput(upsertTestEnvironmentRequestSchema, {
					name: existing.name,
					baseUrl: existing.baseUrl,
					runnerPool: existing.runnerPool,
					variables: JSON.parse(existing.variablesJson) as unknown,
					...(ctx.body as Record<string, unknown> | null),
				});
				const row = await saveEnvironment(db, {
					orgId: who.orgId,
					userId: who.userId,
					id: existing.id,
					request: body,
				});
				return respond(
					testEnvironmentSchema,
					await environmentResponse(db, row),
				);
			}),
		)
		.delete("/test-environments/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(idParams, ctx.params);
				const existing = await getEnvironmentRow(db, who.orgId, id);
				await db
					.update(testEnvironments)
					.set({ deletedAt: Date.now(), deletedBy: who.userId })
					.where(eq(testEnvironments.id, existing.id));
				return { id: existing.id, deleted: true };
			}),
		)
		// `jl-e2e env pull`; secrets only with test_config.manage, and every decrypt is logged.
		.get("/test-environments/:id/env-file", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				const query = parseInput(
					z.object({ withSecrets: z.boolean().default(false) }),
					normalizeQuery(ctx.request.url, new Set()),
				);
				if (query.withSecrets) {
					await requireTestPermission(db, who, "test_config.manage");
				} else {
					await requireAnyTestPermission(
						db,
						who,
						"test_config.use",
						"test_config.manage",
					);
				}
				const { id } = parseInput(idParams, ctx.params);
				const environment = await getEnvironmentRow(db, who.orgId, id);
				const content = await renderEnvironmentFile(
					db,
					createTestSecrets({ db, keyProvider: ctx.keyProvider }),
					{
						environment,
						withSecrets: query.withSecrets,
						actorUserId: who.userId,
						ipAddress: getRequestIpAddress(ctx.request),
					},
				);
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: "test_config.env_file_pulled",
					entity: { type: "test_environment", id: environment.id },
					message: `Pulled the env file of ${environment.name}${query.withSecrets ? " with secrets" : ""}`,
					metadata: { withSecrets: query.withSecrets },
					ipAddress: getRequestIpAddress(ctx.request),
				});
				return { content };
			}),
		)
		// --- Credentials (secret fields are write-only) ----------------------------------
		.get("/test-credentials", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireAnyTestPermission(
					db,
					who,
					"test_config.use",
					"test_config.manage",
				);
				return {
					items: (await listCredentials(db, who.orgId)).map((item) =>
						respond(testCredentialSchema, item),
					),
				};
			}),
		)
		.post("/test-credentials", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const body = parseInput(upsertTestCredentialRequestSchema, ctx.body);
				const row = await saveCredential(
					db,
					createTestSecrets({ db, keyProvider: ctx.keyProvider }),
					{ orgId: who.orgId, userId: who.userId, request: body },
				);
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: "test_config.credential_created",
					entity: { type: "test_credential", id: row.id },
					message: `Created credential profile ${row.profile}`,
				});
				ctx.set.status = 201;
				return respond(testCredentialSchema, toCredential(row));
			}),
		)
		.post("/test-credentials/rotate-key", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				return createTestSecrets({
					db,
					keyProvider: ctx.keyProvider,
				}).rotateDataKey(who.orgId, who.userId);
			}),
		)
		.patch("/test-credentials/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(idParams, ctx.params);
				const existing = await getCredentialRow(db, who.orgId, id);
				const current = toCredential(existing);
				const body = parseInput(upsertTestCredentialRequestSchema, {
					profile: current.profile,
					kind: current.kind,
					environmentId: current.environmentId,
					fields: current.fields,
					...(ctx.body as Record<string, unknown> | null),
				});
				const row = await saveCredential(
					db,
					createTestSecrets({ db, keyProvider: ctx.keyProvider }),
					{
						orgId: who.orgId,
						userId: who.userId,
						id: existing.id,
						request: body,
					},
				);
				return respond(testCredentialSchema, toCredential(row));
			}),
		)
		// Rotation replaces every secret field with the values given.
		.post("/test-credentials/:id/rotate", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(idParams, ctx.params);
				const existing = await getCredentialRow(db, who.orgId, id);
				const current = toCredential(existing);
				const body = parseInput(
					z.object({
						secretFields: z
							.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.string().min(1))
							.refine((value) => Object.keys(value).length > 0, {
								message: "at least one secret field",
							}),
					}),
					ctx.body,
				);
				const row = await saveCredential(
					db,
					createTestSecrets({ db, keyProvider: ctx.keyProvider }),
					{
						orgId: who.orgId,
						userId: who.userId,
						id: existing.id,
						replaceSecrets: true,
						request: {
							profile: current.profile,
							kind: current.kind,
							environmentId: current.environmentId,
							fields: current.fields,
							secretFields: body.secretFields,
						},
					},
				);
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: "test_config.credential_rotated",
					entity: { type: "test_credential", id: row.id },
					message: `Rotated credential profile ${row.profile}`,
				});
				return respond(testCredentialSchema, toCredential(row));
			}),
		)
		.delete("/test-credentials/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(idParams, ctx.params);
				const existing = await getCredentialRow(db, who.orgId, id);
				await db
					.update(testCredentials)
					.set({
						deletedAt: Date.now(),
						deletedBy: who.userId,
						secretFieldsEnc: null,
						secretFieldNamesJson: "[]",
					})
					.where(eq(testCredentials.id, existing.id));
				return { id: existing.id, deleted: true };
			}),
		)
		// --- Macros ------------------------------------------------------------------------
		.get("/test-macros", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireAnyTestPermission(
					db,
					who,
					"test_case.view",
					"test_config.use",
				);
				const rows = await db.query.testMacros.findMany({
					where: and(
						eq(testMacros.orgId, who.orgId),
						isNull(testMacros.deletedAt),
					),
					orderBy: asc(testMacros.name),
				});
				return {
					items: rows.map((row) => respond(testMacroSchema, toMacro(row))),
				};
			}),
		)
		.post("/test-macros", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const body = parseInput(upsertTestMacroRequestSchema, ctx.body);
				// An agent's macro is a proposal: it stays draft until a person approves it, even when
				// the request asks for active (design.md §13).
				const row = await saveMacro(db, {
					orgId: who.orgId,
					userId: who.userId,
					request: who.kind === "ai" ? { ...body, status: "draft" } : body,
					defaultStatus: who.kind === "ai" ? "draft" : "active",
				});
				ctx.set.status = 201;
				return respond(testMacroSchema, toMacro(row));
			}),
		)
		.patch("/test-macros/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(idParams, ctx.params);
				const existing = toMacro(await getMacroRow(db, who.orgId, id));
				const body = parseInput(upsertTestMacroRequestSchema, {
					name: existing.name,
					params: existing.params,
					transcript: existing.transcript,
					...(ctx.body as Record<string, unknown> | null),
				});
				const row = await saveMacro(db, {
					orgId: who.orgId,
					userId: who.userId,
					id,
					request: body,
					defaultStatus: "active",
				});
				return respond(testMacroSchema, toMacro(row));
			}),
		)
		.delete("/test-macros/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(idParams, ctx.params);
				const existing = await getMacroRow(db, who.orgId, id);
				await db
					.update(testMacros)
					.set({ deletedAt: Date.now() })
					.where(eq(testMacros.id, existing.id));
				return { id: existing.id, deleted: true };
			}),
		)
		// --- Tags --------------------------------------------------------------------------
		.get("/test-tags", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_case.view");
				const rows = await db.query.organizationTestTags.findMany({
					where: eq(organizationTestTags.orgId, who.orgId),
					orderBy: [
						asc(organizationTestTags.namespace),
						asc(organizationTestTags.name),
					],
				});
				const counts = await tagCountsForOrg(db, who.orgId);
				return {
					items: rows.map((row) => respond(testTagSchema, toTag(row, counts))),
				};
			}),
		)
		.post("/test-tags", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const body = parseInput(upsertTestTagRequestSchema, ctx.body);
				try {
					const [row] = await db
						.insert(organizationTestTags)
						.values({
							orgId: who.orgId,
							namespace: body.namespace,
							name: body.name,
							color: body.color,
							description: body.description ?? null,
						})
						.returning();
					if (!row) throw new Error("Failed to create tag");
					ctx.set.status = 201;
					return respond(
						testTagSchema,
						toTag(row, await tagCountsForOrg(db, who.orgId)),
					);
				} catch (error) {
					if (isUniqueViolation(error)) {
						throw conflict("TEST_TAG_EXISTS", "This tag already exists");
					}
					throw error;
				}
			}),
		)
		.patch("/test-tags/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(idParams, ctx.params);
				const existing = await db.query.organizationTestTags.findFirst({
					where: and(
						eq(organizationTestTags.id, id),
						eq(organizationTestTags.orgId, who.orgId),
					),
				});
				if (!existing) throw notFound("TEST_TAG_NOT_FOUND", "Tag not found");
				const body = parseInput(upsertTestTagRequestSchema, {
					namespace: existing.namespace,
					name: existing.name,
					color: existing.color,
					description: existing.description,
					...(ctx.body as Record<string, unknown> | null),
				});
				const [row] = await db
					.update(organizationTestTags)
					.set({
						namespace: body.namespace,
						name: body.name,
						color: body.color,
						description: body.description ?? null,
						updatedAt: Date.now(),
					})
					.where(eq(organizationTestTags.id, existing.id))
					.returning();
				return respond(
					testTagSchema,
					toTag(row ?? existing, await tagCountsForOrg(db, who.orgId)),
				);
			}),
		)
		.delete("/test-tags/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const { id } = parseInput(idParams, ctx.params);
				const removed = await db
					.delete(organizationTestTags)
					.where(
						and(
							eq(organizationTestTags.id, id),
							eq(organizationTestTags.orgId, who.orgId),
						),
					)
					.returning({ id: organizationTestTags.id });
				if (removed.length === 0) {
					throw notFound("TEST_TAG_NOT_FOUND", "Tag not found");
				}
				return { id, deleted: true };
			}),
		)
		// --- Run settings, model settings, cost report, agent notes -----------------------
		.get("/test-run-settings", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireAnyTestPermission(
					db,
					who,
					"test_config.use",
					"test_config.manage",
				);
				return respond(
					testRunSettingsSchema,
					await getRunSettings(db, who.orgId),
				);
			}),
		)
		.put("/test-run-settings", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const body = parseInput(testRunSettingsSchema, ctx.body);
				await saveRunSettings(db, who.orgId, who.userId, body);
				// A raised or removed daily budget frees the runs waiting on it at once.
				await releaseBudgetBlockedRuns(db, { orgId: who.orgId });
				return respond(
					testRunSettingsSchema,
					await getRunSettings(db, who.orgId),
				);
			}),
		)
		.get("/test-model-settings", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireAnyTestPermission(
					db,
					who,
					"test_config.use",
					"test_config.manage",
				);
				return toModelSettingsResponse(await getModelSettings(db, who.orgId));
			}),
		)
		.put("/test-model-settings", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const body = parseInput(updateModelSettingsRequestSchema, ctx.body);
				await saveModelSettings(
					db,
					createTestSecrets({ db, keyProvider: ctx.keyProvider }),
					{ orgId: who.orgId, userId: who.userId, request: body },
				);
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: "test_config.model_settings_updated",
					entity: { type: "organization_model_settings", id: who.orgId },
					message: `Set the test models to ${body.actModel} and ${body.judgeModel}`,
					metadata: {
						keyChanged: body.apiKey !== undefined,
					},
				});
				return toModelSettingsResponse(await getModelSettings(db, who.orgId));
			}),
		)
		.get("/test-model-costs", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireAnyTestPermission(
					db,
					who,
					"test_config.manage",
					"test_run.view",
				);
				const now = Date.now();
				const query = parseInput(
					z.object({
						from: z
							.number()
							.int()
							.nonnegative()
							.default(now - 30 * 86_400_000),
						to: z.number().int().nonnegative().default(now),
					}),
					normalizeQuery(ctx.request.url, new Set()),
				);
				return respond(
					modelCostReportSchema,
					await buildCostReport(db, who.orgId, query),
				);
			}),
		)
		// Price table used for run cost: global defaults with organisation overrides.
		.get("/model-prices", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireAnyTestPermission(
					db,
					who,
					"test_config.manage",
					"test_config.use",
				);
				const table = await resolvePriceTable(db, who.orgId);
				return z
					.array(modelPriceSchema)
					.parse(
						[...table.prices].sort((a, b) =>
							a.modelId.localeCompare(b.modelId),
						),
					);
			}),
		)
		.put("/model-prices", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const prices = parseInput(z.array(modelPriceSchema).max(500), ctx.body);
				await saveOrganizationModelPrices(db, who.orgId, prices);
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: "test_config.model_prices_updated",
					entity: { type: "test_model_prices", id: who.orgId },
					message: `Set ${prices.length} model price override(s)`,
				});
				const table = await resolvePriceTable(db, who.orgId);
				return z
					.array(modelPriceSchema)
					.parse(
						[...table.prices].sort((a, b) =>
							a.modelId.localeCompare(b.modelId),
						),
					);
			}),
		)
		.get("/test-agent-notes", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_case.view");
				const row = await db.query.organizationAgentNotes.findFirst({
					where: eq(organizationAgentNotes.orgId, who.orgId),
				});
				return respond(agentNotesSchema, {
					notes: row?.notes ?? "",
					updatedBy: row?.updatedBy ?? null,
					updatedAt: row?.updatedAt ?? null,
				});
			}),
		)
		.put("/test-agent-notes", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await resolveTestActor(ctx);
				await requireTestPermission(db, who, "test_config.manage");
				const body = parseInput(
					z.object({
						notes: z
							.string()
							.refine(
								(value) =>
									new TextEncoder().encode(value).byteLength <=
									AGENT_NOTES_MAX_BYTES,
								{ message: "Agent notes must be 16 KB or smaller" },
							),
					}),
					ctx.body,
				);
				const previous = await db.query.organizationAgentNotes.findFirst({
					where: eq(organizationAgentNotes.orgId, who.orgId),
					columns: { notes: true },
				});
				const now = Date.now();
				await db
					.insert(organizationAgentNotes)
					.values({
						orgId: who.orgId,
						notes: body.notes,
						updatedBy: who.userId,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: organizationAgentNotes.orgId,
						set: { notes: body.notes, updatedBy: who.userId, updatedAt: now },
					});
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: "test_config.agent_notes_updated",
					entity: { type: "organization_agent_notes", id: who.orgId },
					message: "Updated the agent notes",
					metadata: {
						previousLength: previous?.notes.length ?? 0,
						length: body.notes.length,
					},
					ipAddress: getRequestIpAddress(ctx.request),
				});
				return respond(agentNotesSchema, {
					notes: body.notes,
					updatedBy: who.userId,
					updatedAt: now,
				});
			}),
		);
