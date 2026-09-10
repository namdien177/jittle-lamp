import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerArtifactTools } from "../src/artifact-tools";
import { JittleLampClient } from "../src/client";

const config = {
	token: "jl_ai_this_is_a_private_test_token_12345",
	apiOrigin: "https://api.example.test",
	webOrigin: "https://web.example.test",
};
const sessions: Array<{ client: Client; server: McpServer }> = [];
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		sessions.splice(0).map(async ({ client, server }) => {
			await client.close();
			await server.close();
		}),
	);
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

const archive = (messages = ["first", "second", "third"]) => ({
	schemaVersion: 3,
	sessionId: "session-test-123",
	name: "Artifact test",
	createdAt: "2026-09-11T00:00:00.000Z",
	updatedAt: "2026-09-11T00:00:00.000Z",
	phase: "ready",
	page: { title: "Example", url: "https://example.test" },
	artifacts: [],
	sections: {
		actions: [],
		network: [],
		console: messages.map((message, seq) => ({
			id: `console-${seq}`,
			seq,
			at: "2026-09-11T00:00:00.000Z",
			payload: { kind: "console", level: "info", message, args: [] },
		})),
	},
});

function debug(
	url = "https://storage.example.test/archive?signature=temporary",
	bytes = 100,
) {
	return Response.json({
		artifacts: [
			{
				id: "archive-1",
				role: "session_archive",
				uploadStatus: "uploaded",
				bytes,
				readUrl: { url },
			},
		],
	});
}

