import {
	bulkTestCaseRequestSchema,
	bulkTestCaseResponseSchema,
	createImportRequestSchema,
	createTestCaseRequestSchema,
	createTestRunRequestSchema,
	createTestRunResponseSchema,
	duplicateTestCaseRequestSchema,
	duplicateTestCaseResponseSchema,
	importBatchSchema,
	patchImportRequestSchema,
	serializeTestCase,
	similarTestCasesResponseSchema,
	stepScriptSchema,
	testCaseDetailSchema,
	testCaseListQuerySchema,
	testCaseListResponseSchema,
	testCaseVersionSchema,
	testRunListResponseSchema,
	testSuiteSchema,
	updateTestCaseRequestSchema,
	upsertTestSuiteRequestSchema,
} from "@jittle-lamp/shared";
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { Elysia } from "elysia";
import type { Logger } from "pino";
import { z } from "zod/v4";

import type { RuntimeConfig } from "../config/runtime";
import {
	testCases,
	testCaseVersions,
	testRuns,
	testStepScripts,
	testSuiteMembers,
	testSuites,
} from "../db/schema";
import {
	HttpError,
	handleTestRoute,
	normalizeQuery,
	notFound,
	parseInput,
	requireDb,
	requireTestPermission,
	resolveTestActor,
	respond,
	type TestActor,
} from "../http/test-http";
import type { ClerkAuthPlugin } from "../plugins/clerk-auth";
import { recordOrganizationActivity } from "../services/organization-activity";
import { testCasePolicy } from "../services/test-case-policy";
import {
	applyReplacements,
	caseSteps,
	computeRequiredConfig,
	createTestCase,
	exportCasesDocument,
	findSimilarCases,
	getTestCaseRow,
	inheritStepScripts,
	listTestCases,
	parseJsonColumn,
	parseSingleCase,
	resolveEnvironmentId,
	rewriteCaseMetadata,
	type TestCaseRow,
	testCaseFilterConditions,
	toCaseDetail,
	toStepScript,
	updateTestCase,
	withMetadataKey,
} from "../services/test-cases";
import { createTestSecrets, type KeyProvider } from "../services/test-config";
import {
	createImportBatch,
	defaultTextGenerator,
	getImportBatchRow,
	patchImportBatch,
	type TextGenerator,
	toImportBatch,
} from "../services/test-imports";
import {
	requestRuns,
	toCreateRunResponse,
	toRunSummary,
} from "../services/test-runs";
import type { BackendDb } from "../services/user-provisioning";

type Ctx = {
	db: BackendDb | null;
	request: Request;
	requestId: string;
	requestLogger: Logger;
	runtime: RuntimeConfig;
	keyProvider: KeyProvider;
	set: { status?: number | string; headers: Record<string, unknown> };
};

const actor = (ctx: Ctx, automation = false) =>
	resolveTestActor(ctx, { automation });

const caseIdParams = z.object({ id: z.string().min(1) });

export type TestCaseRouteOptions = {
	generateText?: TextGenerator;
	fetchImpl?: typeof fetch;
};

const listQuery = (url: string) =>
	parseInput(testCaseListQuerySchema, normalizeQuery(url));

const loadCases = async (
	db: BackendDb,
	orgId: string,
	ids: readonly string[],
): Promise<TestCaseRow[]> => {
	const rows = await db.query.testCases.findMany({
		where: and(
			eq(testCases.orgId, orgId),
			inArray(testCases.id, [...ids]),
			isNull(testCases.deletedAt),
		),
	});
	const byId = new Map(rows.map((row) => [row.id, row]));
	return ids.flatMap((id) => {
		const row = byId.get(id);
		return row ? [row] : [];
	});
};

const requester = (who: TestActor) => ({
	userId: who.userId,
	tokenId: who.tokenId,
	kind: who.kind,
});

// Suites: static members plus, for smart suites, every case matching the saved filter.
const suiteMembers = async (
	db: BackendDb,
	orgId: string,
	suite: typeof testSuites.$inferSelect,
): Promise<TestCaseRow[]> => {
	const members = await db.query.testSuiteMembers.findMany({
		where: eq(testSuiteMembers.suiteId, suite.id),
		orderBy: asc(testSuiteMembers.position),
	});
	const ids = members.map((member) => member.testCaseId);
	const filter = parseJsonColumn(
		suite.filterJson,
		testCaseListQuerySchema.partial().nullable(),
		null,
	);
	if (filter) {
		const rows = await db
			.select({ id: testCases.id })
			.from(testCases)
			.where(
				and(...testCaseFilterConditions(orgId, filter, { includeTags: true })),
			)
			.orderBy(asc(testCases.key))
			.limit(1000);
		for (const row of rows) if (!ids.includes(row.id)) ids.push(row.id);
	}
	return loadCases(db, orgId, ids);
};

