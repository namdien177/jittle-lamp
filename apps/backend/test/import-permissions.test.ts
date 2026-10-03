import { afterAll, describe, expect, it } from "bun:test";
import type { ImportBatch } from "@jittle-lamp/shared";
import { and, eq } from "drizzle-orm";

import { organizationRoles } from "../src/db/schema";
import { JIRA_IMPORT_MAX_ISSUES } from "../src/services/test-imports";
import {
	createTestCaseFixture,
	FAKE_PASSWORD,
	type TestCaseFixture,
} from "./test-case-fixtures";

// Review finding: a Jira import decrypts the organisation's Jira credential and BYOK model key
// but needed only test_case.create, and it made one model call per issue inside the request.

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterAll(() => {
	for (const server of servers) server.stop(true);
});

const jiraServer = (issueCount: number) => {
	const seen: { maxResults: string | null } = { maxResults: null };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			seen.maxResults = url.searchParams.get("maxResults");
			return Response.json({
				issues: Array.from({ length: issueCount }, (_, index) => ({
					key: `PCF-${index + 1}`,
					fields: { summary: `Issue ${index + 1}`, labels: [] },
				})),
			});
		},
	});
	servers.push(server);
	return { server, seen };
};

const jiraCredential = async (fixture: TestCaseFixture, port: number) => {
	const credential = await fixture.call<{ id: string }>("/test-credentials", {
		token: fixture.admin.token,
		body: {
			profile: "JIRA",
			kind: "jira",
			fields: {
				base_url: `http://127.0.0.1:${port}`,
				email: "qa@example.test",
			},
			secretFields: { api_token: FAKE_PASSWORD },
		},
	});
	if (credential.status !== 201)
		throw new Error(JSON.stringify(credential.body));
	return credential.body.id;
};

describe("import permissions", () => {
	it("requires test_config.use for Jira imports but not for document imports", async () => {
		let modelCalls = 0;
		const fixture = await createTestCaseFixture({
			// The fake Jira listens on 127.0.0.1.
			env: { JL_OUTBOUND_ALLOW_LOOPBACK: "true" },
			dependencies: {
				generateText: async () => {
					modelCalls += 1;
					return "# Generated\n\n[Act] do it";
				},
			},
		});
		await fixture.db
			.update(organizationRoles)
			.set({
				permissionsJson: JSON.stringify(["test_case.view", "test_case.create"]),
			})
			.where(
				and(
					eq(organizationRoles.organizationId, fixture.orgId),
					eq(organizationRoles.key, "developer"),
				),
			);
		const { server, seen } = jiraServer(1);
		const credentialId = await jiraCredential(fixture, server.port ?? 0);
		const denied = await fixture.call<{ error: { code: string } }>(
			"/test-cases/import",
			{
				token: fixture.developer.token,
				body: {
					sourceKind: "jira",
					jql: "project = PCF",
					jiraCredentialId: credentialId,
				},
			},
		);
		expect(denied.status).toBe(403);
		expect(denied.body.error.code).toBe("TEST_PERMISSION_DENIED");
		expect(seen.maxResults).toBeNull();
		expect(modelCalls).toBe(0);

		const document = await fixture.call<ImportBatch>("/test-cases/import", {
			token: fixture.developer.token,
			body: {
				sourceKind: "transcript-doc",
				content: "# Plain import\n\n[Act] open the page",
			},
		});
		expect(document.status).toBe(201);
	});

	it("caps the model calls a Jira import makes inside the request", async () => {
		let modelCalls = 0;
		const fixture = await createTestCaseFixture({
			// The fake Jira listens on 127.0.0.1.
			env: { JL_OUTBOUND_ALLOW_LOOPBACK: "true" },
			dependencies: {
				generateText: async () => {
					modelCalls += 1;
					return "# Generated\n\n[Act] do it";
				},
			},
		});
		await fixture.call("/test-model-settings", {
			method: "PUT",
			token: fixture.admin.token,
			body: {
				actModel: "anthropic/claude-sonnet-5-5",
				judgeModel: "anthropic/claude-sonnet-5-5",
				apiKey: "sk-fake-model-key-0000",
			},
		});
		const { server, seen } = jiraServer(JIRA_IMPORT_MAX_ISSUES + 5);
		const credentialId = await jiraCredential(fixture, server.port ?? 0);
		const batch = await fixture.call<ImportBatch>("/test-cases/import", {
			token: fixture.qa.token,
			body: {
				sourceKind: "jira",
				jql: "project = PCF",
				jiraCredentialId: credentialId,
			},
		});
		expect(batch.status).toBe(201);
		expect(seen.maxResults).toBe(String(JIRA_IMPORT_MAX_ISSUES));
		expect(batch.body.items).toHaveLength(JIRA_IMPORT_MAX_ISSUES);
		expect(modelCalls).toBe(JIRA_IMPORT_MAX_ISSUES);
	});

	it("sends the Jira search through the outbound SSRF guard", async () => {
		let modelCalls = 0;
		let fetchCalls = 0;
		const fixture = await createTestCaseFixture({
			dependencies: {
				generateText: async () => {
					modelCalls += 1;
					return "# Generated\n\n[Act] do it";
				},
				fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
					fetchCalls += 1;
					return fetch(input, init);
				}) as typeof fetch,
			},
		});
		const { server, seen } = jiraServer(1);
		const importFrom = async (baseUrl: string) => {
			const credential = await fixture.call<{ id: string }>(
				"/test-credentials",
				{
					token: fixture.admin.token,
					body: {
						profile: `JIRA_${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
						kind: "jira",
						fields: { base_url: baseUrl, email: "qa@example.test" },
						secretFields: { api_token: FAKE_PASSWORD },
					},
				},
			);
			expect(credential.status).toBe(201);
			return fixture.call<{ error: { code: string; message: string } }>(
				"/test-cases/import",
				{
					token: fixture.qa.token,
					body: {
						sourceKind: "jira",
						jql: "project = PCF",
						jiraCredentialId: credential.body.id,
					},
				},
			);
		};
		// Loopback without JL_OUTBOUND_ALLOW_LOOPBACK, a private address and cloud metadata.
		for (const baseUrl of [
			`http://127.0.0.1:${server.port}`,
			"http://10.1.2.3",
			"http://169.254.169.254",
		]) {
			const refused = await importFrom(baseUrl);
			expect(refused.status).toBe(422);
			expect(refused.body.error.code).toBe("JIRA_URL_BLOCKED");
			expect(refused.body.error.message).toContain(
				"resolves to a private or local address",
			);
			expect(refused.body.error.message).not.toContain(FAKE_PASSWORD);
		}
		expect(seen.maxResults).toBeNull();
		expect(fetchCalls).toBe(0);
		expect(modelCalls).toBe(0);
	});
});