async function setup(
	respond: (
		url: URL,
		init: RequestInit | undefined,
	) => Response | Promise<Response>,
	configuration = config,
) {
	const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
	const fetcher = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = new URL(input instanceof Request ? input.url : input);
		requests.push({ url, init });
		return respond(url, init);
	}) as typeof fetch;
	const server = new McpServer({ name: "artifact-test", version: "1" });
	registerArtifactTools(
		server,
		new JittleLampClient(configuration, fetcher),
		fetcher,
	);
	const client = new Client({ name: "artifact-test-client", version: "1" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	sessions.push({ client, server });
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return { client, requests };
}

describe("MCP artifact tools", () => {
	test("pages validated events and keeps the AI token off storage requests", async () => {
		const { client, requests } = await setup((url) =>
			url.hostname === "api.example.test" ? debug() : Response.json(archive()),
		);
		const result = await client.callTool({
			name: "read_evidence_events",
			arguments: {
				evidenceId: "evidence-1",
				section: "console",
				offset: 1,
				limit: 1,
			},
		});
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toMatchObject({
			total: 3,
			offset: 1,
			returned: 1,
			nextOffset: 2,
			entries: [{ payload: { message: "second" } }],
		});
		expect(requests).toHaveLength(2);
		expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
			`Bearer ${config.token}`,
		);
		expect(new Headers(requests[1]?.init?.headers).has("authorization")).toBe(
			false,
		);
		expect(requests[1]?.init).toMatchObject({
			redirect: "error",
			credentials: "omit",
		});
	});

	test("reports previews and page truncation while redacting configured token", async () => {
		const content = archive(
			Array.from({ length: 12 }, () => `${config.token}${"x".repeat(20_000)}`),
		);
		const { client } = await setup((url) =>
			url.hostname === "api.example.test" ? debug() : Response.json(content),
		);
		const result = await client.callTool({
			name: "read_evidence_events",
			arguments: { evidenceId: "evidence-1", section: "console", limit: 12 },
		});
		const data = result.structuredContent as {
			returned: number;
			nextOffset: number;
			entries: Array<{ truncated: boolean; jsonPreview: string }>;
			truncation: { pageSizeLimited: boolean; eventPreviews: number };
		};
		expect(data.returned).toBeGreaterThan(0);
		expect(data.returned).toBeLessThan(12);
		expect(data.nextOffset).toBe(data.returned);
		expect(data.truncation).toEqual(
			expect.objectContaining({
				pageSizeLimited: true,
				eventPreviews: data.returned,
			}),
		);
		expect(data.entries[0]?.truncated).toBe(true);
		expect(JSON.stringify(result)).not.toContain(config.token);
		expect(JSON.stringify(result.structuredContent).length).toBeLessThan(
			65_536,
		);
	});

	test("does not fetch artifacts when the API denies access", async () => {
		const { client, requests } = await setup(() =>
			Response.json({ error: { code: "EVIDENCE_NOT_FOUND" } }, { status: 404 }),
		);
		const result = await client.callTool({
			name: "read_evidence_events",
			arguments: { evidenceId: "evidence-1", section: "actions" },
		});
		expect(result.isError).toBe(true);
		expect(requests).toHaveLength(1);
	});

	test("rejects invalid archives without inferring events", async () => {
		const { client } = await setup((url) =>
			url.hostname === "api.example.test"
				? debug()
				: Response.json({
						sections: { console: [{ message: "not an archive" }] },
					}),
		);
		const result = await client.callTool({
			name: "read_evidence_events",
			arguments: { evidenceId: "evidence-1", section: "console" },
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({
			error:
				"The artifact is not a valid Jittle Lamp session archive. No events were inferred.",
		});
	});

	test("rejects non-HTTPS signed URLs outside configured local development", async () => {
		const { client, requests } = await setup(() =>
			debug("http://127.0.0.1/private"),
		);
		const result = await client.callTool({
			name: "read_evidence_events",
			arguments: { evidenceId: "evidence-1", section: "actions" },
		});
		expect(result.isError).toBe(true);
		expect(requests).toHaveLength(1);
	});

	test("rejects redirected storage responses without disclosing URLs or tokens", async () => {
		const { client } = await setup((url) =>
			url.hostname === "api.example.test"
				? debug()
				: new Response(null, {
						status: 302,
						headers: { location: `https://elsewhere.test/${config.token}` },
					}),
		);
		const result = await client.callTool({
			name: "read_evidence_events",
			arguments: { evidenceId: "evidence-1", section: "actions" },
		});
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).not.toContain(config.token);
		expect(JSON.stringify(result)).not.toContain("storage.example.test");
	});

	test("bounds streaming archives even without Content-Length", async () => {
		let cancelled = false;
		const { client } = await setup((url) => {
			if (url.hostname === "api.example.test") return debug();
			return new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.enqueue(new Uint8Array(4 * 1024 * 1024));
					},
					cancel() {
						cancelled = true;
					},
				}),
			);
		});
		const result = await client.callTool({
			name: "read_evidence_events",
			arguments: { evidenceId: "evidence-1", section: "actions" },
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({
			error: "Artifact exceeds the 20 MB download limit.",
		});
		expect(cancelled).toBe(true);
	});

	test("writes downloads exclusively and preserves existing files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "jl-mcp-artifact-"));
		directories.push(directory);
		const outputPath = join(directory, "recording.webm");
		const payload = Uint8Array.from([1, 2, 3, 4]);
		const { client, requests } = await setup((url) =>
			url.hostname === "api.example.test"
				? Response.json({ url: "https://storage.example.test/recording" })
				: new Response(payload),
		);
		const args = {
			evidenceId: "evidence-1",
			artifactId: "recording-1",
			outputPath,
		};
		const result = await client.callTool({
			name: "download_evidence_artifact",
			arguments: args,
		});
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toMatchObject({ bytes: 4, outputPath });
		expect(await readFile(outputPath)).toEqual(Buffer.from(payload));
		expect(new Headers(requests[1]?.init?.headers).has("authorization")).toBe(
			false,
		);
		await writeFile(outputPath, "keep existing content");
		const repeated = await client.callTool({
			name: "download_evidence_artifact",
			arguments: args,
		});
		expect(repeated.isError).toBe(true);
		expect(await readFile(outputPath, "utf8")).toBe("keep existing content");
	});

	test("allows storage on loopback HTTP only in configured loopback development", async () => {
		const configuration = { ...config, apiOrigin: "http://localhost:3000" };
		const { client } = await setup(
			(url) =>
				url.port === "3000"
					? debug("http://localhost:9000/archive")
					: Response.json(archive()),
			configuration,
		);
		const result = await client.callTool({
			name: "read_evidence_events",
			arguments: { evidenceId: "evidence-1", section: "console" },
		});
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toMatchObject({
			total: 3,
			returned: 3,
			nextOffset: null,
		});
	});

	test("rejects traversal IDs and arbitrary URL arguments before requests", async () => {
		const { client, requests } = await setup(() => {
			throw new Error("Should not fetch");
		});
		for (const args of [
			{ evidenceId: "../orgs", section: "actions" },
			{
				evidenceId: "evidence-1",
				section: "actions",
				url: "https://elsewhere.test/private",
			},
		]) {
			const result = await client.callTool({
				name: "read_evidence_events",
				arguments: args,
			});
			expect(result.isError).toBe(true);
		}
		expect(requests).toHaveLength(0);
	});
});