const toSuite = async (
	db: BackendDb,
	suite: typeof testSuites.$inferSelect,
) => {
	const members = await db.query.testSuiteMembers.findMany({
		where: eq(testSuiteMembers.suiteId, suite.id),
		orderBy: asc(testSuiteMembers.position),
	});
	return respond(testSuiteSchema, {
		id: suite.id,
		name: suite.name,
		description: suite.description,
		filter: parseJsonColumn(
			suite.filterJson,
			testCaseListQuerySchema.partial().nullable(),
			null,
		),
		memberIds: members.map((member) => member.testCaseId),
		createdAt: suite.createdAt,
	});
};

const getSuite = async (db: BackendDb, orgId: string, id: string) => {
	const suite = await db.query.testSuites.findFirst({
		where: and(
			eq(testSuites.id, id),
			eq(testSuites.orgId, orgId),
			isNull(testSuites.deletedAt),
		),
	});
	if (!suite) throw notFound("TEST_SUITE_NOT_FOUND", "Test suite not found");
	return suite;
};

const setSuiteMembers = async (
	db: BackendDb,
	orgId: string,
	suiteId: string,
	memberIds: readonly string[],
) => {
	const rows = await loadCases(db, orgId, memberIds);
	if (rows.length !== new Set(memberIds).size) {
		throw notFound(
			"TEST_CASE_NOT_FOUND",
			"Some suite members are not test cases in this organisation",
		);
	}
	await db
		.delete(testSuiteMembers)
		.where(eq(testSuiteMembers.suiteId, suiteId));
	for (const [position, row] of rows.entries()) {
		await db
			.insert(testSuiteMembers)
			.values({ suiteId, testCaseId: row.id, position });
	}
};

