import { expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readConfig } from "../src/client";
import { createJittleLampMcpServer } from "../src/server";

async function withMcpClient(
	token: string,
	fetcher: typeof fetch,
	run: (client: Client) => Promise<void>,
) {
	const server = createJittleLampMcpServer(
		readConfig({
			JL_AI_TOKEN: token,
			JITTLE_LAMP_API_ORIGIN: "http://127.0.0.1:1234",
		}),
		fetcher,
	);
	const client = new Client({ name: "token-contract-test", version: "1.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	try {
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		await run(client);
	} finally {
		await client.close();
		await server.close();
	}
}

for (const prefix of ["jl_api_", "jl_ai_"]) {
	for (const status of [401, 403]) {
		it(`preserves get_context ${status} with token-specific guidance for ${prefix} credentials`, async () => {
			const token = `${prefix}aaaaaaaaaaaaaaaaaaaaaaaa`;
			const backendPayload = {
				error: {
					code: status === 401 ? "AUTH_INVALID_TOKEN" : "AUTH_FORBIDDEN",
					message: "Backend access denied",
					status,
					requestId: "backend-request-id",
				},
				details: { source: "backend" },
			};
			let calls = 0;
			const fetcher = (async (url: URL | RequestInfo, init?: RequestInit) => {
				calls++;
				expect(String(url)).toBe("http://127.0.0.1:1234/protected/me");
				expect(init?.method).toBe("GET");
				expect(new Headers(init?.headers).get("authorization")).toBe(
					`Bearer ${token}`,
				);
				return Response.json(backendPayload, { status });
			}) as unknown as typeof fetch;
			await withMcpClient(token, fetcher, async (client) => {
				const result = await client.callTool({
					name: "get_context",
					arguments: {},
				});
				const data = result.structuredContent as Record<string, unknown>;
				expect(result.isError).toBe(true);
				expect(data.status).toBe(status);
				expect(data.error).toEqual(backendPayload.error);
				expect(data.details).toEqual(backendPayload.details);
				if (prefix === "jl_api_") {
					expect(data.tokenGuidance).toMatch(/automation/i);
					expect(data.tokenGuidance).toContain("ZIP");
					expect(data.tokenGuidance).toContain("AI token");
				} else {
					expect(data.tokenGuidance).toBeUndefined();
				}
				expect(JSON.stringify(result)).not.toContain(token);
			});
			expect(calls).toBe(1);
		});
	}
}

it("rejects an AI ZIP upload without orgId before reading the file or contacting the API", async () => {
	let calls = 0;
	const fetcher = (async () => {
		calls++;
		return Response.json({ unexpectedWrite: true });
	}) as unknown as typeof fetch;
	await withMcpClient(
		"jl_ai_aaaaaaaaaaaaaaaaaaaaaaaa",
		fetcher,
		async (client) => {
			const result = await client.callTool({
				name: "upload_evidence_zip",
				arguments: { zipPath: "/missing-mcp-fixture/evidence.zip" },
			});
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toEqual({
				error: "orgId is required for AI evidence uploads",
				code: "AI_UPLOAD_ORG_REQUIRED",
			});
		},
	);
	expect(calls).toBe(0);
});
