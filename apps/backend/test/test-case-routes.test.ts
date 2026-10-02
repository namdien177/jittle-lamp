import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	DuplicateTestCaseRequest,
	ImportBatch,
	StepScript,
	TestCaseDetail,
	TestCaseListResponse,
} from "@jittle-lamp/shared";
import { and, eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";

import { testCases, testStepScripts } from "../src/db/schema";
import {
	createTestCaseFixture,
	FAKE_PASSWORD,
	loginTranscript,
	type TestCaseFixture,
} from "./test-case-fixtures";

const create = async (
	fixture: TestCaseFixture,
	transcript: string,
	extra: Record<string, unknown> = {},
) => {
	const response = await fixture.call<TestCaseDetail>("/test-cases", {
		token: fixture.qa.token,
		body: { transcript, ...extra },
	});
	expect(response.status).toBe(201);
	return response.body;
};

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterAll(() => {
	for (const server of servers) server.stop(true);
});

describe("test case routes", () => {
	it("creates cases with per-org keys, lint, fingerprint and required config", async () => {
		const fixture = await createTestCaseFixture();
		const first = await create(fixture, loginTranscript());
		const second = await create(fixture, "# Second case\n\n[Act] open {page}");
		expect(first.key).toBe("TC-0001");
		expect(second.key).toBe("TC-0002");
		expect(first.title).toBe("HQ admin logout clears the email");
		expect(first.status).toBe("active");
		expect(first.tags).toEqual(["team:qa-pcf", "feature:login", "regression"]);
		expect(first.steps).toHaveLength(5);
		expect(first.transcriptVersion).toBe(1);
		expect(first.fingerprint).toMatch(/^sha256:/);
		expect(first.requiredConfig).toEqual({
			variables: [],
			credentials: ["PCF_HQ_ADMIN"],
			unresolved: ["PCF_HQ_ADMIN"],
		});
		expect(second.requiredConfig.variables).toEqual(["page"]);
		expect(
			second.lint.some(
				(finding) =>
					finding.severity === "warning" ||
					finding.severity === "error" ||
					finding.severity === "info",
			),
		).toBe(true);

		const fetched = await fixture.call<TestCaseDetail>(
			`/test-cases/${first.key}`,
			{
				token: fixture.developer.token,
			},
		);
		expect(fetched.status).toBe(200);
		expect(fetched.body.id).toBe(first.id);

		const denied = await fixture.call("/test-cases", {
			token: fixture.developer.token,
			body: { transcript: loginTranscript("Developer case") },
		});
		expect(denied.status).toBe(403);
		expect(denied.body).toMatchObject({
			error: { code: "TEST_PERMISSION_DENIED" },
			permission: "test_case.create",
		});

		const invalid = await fixture.call("/test-cases", {
			token: fixture.qa.token,
			body: { transcript: "[Act] no title" },
		});
		expect(invalid.status).toBe(422);
		const multi = await fixture.call("/test-cases", {
			token: fixture.qa.token,
			body: { transcript: "# A\n[Act] a\n\n# B\n[Act] b" },
		});
		expect(multi.status).toBe(422);
		expect(multi.body).toMatchObject({ error: { code: "TRANSCRIPT_INVALID" } });
		const unauthenticated = await fixture.call("/test-cases");
		expect(unauthenticated.status).toBe(401);
	});

	it("lists with full-text search, filters, tag namespace counts and a cursor", async () => {
		const fixture = await createTestCaseFixture();
		await create(fixture, loginTranscript("Đăng xuất HQ admin"));
		await create(
			fixture,
			"# Enrolment form saves a child\nTags: team:qa-pcf, module:enrolment\n\n[Act] fill the enrolment form\n[Assert] the child appears in the list",
		);
		await create(
			fixture,
			"# Parent portal shows invoices\nTags: team:parents\n\n[Open] /invoices\n[Assert] invoices are listed",
			{ status: "draft" },
		);

		const search = await fixture.call<TestCaseListResponse>(
			"/test-cases?q=đăng xu",
			{ token: fixture.developer.token },
		);
		expect(search.body.items.map((item) => item.title)).toEqual([
			"Đăng xuất HQ admin",
		]);
		const short = await fixture.call<TestCaseListResponse>("/test-cases?q=TC", {
			token: fixture.qa.token,
		});
		expect(short.body.total).toBe(3);
		const enrolment = await fixture.call<TestCaseListResponse>(
			"/test-cases?q=enrolment form",
			{ token: fixture.qa.token },
		);
		expect(enrolment.body.items).toHaveLength(1);

		const tagged = await fixture.call<TestCaseListResponse>(
			"/test-cases?tags=team:qa-pcf",
			{ token: fixture.qa.token },
		);
		expect(tagged.body.total).toBe(2);
		expect(tagged.body.tagCounts).toMatchObject({
			team: { "qa-pcf": 2, parents: 1 },
			module: { enrolment: 1 },
			"": { regression: 1 },
		});
		const drafts = await fixture.call<TestCaseListResponse>(
			"/test-cases?status=draft",
			{ token: fixture.qa.token },
		);
		expect(drafts.body.items.map((item) => item.key)).toEqual(["TC-0003"]);

		const page1 = await fixture.call<TestCaseListResponse>(
			"/test-cases?limit=2&sort=key&order=asc",
			{ token: fixture.qa.token },
		);
		expect(page1.body.items.map((item) => item.key)).toEqual([
			"TC-0001",
			"TC-0002",
		]);
		expect(page1.body.nextCursor).toBeString();
		const page2 = await fixture.call<TestCaseListResponse>(
			`/test-cases?limit=2&sort=key&order=asc&cursor=${page1.body.nextCursor}`,
			{ token: fixture.qa.token },
		);
		expect(page2.body.items.map((item) => item.key)).toEqual(["TC-0003"]);
		expect(page2.body.nextCursor).toBeNull();
	});

	it("re-parses edits with stable step ids, versions and optimistic concurrency", async () => {
		const fixture = await createTestCaseFixture();
		const created = await create(fixture, loginTranscript());
		const edited = created.transcript.replace(
			"[Assert] the Email field is empty",
			"[Assert] the Email field is blank",
		);
		const updated = await fixture.call<TestCaseDetail>(
			`/test-cases/${created.id}`,
			{
				method: "PATCH",
				token: fixture.qa.token,
				body: { transcript: edited, expectedVersion: 1, changeNote: "wording" },
			},
		);
		expect(updated.status).toBe(200);
		expect(updated.body.transcriptVersion).toBe(2);
		const before = new Map(
			created.steps.map((step) => [step.text, step.stepId]),
		);
		for (const step of updated.body.steps.slice(0, 4)) {
			expect(step.stepId).toBe(before.get(step.text) ?? "missing");
		}
		const changed = updated.body.steps[4];
		expect(changed?.stepId).not.toBe(created.steps[4]?.stepId);

		const stale = await fixture.call(`/test-cases/${created.id}`, {
			method: "PATCH",
			token: fixture.qa.token,
			body: { transcript: `${edited}\n[Note] more`, expectedVersion: 1 },
		});
		expect(stale.status).toBe(409);
		expect(stale.body).toMatchObject({
			error: { code: "TEST_CASE_VERSION_CONFLICT" },
			currentVersion: 2,
		});

		const versions = await fixture.call<{
			items: Array<{ version: number; changeNote: string | null }>;
		}>(`/test-cases/${created.id}/versions`, {
			token: fixture.developer.token,
		});
		expect(versions.body.items.map((item) => item.version)).toEqual([2, 1]);
		expect(versions.body.items[0]?.changeNote).toBe("wording");

		const deleted = await fixture.call(`/test-cases/${created.id}`, {
			method: "DELETE",
			token: fixture.qa.token,
		});
		expect(deleted.status).toBe(200);
		expect(
			(
				await fixture.call(`/test-cases/${created.id}`, {
					token: fixture.qa.token,
				})
			).status,
		).toBe(404);
		const list = await fixture.call<TestCaseListResponse>("/test-cases", {
			token: fixture.qa.token,
		});
		expect(list.body.total).toBe(0);
	});

	it("duplicates with find/replace and inherits scripts of unchanged steps", async () => {
		const fixture = await createTestCaseFixture();
		const source = await create(fixture, loginTranscript());
		const now = Date.now();
		for (const step of source.steps) {
			await fixture.db.insert(testStepScripts).values({
				orgId: fixture.orgId,
				testCaseId: source.id,
				stepId: step.stepId,
				stepIdsJson: JSON.stringify([step.stepId]),
				instructionKey: step.instructionKey,
				keyHash: `key-${step.stepId}`,
				entryJson: JSON.stringify({
					schemaVersion: "trace-1",
					payload: { actions: [] },
				}),
				renderedCode: `// ${step.text}`,
				createdAt: now,
				updatedAt: now,
			});
		}
		const request: Partial<DuplicateTestCaseRequest> = {
			replacements: [{ find: "PCF_HQ_ADMIN", replace: "PCF_BRANCH_ADMIN" }],
			mode: "variant",
		};
		const duplicate = await fixture.call<{
			testCase: TestCaseDetail;
			inheritedScripts: number;
		}>(`/test-cases/${source.id}/duplicate`, {
			token: fixture.qa.token,
			body: request,
		});
		expect(duplicate.status).toBe(201);
		const copy = duplicate.body.testCase;
		expect(copy.title).toBe("HQ admin logout clears the email (copy)");
		expect(copy.key).toBe("TC-0002");
		expect(copy.status).toBe("draft");
		expect(copy.source).toBe("duplicate");
		expect(copy.duplicatedFromId).toBe(source.id);
		expect(copy.transcript).toContain("[Login: PCF_BRANCH_ADMIN]");
		// The login line changed; the other four steps keep their scripts.
		expect(duplicate.body.inheritedScripts).toBe(4);
		const scripts = await fixture.call<{ items: StepScript[] }>(
			`/test-cases/${copy.id}/scripts`,
			{ token: fixture.qa.token },
		);
		expect(scripts.body.items).toHaveLength(4);
		const loginStep = copy.steps.find((step) => step.type === "login");
		expect(
			scripts.body.items.some((script) => script.stepId === loginStep?.stepId),
		).toBe(false);
		const sourceDetail = await fixture.call<TestCaseDetail>(
			`/test-cases/${source.id}`,
			{ token: fixture.qa.token },
		);
		expect(sourceDetail.body.stats.derivedCases).toBe(1);
		expect(sourceDetail.body.stats.cachedSteps).toBe(5);

		const cleared = await fixture.call<{ cleared: number }>(
			`/test-cases/${copy.id}/scripts/${copy.steps[0]?.stepId}`,
			{ method: "DELETE", token: fixture.qa.token },
		);
		expect(cleared.body.cleared).toBe(1);
		const all = await fixture.call<{ cleared: number }>(
			`/test-cases/${copy.id}/scripts`,
			{ method: "DELETE", token: fixture.qa.token },
		);
		expect(all.body.cleared).toBe(3);
	});

	it("finds exact and near-duplicate cases", async () => {
		const fixture = await createTestCaseFixture();
		const source = await create(fixture, loginTranscript());
		await create(
			fixture,
			"# Invoices list loads\n\n[Open] /invoices\n[Assert] invoices are listed",
		);
		const exact = await fixture.call<{
			items: Array<{ id: string; exact: boolean; score: number }>;
		}>("/test-cases/similar", {
			token: fixture.qa.token,
			body: { transcript: loginTranscript("Completely different title") },
		});
		expect(exact.body.items[0]).toMatchObject({
			id: source.id,
			exact: true,
			score: 1,
		});
		const near = await fixture.call<{
			items: Array<{ id: string; exact: boolean; score: number }>;
		}>(
			`/test-cases/similar?title=${encodeURIComponent("HQ admin logout clears email field")}`,
			{ token: fixture.qa.token },
		);
		expect(near.body.items[0]?.id).toBe(source.id);
		expect(near.body.items[0]?.exact).toBe(false);
		expect(near.body.items).toHaveLength(1);
	});

	it("runs bulk actions: tag, untag, environment, export, archive, approve and reject", async () => {
		const fixture = await createTestCaseFixture();
		const a = await create(fixture, loginTranscript("Case A"));
		const b = await create(fixture, "# Case B\n\n[Act] do b", {
			status: "review",
			source: "import",
		});
		const c = await create(fixture, "# Case C\n\n[Act] do c", {
			status: "review",
			source: "ai",
		});
		const env = await fixture.call<{ id: string }>("/test-environments", {
			token: fixture.admin.token,
			body: { name: "pcf-uat", baseUrl: "https://uat.example.test" },
		});
		const tag = await fixture.call<{ updated: number }>("/test-cases/bulk", {
			token: fixture.qa.token,
			body: { action: "tag", ids: [a.id, b.id], tags: ["prio:p1"] },
		});
		expect(tag.body.updated).toBe(2);
		const untag = await fixture.call<{ updated: number }>("/test-cases/bulk", {
			token: fixture.qa.token,
			body: { action: "untag", ids: [a.id], tags: ["regression"] },
		});
		expect(untag.body.updated).toBe(1);
		const setEnv = await fixture.call<{ updated: number }>("/test-cases/bulk", {
			token: fixture.qa.token,
			body: {
				action: "set-environment",
				ids: [a.id],
				environmentId: env.body.id,
			},
		});
		expect(setEnv.body.updated).toBe(1);
		const detail = await fixture.call<TestCaseDetail>(`/test-cases/${a.id}`, {
			token: fixture.qa.token,
		});
		expect(detail.body.tags).toEqual([
			"team:qa-pcf",
			"feature:login",
			"prio:p1",
		]);
		expect(detail.body.environmentId).toBe(env.body.id);
		expect(detail.body.transcript).toContain("Env: pcf-uat");
		expect(detail.body.transcriptVersion).toBe(4);

		const exported = await fixture.call<{ document: string }>(
			"/test-cases/bulk",
			{
				token: fixture.developer.token,
				body: { action: "export", ids: [a.id, b.id] },
			},
		);
		expect(exported.body.document).toContain("# Case A\nKey: TC-0001");
		expect(exported.body.document).toContain("# Case B");

		const approveDenied = await fixture.call("/test-cases/bulk", {
			token: fixture.developer.token,
			body: { action: "approve", ids: [b.id] },
		});
		expect(approveDenied.status).toBe(403);
		const approve = await fixture.call<{
			updated: number;
			errors: Array<{ id: string }>;
		}>("/test-cases/bulk", {
			token: fixture.qa.token,
			body: { action: "approve", ids: [b.id, a.id] },
		});
		expect(approve.body.updated).toBe(1);
		expect(approve.body.errors.map((error) => error.id)).toEqual([a.id]);
		const reject = await fixture.call<TestCaseDetail>(
			`/test-cases/${c.id}/reject`,
			{
				token: fixture.qa.token,
				body: { reason: "duplicate of TC-0001" },
			},
		);
		expect(reject.body.status).toBe("archived");
		const archive = await fixture.call<{ updated: number }>(
			"/test-cases/bulk",
			{
				token: fixture.qa.token,
				body: { action: "archive", ids: [a.id] },
			},
		);
		expect(archive.body.updated).toBe(1);
		const statuses = await fixture.db.query.testCases.findMany({
			where: eq(testCases.orgId, fixture.orgId),
			columns: { key: true, status: true, statusReason: true },
		});
		expect(
			statuses.map((row) => [row.key, row.status, row.statusReason]).sort(),
		).toEqual([
			["TC-0001", "archived", null],
			["TC-0002", "active", null],
			["TC-0003", "archived", "duplicate of TC-0001"],
		]);
	});

	it("imports transcript documents, Gherkin, CSV and XLSX into the review queue idempotently", async () => {
		const fixture = await createTestCaseFixture();
		const document = [
			"# Login works",
			"External-id: SHEET-1",
			"",
			"[Act] sign in",
			"[Assert] dashboard shows",
			"",
			"# Logout works",
			"",
			"[Act] sign out",
			"[Assert] login form shows",
		].join("\n");
		const batch = await fixture.call<ImportBatch>("/test-cases/import", {
			token: fixture.qa.token,
			body: {
				sourceKind: "transcript-doc",
				content: document,
				defaultTags: ["imported"],
			},
		});
		expect(batch.status).toBe(201);
		expect(batch.body.status).toBe("ready");
		expect(
			batch.body.items.map((item) => [item.title, item.decision, item.state]),
		).toEqual([
			["Login works", "create", "ready"],
			["Logout works", "create", "ready"],
		]);
		expect(batch.body.items[0]?.transcript).toContain("Tags: imported");
		const committed = await fixture.call<ImportBatch>(
			`/test-cases/import/${batch.body.id}`,
			{ method: "PATCH", token: fixture.qa.token, body: { commit: true } },
		);
		expect(committed.body.status).toBe("done");
		expect(committed.body.counts).toMatchObject({ created: 2, updated: 0 });
		const createdIds = committed.body.items.map(
			(item) => item.resultTestCaseId,
		);
		const created = await fixture.call<TestCaseDetail>(
			`/test-cases/${createdIds[0]}`,
			{ token: fixture.qa.token },
		);
		expect(created.body.status).toBe("review");
		expect(created.body.source).toBe("import");
		expect(created.body.externalId).toBe("SHEET-1");

		// Re-import: External-id finds the existing case; the second one is an exact duplicate.
		const again = await fixture.call<ImportBatch>("/test-cases/import", {
			token: fixture.qa.token,
			body: {
				sourceKind: "transcript-doc",
				content: document,
				defaultTags: ["imported"],
			},
		});
		expect(again.body.items.map((item) => item.decision)).toEqual([
			"update",
			"skip",
		]);
		expect(again.body.items[1]?.similar[0]?.exact).toBe(true);
		const reCommitted = await fixture.call<ImportBatch>(
			`/test-cases/import/${again.body.id}`,
			{ method: "PATCH", token: fixture.qa.token, body: { commit: true } },
		);
		expect(reCommitted.body.counts).toMatchObject({
			created: 0,
			updated: 1,
			skipped: 1,
		});
		expect(
			(
				await fixture.call<TestCaseListResponse>("/test-cases", {
					token: fixture.qa.token,
				})
			).body.total,
		).toBe(2);
		const unchanged = await fixture.call<TestCaseDetail>(
			`/test-cases/${createdIds[0]}`,
			{ token: fixture.qa.token },
		);
		expect(unchanged.body.transcriptVersion).toBe(1);

		const feature = [
			"@smoke",
			"Feature: Enrolment",
			"  Background:",
			"    Given I am signed in as an HQ admin",
			"",
			"  Scenario Outline: Enrol a child at <level>",
			"    When I open the enrolment form",
			"    And I enrol a child at <level>",
			"    Then the child is listed",
			"    And the level shows <level>",
			"    Examples:",
			"      | level |",
			"      | K1    |",
			"      | K2    |",
		].join("\n");
		const gherkin = await fixture.call<ImportBatch>("/test-cases/import", {
			token: fixture.qa.token,
			body: {
				sourceKind: "gherkin",
				content: feature,
				fileName: "enrolment.feature",
			},
		});
		expect(gherkin.status).toBe(201);
		const transcript = gherkin.body.items[0]?.transcript ?? "";
		expect(transcript).toContain("Tags: smoke, feature:enrolment");
		expect(transcript).toContain("[Act] I am signed in as an HQ admin");
		expect(transcript).toContain("[Act] I enrol a child at {level}");
		expect(transcript).toContain("[Assert] the child is listed");
		expect(transcript).toContain("[Assert] the level shows {level}");
		expect(transcript).toContain(
			"## Dataset\n| level |\n| --- |\n| K1 |\n| K2 |",
		);
		expect(gherkin.body.items[0]?.externalId).toBe(
			"enrolment:Enrol a child at <level>",
		);

		const csv = [
			"ID,Name,Steps,Expected Result,Labels",
			'TR-1,Create invoice,"1. open invoices\n2. click ""New""",invoice is saved,"billing, p1"',
		].join("\n");
		const csvBatch = await fixture.call<ImportBatch>("/test-cases/import", {
			token: fixture.qa.token,
			body: { sourceKind: "csv", content: csv },
		});
		expect(csvBatch.body.items[0]?.transcript).toBe(
			'# Create invoice\nTags: billing, p1\nExternal-id: TR-1\n\n[Act] open invoices\n[Act] click "New"\n[Assert] invoice is saved\n',
		);

		const xlsx = zipSync({
			"xl/sharedStrings.xml": strToU8(
				"<sst><si><t>Title</t></si><si><t>Steps</t></si><si><t>Expected</t></si><si><t>Pay a bill</t></si><si><t>open billing</t></si><si><t>bill is paid</t></si></sst>",
			),
			"xl/worksheets/sheet1.xml": strToU8(
				'<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>5</v></c></row></sheetData></worksheet>',
			),
		});
		const xlsxBatch = await fixture.call<ImportBatch>("/test-cases/import", {
			token: fixture.qa.token,
			body: {
				sourceKind: "xlsx",
				content: Buffer.from(xlsx).toString("base64"),
				mapping: { title: "Title", steps: "Steps", expected: "Expected" },
			},
		});
		expect(xlsxBatch.status).toBe(201);
		expect(xlsxBatch.body.items[0]?.transcript).toBe(
			"# Pay a bill\n\n[Act] open billing\n[Assert] bill is paid\n",
		);
		const badXlsx = await fixture.call("/test-cases/import", {
			token: fixture.qa.token,
			body: { sourceKind: "xlsx", content: "bm90IGEgemlw" },
		});
		expect(badXlsx.status).toBe(422);
	});

	it("imports Jira issues through the organisation model and credential", async () => {
		const fixture = await createTestCaseFixture();
		let authorization = "";
		const jira = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				authorization = request.headers.get("authorization") ?? "";
				const url = new URL(request.url);
				if (url.pathname !== "/rest/api/3/search/jql") {
					return new Response("not found", { status: 404 });
				}
				return Response.json({
					issues: [
						{
							key: "PCF-1234",
							fields: {
								summary: "Logout keeps the email",
								labels: ["login"],
								description: {
									type: "doc",
									content: [
										{
											type: "paragraph",
											content: [
												{
													type: "text",
													text: "After logout the email must be empty.",
												},
											],
										},
									],
								},
							},
						},
					],
				});
			},
		});
		servers.push(jira);
		const fixturePath = join(
			tmpdir(),
			`jl-jira-model-${crypto.randomUUID()}.json`,
		);
		writeFileSync(
			fixturePath,
			JSON.stringify({
				schemaVersion: 1,
				turns: [
					{
						match: { promptIncludes: ["PCF-1234"] },
						content: [
							{
								type: "text",
								text: "```\n# Logout clears the email\n\n[Open] /login\n[Login: PCF_HQ_ADMIN] sign in\n[Act] sign out\n[Assert] the Email field is empty\n```",
							},
						],
					},
				],
			}),
		);
		const model = await fixture.call("/test-model-settings", {
			method: "PUT",
			token: fixture.admin.token,
			body: {
				actModel: `mock:${fixturePath}`,
				judgeModel: `mock:${fixturePath}`,
			},
		});
		expect(model.status).toBe(200);
		const credential = await fixture.call<{ id: string }>("/test-credentials", {
			token: fixture.admin.token,
			body: {
				profile: "JIRA",
				kind: "jira",
				fields: {
					base_url: `http://127.0.0.1:${jira.port}`,
					email: "qa@example.test",
				},
				secretFields: { api_token: FAKE_PASSWORD },
			},
		});
		expect(credential.status).toBe(201);
		const batch = await fixture.call<ImportBatch>("/test-cases/import", {
			token: fixture.qa.token,
			body: {
				sourceKind: "jira",
				jql: "project = PCF",
				jiraCredentialId: credential.body.id,
			},
		});
		expect(batch.status).toBe(201);
		expect(authorization).toBe(
			`Basic ${Buffer.from(`qa@example.test:${FAKE_PASSWORD}`).toString("base64")}`,
		);
		const item = batch.body.items[0];
		expect(item?.state).toBe("ready");
		expect(item?.externalId).toBe("PCF-1234");
		expect(item?.transcript).toContain("# Logout clears the email");
		expect(item?.transcript).toContain(
			`Links: http://127.0.0.1:${jira.port}/browse/PCF-1234`,
		);
		expect(item?.transcript).toContain("Tags: login");
		expect(item?.transcript).not.toContain(FAKE_PASSWORD);
		const committed = await fixture.call<ImportBatch>(
			`/test-cases/import/${batch.body.id}`,
			{ method: "PATCH", token: fixture.qa.token, body: { commit: true } },
		);
		const caseId = committed.body.items[0]?.resultTestCaseId;
		const created = await fixture.db.query.testCases.findFirst({
			where: and(
				eq(testCases.orgId, fixture.orgId),
				eq(testCases.id, caseId ?? ""),
			),
		});
		expect(created?.status).toBe("review");
		expect(created?.source).toBe("ai");
	});

	it("manages suites and runs them as a batch", async () => {
		const fixture = await createTestCaseFixture();
		const a = await create(fixture, loginTranscript("Suite A"));
		const b = await create(fixture, "# Suite B\nTags: smoke\n\n[Act] do b");
		const suite = await fixture.call<{ id: string; memberIds: string[] }>(
			"/test-suites",
			{
				token: fixture.qa.token,
				body: { name: "Smoke", memberIds: [a.id], filter: { tags: ["smoke"] } },
			},
		);
		expect(suite.status).toBe(201);
		expect(suite.body.memberIds).toEqual([a.id]);
		const run = await fixture.call<{
			batchId: string;
			runIds: string[];
			attached: boolean;
		}>(`/test-suites/${suite.body.id}/runs`, {
			token: fixture.developer.token,
			body: { trigger: "ci" },
		});
		expect(run.status).toBe(201);
		expect(run.body.runIds).toHaveLength(2);
		const batch = await fixture.call<{
			kind: string;
			counts: { total: number; pending: number };
			runIds: string[];
		}>(`/test-run-batches/${run.body.batchId}`, {
			token: fixture.developer.token,
		});
		expect(batch.body.kind).toBe("ci");
		expect(batch.body.counts).toMatchObject({ total: 2, pending: 2 });
		expect(batch.body.runIds.sort()).toEqual([...run.body.runIds].sort());
		const listed = await fixture.call<{ items: unknown[] }>(
			`/test-runs?batchId=${run.body.batchId}`,
			{ token: fixture.developer.token },
		);
		expect(listed.body.items).toHaveLength(2);
		expect(b.id).toBeString();
	});
});
