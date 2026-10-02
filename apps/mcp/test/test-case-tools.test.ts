import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	fixtureCredential,
	fixtureCredentialPassword,
	fixtureEnvironment,
	fixtureMacro,
	fixtureRunDetail,
	fixtureRunSummary,
	fixtureTestCaseDetail,
	fixtureTestCaseSummary,
} from "../../../tests/fixtures/test-api-fixtures";
import { JittleLampClient, readConfig } from "../src/client";
import { createJittleLampMcpServer } from "../src/server";
import { registerTestCaseTools } from "../src/test-case-tools";

const config = {
	token: "jl_ai_this_is_a_private_test_token_12345",
	apiOrigin: "https://api.example.test",
	webOrigin: "https://web.example.test",
};

type Recorded = { method: string; url: URL; body: unknown };
const sessions: Array<{ client: Client; server: McpServer }> = [];

afterEach(async () => {
	await Promise.all(
		sessions.splice(0).map(async ({ client, server }) => {
			await client.close();
			await server.close();
		}),
	);
});

async function setup(
	respond: (request: Recorded) => Response | Promise<Response>,
	options: { sleeps?: number[]; clock?: { now: number } } = {},
) {
	const requests: Recorded[] = [];
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input);
		const recorded = {
			method: init?.method ?? "GET",
			url,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		};
		requests.push(recorded);
		expect(new Headers(init?.headers).get("authorization")).toBe(
			`Bearer ${config.token}`,
		);
		return respond(recorded);
	}) as typeof fetch;
	const client = new JittleLampClient(config, fetcher);
	const server = new McpServer({ name: "test-case-tools", version: "1" });
	const clock = options.clock ?? { now: 0 };
	registerTestCaseTools(
		server,
		(method, path, requestOptions) => client.request(method, path, requestOptions),
		{
			webOrigin: config.webOrigin,
			now: () => clock.now,
			sleep: async (ms) => {
				options.sleeps?.push(ms);
				clock.now += ms;
			},
		},
	);
	const mcp = new Client({ name: "test-case-tools-client", version: "1" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	sessions.push({ client: mcp, server });
	await server.connect(serverTransport);
	await mcp.connect(clientTransport);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await mcp.callTool({ name, arguments: args });
		return {
			isError: result.isError === true,
			data: result.structuredContent as Record<string, unknown>,
			text: JSON.stringify(result),
		};
	};
	return { call, requests };
}