export const createTestCaseRoutes = (
	auth: ClerkAuthPlugin,
	options: TestCaseRouteOptions = {},
) =>
	new Elysia({ name: "test-case-routes" })
		.use(auth)
		.get("/test-cases", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx, true);
				await requireTestPermission(db, who, "test_case.view");
				return respond(
					testCaseListResponseSchema,
					await listTestCases(db, who.orgId, listQuery(ctx.request.url)),
				);
			}),
		)
		.post("/test-cases", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx);
				await requireTestPermission(db, who, "test_case.create");
				const body = parseInput(createTestCaseRequestSchema, ctx.body);
				if (
					body.status === "active" &&
					(body.source === "ai" || body.source === "import") &&
					!(await testCasePolicy.canApproveTestCases(db, {
						organizationId: who.orgId,
						userId: who.userId,
					}))
				) {
					body.status = "review";
				}
				const row = await createTestCase(db, {
					orgId: who.orgId,
					userId: who.userId,
					transcript: body.transcript,
					status: body.status,
					environmentId: body.environmentId,
					source: body.source,
					sourceRef: body.sourceRef,
				});
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: "test_case.created",
					entity: { type: "test_case", id: row.id },
					message: `Created test case ${row.key}`,
					metadata: { key: row.key, source: row.source },
				});
				ctx.set.status = 201;
				return respond(testCaseDetailSchema, await toCaseDetail(db, row));
			}),
		)
		.get("/test-cases/export", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx, true);
				await requireTestPermission(db, who, "test_case.view");
				const query = normalizeQuery(ctx.request.url);
				const ids = z.array(z.string()).optional().parse(query.ids);
				let rows: TestCaseRow[];
				if (ids?.length) {
					rows = await loadCases(db, who.orgId, ids);
				} else {
					const list = parseInput(testCaseListQuerySchema, {
						...query,
						limit: 500,
					});
					rows = await db
						.select()
						.from(testCases)
						.where(
							and(
								...testCaseFilterConditions(who.orgId, list, {
									includeTags: true,
								}),
							),
						)
						.orderBy(asc(testCases.key))
						.limit(5000);
				}
				return { document: exportCasesDocument(rows), count: rows.length };
			}),
		)
		.get("/test-cases/similar", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx);
				await requireTestPermission(db, who, "test_case.view");
				const query = parseInput(
					z.object({
						title: z.string().max(500).optional(),
						transcript: z.string().max(200_000).optional(),
						excludeId: z.string().optional(),
						limit: z.number().int().min(1).max(50).optional(),
					}),
					normalizeQuery(ctx.request.url, new Set()),
				);
				return respond(similarTestCasesResponseSchema, {
					items: await findSimilarCases(db, who.orgId, {
						title: query.title,
						transcript: query.transcript,
						...(query.excludeId ? { excludeIds: [query.excludeId] } : {}),
						...(query.limit ? { limit: query.limit } : {}),
					}),
				});
			}),
		)
		.post("/test-cases/similar", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx);
				await requireTestPermission(db, who, "test_case.view");
				const body = parseInput(
					z.object({
						title: z.string().max(500).optional(),
						transcript: z.string().max(200_000).optional(),
						excludeIds: z.array(z.string()).optional(),
					}),
					ctx.body,
				);
				return respond(similarTestCasesResponseSchema, {
					items: await findSimilarCases(db, who.orgId, {
						title: body.title,
						transcript: body.transcript,
						...(body.excludeIds ? { excludeIds: body.excludeIds } : {}),
					}),
				});
			}),
		)
		.post("/test-cases/bulk", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx);
				const body = parseInput(bulkTestCaseRequestSchema, ctx.body);
				const permission =
					body.action === "run"
						? ("test_run.create" as const)
						: body.action === "export"
							? ("test_case.view" as const)
							: body.action === "approve" || body.action === "reject"
								? ("test_case.approve" as const)
								: ("test_case.update" as const);
				await requireTestPermission(db, who, permission);
				if (body.action === "run") {
					await requireTestPermission(db, who, "test_config.use");
				}
				const rows = await loadCases(db, who.orgId, body.ids);
				const found = new Set(rows.map((row) => row.id));
				const errors = body.ids
					.filter((id) => !found.has(id))
					.map((id) => ({ id, message: "Test case not found" }));
				const runs: Array<{
					testCaseId: string;
					runId: string;
					attached: boolean;
				}> = [];
				let updated = 0;
				let document: string | null = null;
				const now = Date.now();
				switch (body.action) {
					case "export":
						document = exportCasesDocument(rows);
						break;
					case "run": {
						const runnable = rows.filter(
							(row) => row.status === "active" || row.status === "draft",
						);
						for (const row of rows) {
							if (!runnable.includes(row))
								errors.push({ id: row.id, message: `Case is ${row.status}` });
						}
						if (runnable.length > 0) {
							const request = createTestRunRequestSchema.parse({});
							const result = await requestRuns(db, {
								orgId: who.orgId,
								requester: requester(who),
								cases: runnable.map((row) => ({ row, request })),
								batch: { kind: "suite" },
							});
							result.results.forEach((entry, index) => {
								const row = runnable[index];
								if (row) runs.push({ testCaseId: row.id, ...entry });
							});
						}
						break;
					}
					case "archive":
					case "approve":
					case "reject": {
						for (const row of rows) {
							if (
								(body.action === "approve" || body.action === "reject") &&
								row.status !== "review"
							) {
								errors.push({
									id: row.id,
									message: `Case is ${row.status}, not in review`,
								});
								continue;
							}
							await db
								.update(testCases)
								.set({
									status: body.action === "approve" ? "active" : "archived",
									statusReason:
										body.action === "approve" ? null : (body.reason ?? null),
									updatedBy: who.userId,
									updatedAt: now,
								})
								.where(eq(testCases.id, row.id));
							updated += 1;
						}
						break;
					}
					case "tag":
					case "untag":
					case "set-environment": {
						if (body.action !== "set-environment" && !body.tags?.length) {
							throw new HttpError(422, "VALIDATION", "tags: required");
						}
						let environmentName: string | null = null;
						let environmentId: string | null = null;
						if (body.action === "set-environment") {
							environmentId = await resolveEnvironmentId(db, who.orgId, {
								environmentId: body.environmentId ?? null,
							});
							environmentName = environmentId
								? ((
										await db.query.testEnvironments.findFirst({
											where: (table, { eq: equals }) =>
												equals(table.id, environmentId ?? ""),
											columns: { name: true },
										})
									)?.name ?? null)
								: null;
						}
						for (const row of rows) {
							try {
								await rewriteCaseMetadata(db, {
									row,
									userId: who.userId,
									changeNote:
										body.action === "set-environment"
											? "Environment changed"
											: body.action === "tag"
												? "Tags added"
												: "Tags removed",
									...(body.action === "set-environment"
										? { environmentId }
										: {}),
									edit: (testCase) => {
										if (body.action === "set-environment") {
											return withMetadataKey(testCase, "env", environmentName);
										}
										const tags = new Set(testCase.metadata.tags);
										for (const tag of body.tags ?? []) {
											if (body.action === "tag") tags.add(tag);
											else tags.delete(tag);
										}
										return withMetadataKey(testCase, "tags", [...tags]);
									},
								});
								updated += 1;
							} catch (error) {
								errors.push({
									id: row.id,
									message:
										error instanceof Error ? error.message : "Update failed",
								});
							}
						}
						break;
					}
				}
				return respond(bulkTestCaseResponseSchema, {
					updated,
					runs,
					document,
					errors,
				});
			}),
		)
		.post("/test-cases/import", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx, true);
				await requireTestPermission(db, who, "test_case.create");
				const body = parseInput(createImportRequestSchema, ctx.body);
				const batch = await createImportBatch(
					db,
					createTestSecrets({ db, keyProvider: ctx.keyProvider }),
					{
						orgId: who.orgId,
						userId: who.userId,
						request: body,
						generateText: options.generateText ?? defaultTextGenerator,
						...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
					},
				);
				ctx.set.status = 201;
				return respond(importBatchSchema, await toImportBatch(db, batch));
			}),
		)
		.get("/test-cases/import/:batchId", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx, true);
				await requireTestPermission(db, who, "test_case.view");
				const batch = await getImportBatchRow(
					db,
					who.orgId,
					String(ctx.params.batchId),
				);
				return respond(importBatchSchema, await toImportBatch(db, batch));
			}),
		)
		.patch("/test-cases/import/:batchId", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx, true);
				await requireTestPermission(db, who, "test_case.create");
				const body = parseInput(patchImportRequestSchema, ctx.body);
				const batch = await getImportBatchRow(
					db,
					who.orgId,
					String(ctx.params.batchId),
				);
				const result = await patchImportBatch(db, {
					orgId: who.orgId,
					userId: who.userId,
					batch,
					request: body,
				});
				return respond(
					importBatchSchema,
					await toImportBatch(db, result.batch),
				);
			}),
		)
		.get("/test-cases/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx, true);
				await requireTestPermission(db, who, "test_case.view");
				const { id } = parseInput(caseIdParams, ctx.params);
				const row = await getTestCaseRow(db, who.orgId, id);
				return respond(testCaseDetailSchema, await toCaseDetail(db, row));
			}),
		)
		.patch("/test-cases/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx, true);
				await requireTestPermission(db, who, "test_case.update");
				const { id } = parseInput(caseIdParams, ctx.params);
				const body = parseInput(updateTestCaseRequestSchema, ctx.body);
				const row = await getTestCaseRow(db, who.orgId, id);
				const updated = await updateTestCase(db, {
					row,
					userId: who.userId,
					request: body,
					canApprove: await testCasePolicy.canApproveTestCases(db, {
						organizationId: who.orgId,
						userId: who.userId,
					}),
				});
				return respond(testCaseDetailSchema, await toCaseDetail(db, updated));
			}),
		)
		.delete("/test-cases/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx);
				await requireTestPermission(db, who, "test_case.delete");
				const { id } = parseInput(caseIdParams, ctx.params);
				const row = await getTestCaseRow(db, who.orgId, id);
				await db
					.update(testCases)
					.set({
						deletedAt: Date.now(),
						deletedBy: who.userId,
						updatedAt: Date.now(),
					})
					.where(eq(testCases.id, row.id));
				await recordOrganizationActivity(db, {
					organizationId: who.orgId,
					actorUserId: who.userId,
					action: "test_case.deleted",
					entity: { type: "test_case", id: row.id },
					message: `Deleted test case ${row.key}`,
				});
				return { id: row.id, deleted: true };
			}),
		)
		.post("/test-cases/:id/approve", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx);
				await requireTestPermission(db, who, "test_case.approve");
				const { id } = parseInput(caseIdParams, ctx.params);
				const row = await getTestCaseRow(db, who.orgId, id);
				if (row.status !== "review") {
					throw new HttpError(
						409,
						"TEST_CASE_NOT_IN_REVIEW",
						`${row.key} is ${row.status}, not in review`,
					);
				}
				const [updated] = await db
					.update(testCases)
					.set({
						status: "active",
						statusReason: null,
						updatedBy: who.userId,
						updatedAt: Date.now(),
					})
					.where(eq(testCases.id, row.id))
					.returning();
				return respond(
					testCaseDetailSchema,
					await toCaseDetail(db, updated ?? row),
				);
			}),
		)
		.post("/test-cases/:id/reject", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx);
				await requireTestPermission(db, who, "test_case.approve");
				const { id } = parseInput(caseIdParams, ctx.params);
				const body = parseInput(
					z.object({ reason: z.string().max(500).optional() }),
					ctx.body,
				);
				const row = await getTestCaseRow(db, who.orgId, id);
				if (row.status !== "review") {
					throw new HttpError(
						409,
						"TEST_CASE_NOT_IN_REVIEW",
						`${row.key} is ${row.status}, not in review`,
					);
				}
				const [updated] = await db
					.update(testCases)
					.set({
						status: "archived",
						statusReason: body.reason ?? null,
						updatedBy: who.userId,
						updatedAt: Date.now(),
					})
					.where(eq(testCases.id, row.id))
					.returning();
				return respond(
					testCaseDetailSchema,
					await toCaseDetail(db, updated ?? row),
				);
			}),
		)
		.get("/test-cases/:id/versions", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx);
				await requireTestPermission(db, who, "test_case.view");
				const { id } = parseInput(caseIdParams, ctx.params);
				const row = await getTestCaseRow(db, who.orgId, id);
				const versions = await db.query.testCaseVersions.findMany({
					where: eq(testCaseVersions.testCaseId, row.id),
					orderBy: desc(testCaseVersions.version),
				});
				return {
					items: versions.map((version) =>
						respond(testCaseVersionSchema, {
							version: version.version,
							transcript: version.transcript,
							createdBy: version.createdBy,
							createdAt: version.createdAt,
							changeNote: version.changeNote,
						}),
					),
				};
			}),
		)
		.get("/test-cases/:id/required-config", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx);
				await requireTestPermission(db, who, "test_case.view");
				const { id } = parseInput(caseIdParams, ctx.params);
				const query = parseInput(
					z.object({ environmentId: z.string().optional() }),
					normalizeQuery(ctx.request.url, new Set()),
				);
				const row = await getTestCaseRow(db, who.orgId, id);
				const environmentId = query.environmentId
					? await resolveEnvironmentId(db, who.orgId, {
							environmentId: query.environmentId,
						})
					: row.environmentId;
				return computeRequiredConfig(db, row, environmentId);
			}),
		)
		.post("/test-cases/:id/duplicate", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx);
				await requireTestPermission(db, who, "test_case.create");
				const { id } = parseInput(caseIdParams, ctx.params);
				const body = parseInput(duplicateTestCaseRequestSchema, ctx.body);
				const source = await getTestCaseRow(db, who.orgId, id);
				const replaced = applyReplacements(
					source.transcript,
					body.replacements,
				);
				let parsed = parseSingleCase(replaced, caseSteps(source));
				parsed = withMetadataKey(parsed, "key", null);
				parsed = {
					...parsed,
					title:
						body.title ??
						(body.replacements.length > 0 && parsed.title !== source.title
							? parsed.title
							: `${parsed.title} (copy)`),
				};
				if (!body.copy.links) parsed = withMetadataKey(parsed, "links", []);
				if (!body.copy.tags) parsed = withMetadataKey(parsed, "tags", []);
				if (body.tags) parsed = withMetadataKey(parsed, "tags", body.tags);
				if (!body.copy.environment)
					parsed = withMetadataKey(parsed, "env", null);
				if (!body.copy.datasets) parsed = { ...parsed, dataset: null };
				const created = await createTestCase(db, {
					orgId: who.orgId,
					userId: who.userId,
					transcript: `${serializeTestCase(parsed)}\n`,
					status: "draft",
					environmentId: body.copy.environment ? source.environmentId : null,
					source: "duplicate",
					sourceRef: source.id,
					duplicatedFromId: body.mode === "variant" ? source.id : null,
					previousSteps: caseSteps(source),
					changeNote: `Duplicated from ${source.key}`,
				});
				const inheritedScripts = body.inheritScripts
					? await inheritStepScripts(db, { source, target: created })
					: 0;
				ctx.set.status = 201;
				return respond(duplicateTestCaseResponseSchema, {
					testCase: await toCaseDetail(db, created),
					inheritedScripts,
				});
			}),
		)
		.get("/test-cases/:id/scripts", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx);
				await requireTestPermission(db, who, "test_case.view");
				const { id } = parseInput(caseIdParams, ctx.params);
				const query = normalizeQuery(ctx.request.url, new Set());
				const row = await getTestCaseRow(db, who.orgId, id);
				const scripts = await db.query.testStepScripts.findMany({
					where: and(
						eq(testStepScripts.testCaseId, row.id),
						query.all === true
							? undefined
							: eq(testStepScripts.status, "active"),
					),
					orderBy: [asc(testStepScripts.stepId), desc(testStepScripts.version)],
				});
				return {
					items: scripts.map((script) =>
						respond(stepScriptSchema, toStepScript(script)),
					),
				};
			}),
		)
		.delete("/test-cases/:id/scripts", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx);
				await requireTestPermission(db, who, "test_case.update");
				const { id } = parseInput(caseIdParams, ctx.params);
				const row = await getTestCaseRow(db, who.orgId, id);
				const cleared = await db
					.update(testStepScripts)
					.set({
						status: "invalid",
						staleReason: "cleared by user",
						updatedAt: Date.now(),
					})
					.where(
						and(
							eq(testStepScripts.testCaseId, row.id),
							eq(testStepScripts.status, "active"),
						),
					)
					.returning({ id: testStepScripts.id });
				return { cleared: cleared.length };
			}),
		)
		.delete("/test-cases/:id/scripts/:stepId", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx);
				await requireTestPermission(db, who, "test_case.update");
				const { id, stepId } = parseInput(
					z.object({ id: z.string().min(1), stepId: z.string().min(1) }),
					ctx.params,
				);
				const row = await getTestCaseRow(db, who.orgId, id);
				const scripts = await db.query.testStepScripts.findMany({
					where: and(
						eq(testStepScripts.testCaseId, row.id),
						eq(testStepScripts.status, "active"),
					),
					columns: { id: true, stepId: true, stepIdsJson: true },
				});
				const matching = scripts.filter(
					(script) =>
						script.stepId === stepId ||
						parseJsonColumn(
							script.stepIdsJson,
							z.array(z.string()),
							[],
						).includes(stepId),
				);
				if (matching.length > 0) {
					await db
						.update(testStepScripts)
						.set({
							status: "invalid",
							staleReason: "cleared by user",
							updatedAt: Date.now(),
						})
						.where(
							inArray(
								testStepScripts.id,
								matching.map((script) => script.id),
							),
						);
				}
				return { cleared: matching.length };
			}),
		)
		.post("/test-cases/:id/runs", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx, true);
				await requireTestPermission(
					db,
					who,
					"test_run.create",
					"test_config.use",
				);
				const { id } = parseInput(caseIdParams, ctx.params);
				const body = parseInput(createTestRunRequestSchema, ctx.body);
				const row = await getTestCaseRow(db, who.orgId, id);
				const { results, batchId } = await requestRuns(db, {
					orgId: who.orgId,
					requester: requester(who),
					cases: [{ row, request: body }],
					...(body.dataset
						? { batch: { kind: "dataset", testCaseId: row.id } }
						: {}),
				});
				const response = await toCreateRunResponse(db, results, batchId);
				ctx.set.status = response.attached && results.length === 1 ? 200 : 201;
				return respond(createTestRunResponseSchema, response);
			}),
		)
		.get("/test-cases/:id/runs", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx);
				await requireTestPermission(db, who, "test_run.view");
				const { id } = parseInput(caseIdParams, ctx.params);
				const query = parseInput(
					z.object({
						limit: z.number().int().min(1).max(200).default(50),
						cursor: z.string().optional(),
					}),
					normalizeQuery(ctx.request.url, new Set()),
				);
				const row = await getTestCaseRow(db, who.orgId, id);
				const before = query.cursor ? Number(query.cursor) : null;
				const runs = await db.query.testRuns.findMany({
					where: and(
						eq(testRuns.testCaseId, row.id),
						before !== null && Number.isFinite(before)
							? lt(testRuns.queuedAt, before)
							: undefined,
					),
					orderBy: [desc(testRuns.queuedAt), desc(testRuns.id)],
					limit: query.limit + 1,
				});
				const page = runs.slice(0, query.limit);
				const items = [];
				for (const run of page) {
					items.push(await toRunSummary(db, run, { testCase: row }));
				}
				return respond(testRunListResponseSchema, {
					items,
					nextCursor:
						runs.length > query.limit
							? String(page[page.length - 1]?.queuedAt ?? "")
							: null,
				});
			}),
		)
		.get("/test-suites", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx, true);
				await requireTestPermission(db, who, "test_case.view");
				const suites = await db.query.testSuites.findMany({
					where: and(
						eq(testSuites.orgId, who.orgId),
						isNull(testSuites.deletedAt),
					),
					orderBy: asc(testSuites.name),
				});
				const items = [];
				for (const suite of suites) items.push(await toSuite(db, suite));
				return { items };
			}),
		)
		.post("/test-suites", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx);
				await requireTestPermission(db, who, "test_case.update");
				const body = parseInput(upsertTestSuiteRequestSchema, ctx.body);
				const [suite] = await db
					.insert(testSuites)
					.values({
						orgId: who.orgId,
						name: body.name,
						description: body.description ?? null,
						filterJson: body.filter ? JSON.stringify(body.filter) : null,
						createdBy: who.userId,
					})
					.returning();
				if (!suite) throw new Error("Failed to create suite");
				if (body.memberIds) {
					await setSuiteMembers(db, who.orgId, suite.id, body.memberIds);
				}
				ctx.set.status = 201;
				return toSuite(db, suite);
			}),
		)
		.get("/test-suites/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx, true);
				await requireTestPermission(db, who, "test_case.view");
				return toSuite(
					db,
					await getSuite(db, who.orgId, String(ctx.params.id)),
				);
			}),
		)
		.patch("/test-suites/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx);
				await requireTestPermission(db, who, "test_case.update");
				const suite = await getSuite(db, who.orgId, String(ctx.params.id));
				const body = parseInput(upsertTestSuiteRequestSchema, ctx.body);
				const [updated] = await db
					.update(testSuites)
					.set({
						name: body.name,
						...(body.description !== undefined
							? { description: body.description }
							: {}),
						...(body.filter !== undefined
							? { filterJson: body.filter ? JSON.stringify(body.filter) : null }
							: {}),
						updatedAt: Date.now(),
					})
					.where(eq(testSuites.id, suite.id))
					.returning();
				if (body.memberIds) {
					await setSuiteMembers(db, who.orgId, suite.id, body.memberIds);
				}
				return toSuite(db, updated ?? suite);
			}),
		)
		.delete("/test-suites/:id", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx);
				await requireTestPermission(db, who, "test_case.update");
				const suite = await getSuite(db, who.orgId, String(ctx.params.id));
				await db
					.update(testSuites)
					.set({ deletedAt: Date.now(), updatedAt: Date.now() })
					.where(eq(testSuites.id, suite.id));
				return { id: suite.id, deleted: true };
			}),
		)
		.post("/test-suites/:id/runs", (ctx) =>
			handleTestRoute(ctx, async () => {
				const db = requireDb(ctx.db);
				const who = await actor(ctx, true);
				await requireTestPermission(
					db,
					who,
					"test_run.create",
					"test_config.use",
				);
				const suite = await getSuite(db, who.orgId, String(ctx.params.id));
				const body = parseInput(createTestRunRequestSchema, ctx.body);
				const members = (await suiteMembers(db, who.orgId, suite)).filter(
					(row) => row.status === "active" || row.status === "draft",
				);
				if (members.length === 0) {
					throw new HttpError(
						409,
						"TEST_SUITE_EMPTY",
						"The suite has no runnable test cases",
					);
				}
				const { results, batchId } = await requestRuns(db, {
					orgId: who.orgId,
					requester: requester(who),
					cases: members.map((row) => ({ row, request: body })),
					batch: {
						kind: body.trigger === "ci" ? "ci" : "suite",
						suiteId: suite.id,
					},
				});
				ctx.set.status = 201;
				return respond(
					createTestRunResponseSchema,
					await toCreateRunResponse(db, results, batchId),
				);
			}),
		);