describe("MCP test-case tools", () => {
	test("registers every design.md §8 tool on the production server", async () => {
		const server = createJittleLampMcpServer(
			readConfig({ JL_AI_TOKEN: config.token }),
			(async () => Response.json({})) as unknown as typeof fetch,
		);
		const client = new Client({ name: "catalog", version: "1" });
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		sessions.push({ client, server: server as unknown as McpServer });
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const tools = (await client.listTools()).tools;
		const names = tools.map((tool) => tool.name);
		for (const name of [
			"list_test_cases",
			"get_test_case",
			"create_test_case",
			"update_test_case_transcript",
			"list_test_environments",
			"list_test_macros",
			"list_test_credentials",
			"create_test_macro",
			"import_test_cases",
			"duplicate_test_case",
			"find_similar_test_cases",
			"generate_test_cases",
			"run_test_case",
			"get_test_run",
			"list_test_runs",
		]) {
			expect(names).toContain(name);
		}
		const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint);
		expect(readOnly.map((tool) => tool.name)).toContain("list_test_credentials");
		expect(readOnly.map((tool) => tool.name)).not.toContain("run_test_case");
	});

	test("lists test cases with joined filters and validates the contract", async () => {
		const { call, requests } = await setup(() =>
			Response.json({
				items: [fixtureTestCaseSummary()],
				total: 1,
				nextCursor: null,
				tagCounts: { team: { "qa-pcf": 1 } },
			}),
		);
		const result = await call("list_test_cases", {
			q: "logout",
			status: ["active", "review"],
			tags: ["team:qa-pcf"],
			limit: 10,
		});
		expect(result.isError).toBe(false);
		expect(result.data.contractWarning).toBeUndefined();
		expect((result.data.items as unknown[]).length).toBe(1);
		const url = requests[0]?.url;
		expect(url?.pathname).toBe("/test-cases");
		expect(url?.searchParams.get("status")).toBe("active,review");
		expect(url?.searchParams.get("tags")).toBe("team:qa-pcf");
		expect(url?.searchParams.get("q")).toBe("logout");
	});

	test("flags responses that drift from the shared contract without hiding them", async () => {
		const { call } = await setup(() => Response.json({ items: [{ id: "x" }] }));
		const result = await call("list_test_cases");
		expect(result.isError).toBe(false);
		expect(result.data.contractWarning).toMatch(/shared test-case contract/);
		expect(result.data.items).toEqual([{ id: "x" }]);
	});

	test("get_test_case returns cache status and strips rendered code unless asked", async () => {
		const script = {
			id: "script-1",
			testCaseId: "case-0412",
			stepId: "step-1",
			instructionKey: "key",
			environmentId: null,
			keyHash: "hash",
			version: 1,
			renderedCode: "await page.getByRole('button').click();",
			status: "active",
			staleReason: null,
			verifiedCount: 3,
			recordedFromRunId: null,
			lastReplayedAt: null,
			createdAt: 1,
		};
		const { call, requests } = await setup(({ url }) =>
			url.pathname.endsWith("/scripts")
				? Response.json({ items: [script] })
				: Response.json(fixtureTestCaseDetail()),
		);
		const plain = await call("get_test_case", { testCaseId: "case-0412" });
		expect(plain.data.transcript).toContain("[Login: PCF_HQ_ADMIN]");
		expect(plain.data.stats).toMatchObject({ cachedSteps: 4, staleSteps: 1 });
		expect(requests).toHaveLength(1);

		const withScripts = await call("get_test_case", {
			testCaseId: "case-0412",
			includeScripts: true,
		});
		expect(withScripts.data.stepScripts).toEqual([
			expect.objectContaining({ stepId: "step-1", status: "active" }),
		]);
		expect(withScripts.text).not.toContain("getByRole");
		const withCode = await call("get_test_case", {
			testCaseId: "case-0412",
			includeScripts: true,
			includeCode: true,
		});
		expect(withCode.text).toContain("getByRole");
	});

	test("rejects path-like IDs before calling the API", async () => {
		const { call, requests } = await setup(() => Response.json({}));
		const result = await call("get_test_case", { testCaseId: "../orgs" });
		expect(result.isError).toBe(true);
		expect(requests).toHaveLength(0);
	});

	test("create and update return server-side lint as data", async () => {
		const lint = fixtureTestCaseDetail().lint;
		const { call, requests } = await setup(({ method }) =>
			method === "PATCH"
				? Response.json(
						{
							error: { code: "TRANSCRIPT_LINT", message: "Transcript has lint errors" },
							lint,
						},
						{ status: 422 },
					)
				: Response.json(fixtureTestCaseDetail(), { status: 201 }),
		);
		const created = await call("create_test_case", {
			transcript: "# Title\n[Open] /login",
		});
		expect(created.isError).toBe(false);
		expect(created.data.lint).toEqual(lint);
		expect(requests[0]?.body).toMatchObject({
			transcript: "# Title\n[Open] /login",
			source: "ai",
		});

		const updated = await call("update_test_case_transcript", {
			testCaseId: "case-0412",
			transcript: "# Title\n[Bogus] x",
			expectedVersion: 3,
		});
		expect(updated.isError).toBe(true);
		expect(updated.data.status).toBe(422);
		expect(updated.data.lint).toEqual(lint);
		expect(requests[1]).toMatchObject({
			method: "PATCH",
			body: { transcript: "# Title\n[Bogus] x", expectedVersion: 3 },
		});
		expect(requests[1]?.url.pathname).toBe("/test-cases/case-0412");
	});

	test("credential tool returns profile and field names only, never values", async () => {
		const { call } = await setup(() =>
			Response.json({
				items: [
					{
						...fixtureCredential(),
						// A backend bug must not leak values through the tool.
						secretFields: { password: fixtureCredentialPassword },
					},
				],
			}),
		);
		const result = await call("list_test_credentials");
		expect(result.isError).toBe(false);
		expect(result.data.credentials).toEqual([
			{
				id: "cred-pcf-hq",
				profile: "PCF_HQ_ADMIN",
				kind: "login",
				environmentId: "env-pcf-uat",
				fieldNames: ["username"],
				secretFieldNames: ["password"],
			},
		]);
		expect(result.text).not.toContain(fixtureCredentialPassword);
		expect(result.text).not.toContain("qa.hq@example.test");
	});

	test("environment and macro lists accept named or item arrays", async () => {
		const { call } = await setup(({ url }) =>
			url.pathname === "/test-environments"
				? Response.json({ environments: [fixtureEnvironment()] })
				: Response.json({ items: [fixtureMacro()] }),
		);
		const environments = await call("list_test_environments");
		expect(environments.data.environments).toEqual([fixtureEnvironment()]);
		const macros = await call("list_test_macros");
		expect(macros.data.macros).toEqual([fixtureMacro()]);
		expect(macros.data.contractWarning).toBeUndefined();
	});

	test("agent-created macros are always drafts", async () => {
		const { call, requests } = await setup(() =>
			Response.json(fixtureMacro({ status: "draft" }), { status: 201 }),
		);
		const result = await call("create_test_macro", {
			name: "LoginAs",
			params: [{ name: "profile", required: true, default: null, kind: "credential" }],
			transcript: "[Login: {profile}]",
		});
		expect(result.isError).toBe(false);
		expect(requests[0]?.body).toMatchObject({ name: "LoginAs", status: "draft" });
		const rejected = await call("create_test_macro", {
			name: "LoginAs",
			transcript: "[Login: {profile}]",
			status: "active",
		});
		expect(rejected.isError).toBe(true);
		expect(requests).toHaveLength(1);
	});

	test("import returns per-case lint and similarity from the batch", async () => {
		const batch = {
			id: "batch-1",
			sourceKind: "transcript-doc",
			status: "ready",
			counts: { total: 1, created: 0, updated: 0, skipped: 0, errors: 0 },
			createdBy: "user-qa",
			createdAt: 1,
			items: [
				{
					id: "item-1",
					ordinal: 0,
					externalId: null,
					title: "Branch admin logout",
					transcript: "# Branch admin logout\n[Open] /login",
					lint: fixtureTestCaseDetail().lint,
					similar: [{ id: "case-0412", key: "TC-0412", title: "HQ admin logout", score: 0.86, exact: false }],
					decision: "create",
					resultTestCaseId: null,
					error: null,
					state: "ready",
				},
			],
		};
		const { call, requests } = await setup(() => Response.json(batch, { status: 201 }));
		const result = await call("import_test_cases", {
			content: "# Branch admin logout\n[Open] /login",
			defaultTags: ["team:qa-pcf"],
		});
		expect(result.isError).toBe(false);
		expect(result.data.items).toEqual(batch.items);
		expect(requests[0]?.body).toMatchObject({
			sourceKind: "transcript-doc",
			defaultTags: ["team:qa-pcf"],
		});
	});

	test("duplicate and similar call their fixed routes", async () => {
		const { call, requests } = await setup(({ url }) =>
			url.pathname === "/test-cases/similar"
				? Response.json({ items: [] })
				: Response.json({ testCase: fixtureTestCaseDetail(), inheritedScripts: 4 }),
		);
		const duplicate = await call("duplicate_test_case", {
			testCaseId: "case-0412",
			replacements: [{ find: "HQ", replace: "Branch" }],
		});
		expect(duplicate.data.inheritedScripts).toBe(4);
		expect(requests[0]?.url.pathname).toBe("/test-cases/case-0412/duplicate");
		expect(requests[0]?.body).toMatchObject({ mode: "copy", inheritScripts: true });
		const similar = await call("find_similar_test_cases", { title: "logout" });
		expect(similar.data.items).toEqual([]);
		expect(requests[1]?.url.searchParams.get("title")).toBe("logout");
		const missing = await call("find_similar_test_cases", {});
		expect(missing.isError).toBe(true);
	});

	test("generate goes through the ai-generation import and reports when it is unavailable", async () => {
		let available = false;
		const { call, requests } = await setup(({ url, method }) => {
			if (method === "GET") return Response.json(fixtureTestCaseDetail());
			if (!available) {
				return Response.json(
					{ error: { code: "VALIDATION", message: "sourceKind ai-generation is not supported" } },
					{ status: 422 },
				);
			}
			expect(url.pathname).toBe("/test-cases/import");
			return Response.json({
				id: "batch-2",
				sourceKind: "ai-generation",
				status: "parsing",
				counts: { total: 0, created: 0, updated: 0, skipped: 0, errors: 0 },
				createdBy: null,
				createdAt: 1,
				items: [],
			});
		});
		const unavailable = await call("generate_test_cases", {
			text: "Parents can reset their password from the login page",
		});
		expect(unavailable.isError).toBe(true);
		expect(unavailable.data.code).toBe("GENERATION_NOT_AVAILABLE");

		available = true;
		const fromCase = await call("generate_test_cases", { testCaseId: "case-0412" });
		expect(fromCase.isError).toBe(false);
		expect(fromCase.data.sourceKind).toBe("ai-generation");
		const importBody = requests.at(-1)?.body as Record<string, unknown>;
		expect(importBody.sourceKind).toBe("ai-generation");
		expect(importBody.content).toContain("[Login: PCF_HQ_ADMIN]");

		const both = await call("generate_test_cases", { text: "x", testCaseId: "case-0412" });
		expect(both.isError).toBe(true);
	});

	test("run_test_case creates a backend run with the mcp trigger and returns queue state", async () => {
		const { call, requests } = await setup(() =>
			Response.json(
				{
					runId: "run-1",
					attached: true,
					status: "queued",
					queuePosition: 2,
					requestedBy: [{ userId: "user-qa", name: "Quinn QA" }],
					batchId: null,
					runIds: [],
				},
				{ status: 201 },
			),
		);
		const result = await call("run_test_case", {
			testCaseId: "case-0412",
			environmentId: "env-pcf-uat",
			params: { school: "HQ" },
		});
		expect(result.isError).toBe(false);
		expect(result.data).toMatchObject({
			runId: "run-1",
			attached: true,
			queuePosition: 2,
			desktopUrl: "jittle-lamp://run?runId=run-1",
		});
		expect(requests[0]?.url.pathname).toBe("/test-cases/case-0412/runs");
		expect(requests[0]?.body).toMatchObject({
			environmentId: "env-pcf-uat",
			params: { school: "HQ" },
			trigger: "mcp",
			force: false,
		});
	});

	test("run_test_case wait=true polls until the run finishes and links the evidence", async () => {
		const sleeps: number[] = [];
		const statuses = ["queued", "running", "completed"] as const;
		let polls = 0;
		const { call, requests } = await setup(
			({ method }) => {
				if (method === "POST") {
					return Response.json({
						runId: "run-7f3c2a10-0000-4000-8000-000000000001",
						attached: false,
						status: "queued",
						queuePosition: 0,
						requestedBy: [],
						batchId: null,
						runIds: [],
					});
				}
				const status = statuses[Math.min(polls++, statuses.length - 1)] ?? "completed";
				return Response.json(fixtureRunDetail({ status }));
			},
			{ sleeps },
		);
		const result = await call("run_test_case", {
			testCaseId: "case-0412",
			wait: true,
			pollIntervalSeconds: 2,
		});
		expect(result.isError).toBe(false);
		expect(result.data.timedOut).toBe(false);
		expect((result.data.run as { status: string }).status).toBe("completed");
		expect(result.data.evidenceDebug).toMatchObject({
			tool: "get_evidence_debug",
			arguments: { evidenceId: "evidence-run-1" },
		});
		expect(sleeps).toEqual([2000, 2000]);
		expect(requests.filter((request) => request.method === "GET")).toHaveLength(3);
	});

	test("run_test_case wait=true stops at the timeout and says the run is still going", async () => {
		const { call } = await setup(({ method }) =>
			method === "POST"
				? Response.json({
						runId: "run-1",
						attached: false,
						status: "queued",
						queuePosition: 0,
						requestedBy: [],
						batchId: null,
						runIds: [],
					})
				: Response.json(fixtureRunDetail({ status: "running" })),
		);
		const result = await call("run_test_case", {
			testCaseId: "case-0412",
			wait: true,
			timeoutSeconds: 12,
			pollIntervalSeconds: 5,
		});
		expect(result.isError).toBe(false);
		expect(result.data.timedOut).toBe(true);
		expect((result.data.run as { status: string }).status).toBe("running");
	});

	test("get_test_run and list_test_runs link evidence and choose the right route", async () => {
		const { call, requests } = await setup(({ url }) =>
			url.pathname.startsWith("/test-runs/")
				? Response.json(fixtureRunDetail())
				: Response.json({ items: [fixtureRunSummary()], nextCursor: null }),
		);
		const run = await call("get_test_run", {
			runId: "run-7f3c2a10-0000-4000-8000-000000000001",
		});
		expect(run.data.evidenceUrl).toBe(
			"https://web.example.test/evidence/evidence-run-1",
		);
		expect(run.data.contractWarning).toBeUndefined();
		await call("list_test_runs", { testCaseId: "case-0412", status: ["completed"] });
		await call("list_test_runs", {});
		expect(requests[1]?.url.pathname).toBe("/test-cases/case-0412/runs");
		expect(requests[1]?.url.searchParams.get("status")).toBe("completed");
		expect(requests[2]?.url.pathname).toBe("/test-runs");
	});

	test("never echoes the token in tool errors", async () => {
		const { call } = await setup(() =>
			Response.json({ error: { message: `bad ${config.token}` } }, { status: 403 }),
		);
		const result = await call("get_test_run", { runId: "run-1" });
		expect(result.isError).toBe(true);
		expect(result.text).not.toContain(config.token);
	});
});
