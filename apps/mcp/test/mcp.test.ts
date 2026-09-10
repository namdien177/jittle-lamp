import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { eq } from "drizzle-orm";
import { createApp } from "../../backend/src/app";
import {
	evidenceComments,
	evidences,
	evidenceTagAssignments,
	organizationEvidenceTags,
	organizationMembers,
	organizations,
} from "../../backend/src/db/schema";
import {
	AI_ACCESS_TOKEN_SCOPE,
	AI_MCP_TOKEN_SCOPE,
	createAiAccessToken,
	revokeAiAccessToken,
} from "../../backend/src/services/ai-access-tokens";
import { createAutomationApiToken } from "../../backend/src/services/automation-api-tokens";
import { ensureUserAndPersonalOrganization } from "../../backend/src/services/user-provisioning";
import {
	applyMigrations,
	createAutomationEvidenceZip,
	createTestEnv,
	sha256Hex,
} from "../../backend/test/test-utils";
import { JittleLampClient, readConfig } from "../src/client";

const required = <T>(value: T | null | undefined): T => {
	if (value === null || value === undefined)
		throw new Error("Missing test fixture");
	return value;
};
type TestData = {
	evidence: { id: string; orgId: string; title: string };
	evidences: { id: string }[];
	artifacts: { checksum: string; uploadStatus: string }[];
	shareLink: { id: string; slug: string };
	evidenceUrl: string;
	uploadId: string;
	evidenceId: string;
	status: string | number;
	error: { code: string; message: string; status: number };
	tokenGuidance?: string;
};

describe("local Jittle Lamp MCP", () => {
	let directory: string;
	let backend: ReturnType<typeof createApp>;
	let db: NonNullable<ReturnType<typeof createApp>["db"]>;
	let client: Client;
	let automationClient: Client;
	let transport: StdioClientTransport;
	let user: { userId: string; organizationId: string };
	let outsider: { userId: string; organizationId: string };
	let token: string;
	let tokenId: string;
	let automationToken: string;
	let automationTokenId: string;
	let apiOrigin: string;
	let stderr = "";

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "jl-mcp-test-"));
		const databaseUrl = `file:${join(directory, "data.db")}`;
		await applyMigrations(databaseUrl);
		backend = createApp(
			createTestEnv({ DATABASE_URL: databaseUrl, LOG_LEVEL: "silent" }),
		);
		db = required(backend.db);
		user = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "mcp-owner",
			source: "clerk-callback",
			rawPayload: {},
		});
		outsider = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "mcp-outsider",
			source: "clerk-callback",
			rawPayload: {},
		});
		const issued = await createAiAccessToken(db, {
			userId: user.userId,
			label: "MCP integration",
			expiresAt: null,
			scopes: [AI_ACCESS_TOKEN_SCOPE, AI_MCP_TOKEN_SCOPE],
		});
		token = issued.token;
		tokenId = issued.accessToken.id;
		const automation = await createAutomationApiToken(db, {
			userId: user.userId,
			orgId: user.organizationId,
			label: "MCP automation integration",
			expiresAt: null,
		});
		automationToken = automation.token;
		automationTokenId = automation.apiToken.id;
		backend.app.listen({ hostname: "127.0.0.1", port: 0 });
		apiOrigin = `http://127.0.0.1:${required(backend.app.server).port}`;
		transport = new StdioClientTransport({
			command: process.execPath,
			args: ["run", fileURLToPath(new URL("../src/index.ts", import.meta.url))],
			env: { JL_AI_TOKEN: token, JITTLE_LAMP_API_ORIGIN: apiOrigin },
			stderr: "pipe",
		});
		transport.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		client = new Client({
			name: "jittlelamp-integration-test",
			version: "1.0.0",
		});
		await client.connect(transport);
		const automationTransport = new StdioClientTransport({
			command: process.execPath,
			args: ["run", fileURLToPath(new URL("../src/index.ts", import.meta.url))],
			env: { JL_AI_TOKEN: automationToken, JITTLE_LAMP_API_ORIGIN: apiOrigin },
			stderr: "pipe",
		});
		automationTransport.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		automationClient = new Client({
			name: "jittlelamp-automation-integration-test",
			version: "1.0.0",
		});
		await automationClient.connect(automationTransport);
	});

	afterAll(async () => {
		await client?.close();
		await automationClient?.close();
		await backend?.app.stop();
		await rm(directory, { recursive: true, force: true });
	});

	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args });
		return {
			error: result.isError === true,
			data: result.structuredContent as unknown as TestData,
		};
	};
	const callAutomation = async (
		name: string,
		args: Record<string, unknown> = {},
	) => {
		const result = await automationClient.callTool({ name, arguments: args });
		return {
			error: result.isError === true,
			data: result.structuredContent as unknown as TestData,
		};
	};
	const createEvidence = async (owner = user) => {
		const [row] = await db
			.insert(evidences)
			.values({
				orgId: owner.organizationId,
				createdBy: owner.userId,
				title: "Original title",
				sourceType: "browser",
			})
			.returning();
		return required(row);
	};

	it("negotiates stdio, lists explicit tools, and resolves the configured owner", async () => {
		const tools = (await client.listTools()).tools;
		expect(tools.map((tool) => tool.name)).toContain("upload_evidence_zip");
		expect(tools.map((tool) => tool.name)).not.toContain(
			"list_organization_members",
		);
		expect(
			tools.filter((tool) =>
				/settings|access_token|invitation|migration/.test(tool.name),
			),
		).toEqual([]);
		expect(
			tools.find((tool) => tool.name === "delete_evidence")?.annotations
				?.destructiveHint,
		).toBe(true);
		const result = await call("get_context");
		expect(result.error).toBe(false);
		expect(JSON.stringify(result.data)).toContain(user.userId);
		expect(JSON.stringify(result.data)).not.toContain(token);
		expect(stderr).not.toContain(token);
	});

	it("lists, renames, comments, assigns existing tags and shares as the token owner", async () => {
		const evidence = await createEvidence();
		expect(
			(
				await call("list_evidences", {
					orgId: user.organizationId,
					search: evidence.id,
				})
			).data.evidences[0]?.id,
		).toBe(evidence.id);
		expect(
			(
				await call("rename_evidence", {
					evidenceId: evidence.id,
					title: "MCP renamed",
				})
			).error,
		).toBe(false);
		expect(
			(await call("get_evidence", { evidenceId: evidence.id })).data.evidence
				.title,
		).toBe("MCP renamed");
		expect(
			(
				await call("create_evidence_comment", {
					evidenceId: evidence.id,
					body: "Verified through MCP",
				})
			).error,
		).toBe(false);
		const comments = await db
			.select()
			.from(evidenceComments)
			.where(eq(evidenceComments.evidenceId, evidence.id));
		expect(comments[0]?.createdBy).toBe(user.userId);
		const [tag] = await db
			.insert(organizationEvidenceTags)
			.values({
				orgId: user.organizationId,
				name: "Regression",
				color: "#112233",
			})
			.returning();
		expect(
			(
				await call("set_evidence_tags", {
					evidenceId: evidence.id,
					tagIds: [required(tag).id],
				})
			).error,
		).toBe(false);
		expect(
			(
				await db
					.select()
					.from(evidenceTagAssignments)
					.where(eq(evidenceTagAssignments.evidenceId, evidence.id))
			)[0]?.tagId,
		).toBe(required(tag).id);
		const share = await call("create_share_link", {
			evidenceId: evidence.id,
			expiresInMs: 60000,
		});
		expect(share.error).toBe(false);
		expect(
			(await call("resolve_share_link", { locator: share.data.shareLink.slug }))
				.error,
		).toBe(false);
		expect(
			(
				await call("revoke_share_link", {
					shareLinkId: share.data.shareLink.id,
				})
			).error,
		).toBe(false);
	});

	it("denies foreign evidence and settings even when called directly with the MCP token", async () => {
		const foreign = await createEvidence(outsider);
		expect(
			(
				await call("get_evidence", {
					evidenceId: foreign.id,
					orgId: outsider.organizationId,
				})
			).error,
		).toBe(true);
		expect(
			(
				await call("rename_evidence", {
					evidenceId: foreign.id,
					title: "Forbidden",
				})
			).error,
		).toBe(true);
		expect(
			(await call("get_evidence", { evidenceId: "../../ai/access-tokens" }))
				.error,
		).toBe(true);
		expect(
			(await call("get_evidence", { evidenceId: foreign.id, extra: true }))
				.error,
		).toBe(true);
		for (const [method, path, body] of [
			["GET", "/ai/access-tokens", undefined],
			["GET", `/orgs/${user.organizationId}/roles`, undefined],
			[
				"PATCH",
				`/orgs/${user.organizationId}/settings`,
				{ requireInvitationApproval: false },
			],
			["POST", "/evidences/tags", { name: "Forbidden tag", color: "#112233" }],
		] as const) {
			const result = await backend.app.handle(
				new Request(`${apiOrigin}${path}`, {
					method,
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					...(body ? { body: JSON.stringify(body) } : {}),
				}),
			);
			expect(result.status).toBe(403);
			expect((await result.json()).error.code).toBe("AI_ACTION_FORBIDDEN");
		}
	});

	it("uploads ZIP bytes from disk and preserves destination and actor boundaries", async () => {
		const zipPath = join(directory, "evidence.zip");
		await writeFile(zipPath, createAutomationEvidenceZip());
		const result = await call("upload_evidence_zip", {
			zipPath,
			orgId: user.organizationId,
			title: "Recorded MCP upload",
		});
		expect(result.error).toBe(false);
		expect(result.data.evidence.orgId).toBe(user.organizationId);
		expect(result.data.evidenceUrl).toEndWith(
			`/evidence/${result.data.evidence.id}`,
		);
		const saved = await db.query.evidences.findFirst({
			where: eq(evidences.id, result.data.evidence.id),
		});
		expect(saved?.createdBy).toBe(user.userId);
		expect(JSON.parse(required(required(saved).sourceMetadata)).aiTokenId).toBe(
			tokenId,
		);
		expect(
			JSON.parse(required(required(saved).sourceMetadata)).automationTokenId,
		).toBeUndefined();
		expect(
			(
				await call("get_evidence_debug", {
					evidenceId: required(saved).id,
					includeReadUrls: false,
				})
			).error,
		).toBe(false);
		expect(
			(
				await call("upload_evidence_zip", {
					zipPath,
					orgId: outsider.organizationId,
				})
			).error,
		).toBe(true);
		expect(
			(
				await call("upload_evidence_zip", {
					zipPath: directory,
					orgId: user.organizationId,
				})
			).error,
		).toBe(true);
		await writeFile(zipPath, "invalid zip");
		expect(
			(
				await call("upload_evidence_zip", {
					zipPath,
					orgId: user.organizationId,
				})
			).error,
		).toBe(true);
	});

	it("uses an automation token's assigned organisation for ZIP uploads and denies a foreign destination", async () => {
		const zipPath = join(directory, "automation-evidence.zip");
		await writeFile(zipPath, createAutomationEvidenceZip("jl_mcp_automation"));
		const uploaded = await callAutomation("upload_evidence_zip", {
			zipPath,
			title: "Existing automation token upload",
		});
		expect(uploaded.error).toBe(false);
		expect(uploaded.data.evidence.orgId).toBe(user.organizationId);
		const saved = await db.query.evidences.findFirst({
			where: eq(evidences.id, uploaded.data.evidence.id),
		});
		expect(saved?.createdBy).toBe(user.userId);
		const metadata = JSON.parse(required(required(saved).sourceMetadata));
		expect(metadata.automationTokenId).toBe(automationTokenId);
		expect(metadata.aiTokenId).toBeUndefined();
		const before = await db.select({ id: evidences.id }).from(evidences);
		const denied = await callAutomation("upload_evidence_zip", {
			zipPath,
			orgId: outsider.organizationId,
		});
		expect(denied.error).toBe(true);
		expect(denied.data.status).toBe(403);
		expect(denied.data.error.code).toBe("AUTOMATION_ORG_FORBIDDEN");
		expect(denied.data.tokenGuidance).toBeUndefined();
		expect(await db.select({ id: evidences.id }).from(evidences)).toEqual(
			before,
		);
		expect(JSON.stringify(uploaded)).not.toContain(automationToken);
		expect(stderr).not.toContain(automationToken);
	});

	it("preserves the backend's rejection of automation user access and explains its token permissions", async () => {
		const direct = await backend.app.handle(
			new Request(`${apiOrigin}/protected/me`, {
				headers: { authorization: `Bearer ${automationToken}` },
			}),
		);
		const backendError = (await direct.json()).error;
		const result = await callAutomation("get_context");
		expect([401, 403]).toContain(direct.status);
		expect(result.error).toBe(true);
		expect(result.data.status).toBe(direct.status);
		expect(result.data.error.code).toBe(backendError.code);
		expect(result.data.error.message).toBe(backendError.message);
		expect(result.data.tokenGuidance).toMatch(/automation/i);
		expect(result.data.tokenGuidance).toContain("ZIP");
		expect(result.data.tokenGuidance).toContain("AI token");
		expect(JSON.stringify(result)).not.toContain(automationToken);
	});

	it("copies, moves and deletes evidence using existing user routes", async () => {
		const evidence = await createEvidence();
		const [target] = await db
			.insert(organizations)
			.values({ name: "MCP destination", isPersonal: false })
			.returning();
		await db.insert(organizationMembers).values({
			organizationId: required(target).id,
			userId: user.userId,
			role: "owner",
		});
		const copied = await call("copy_evidence", {
			evidenceId: evidence.id,
			targetOrgId: required(target).id,
		});
		expect(copied.error).toBe(false);
		expect(copied.data.evidence.id).not.toBe(evidence.id);
		expect(
			(
				await call("move_evidence", {
					evidenceId: evidence.id,
					targetOrgId: required(target).id,
				})
			).error,
		).toBe(false);
		expect(
			(await call("delete_evidence", { evidenceId: evidence.id })).error,
		).toBe(false);
		const saved = await db.query.evidences.findFirst({
			where: eq(evidences.id, evidence.id),
		});
		expect(saved?.deletedBy).toBe(user.userId);
		expect(saved?.deletedAt).toBeNumber();
	});

	it("uploads and commits a local artifact without passing bytes or tokens through tool arguments", async () => {
		const content = "Recorded transcript";
		const mimeType = "text/plain";
		const checksum = `sha256:${await sha256Hex(content)}`;
		const filePath = join(directory, "transcript.txt");
		await writeFile(filePath, content);
		const start = await call("start_upload", {
			title: "Local transcript",
			sourceType: "manual-upload",
			artifact: {
				kind: "transcript",
				mimeType,
				bytes: content.length,
				checksum,
			},
		});
		expect(start.error).toBe(false);
		const upload = await call("upload_artifact_file", {
			uploadId: start.data.uploadId,
			filePath,
			mimeType,
		});
		expect(upload.error).toBe(false);
		const complete = await call("complete_upload", {
			uploadId: start.data.uploadId,
			bytes: content.length,
			mimeType,
			checksum,
		});
		expect(complete.error).toBe(false);
		expect(complete.data.status).toBe("committed");
		const artifacts = await call("list_evidence_artifacts", {
			evidenceId: start.data.evidenceId,
		});
		expect(artifacts.data.artifacts[0]?.checksum).toBe(
			await sha256Hex(content),
		);
		expect(artifacts.data.artifacts[0]?.uploadStatus).toBe("uploaded");
	});

	it("honors token revocation on the next call of the same MCP process", async () => {
		await revokeAiAccessToken(db, { tokenId, userId: user.userId });
		const result = await call("get_context");
		expect(result.error).toBe(true);
		expect(result.data.status).toBe(401);
		expect(stderr).not.toContain(token);
	});
});

it("accepts explicit AI or automation credentials and rejects insecure configuration", () => {
	expect(() => readConfig({})).toThrow("JL_AI_TOKEN is required");
	for (const prefix of ["jl_ai_", "jl_api_"]) {
		const token = `${prefix}aaaaaaaaaaaaaaaaaaaaaaaa`;
		expect(readConfig({ JL_AI_TOKEN: ` ${token} ` }).token).toBe(token);
	}
	for (const token of [
		"jl_api_short",
		"jl_ai_short",
		"secret_token",
		"jl_api_bad!",
	]) {
		expect(() => readConfig({ JL_AI_TOKEN: token })).toThrow();
	}
	expect(() =>
		readConfig({
			JL_AI_TOKEN: "jl_ai_aaaaaaaaaaaaaaaaaaaaaaaa",
			JITTLE_LAMP_API_ORIGIN: "http://remote.example",
		}),
	).toThrow();
	expect(() =>
		readConfig({
			JL_AI_TOKEN: "jl_ai_aaaaaaaaaaaaaaaaaaaaaaaa",
			JITTLE_LAMP_API_ORIGIN: "https://example.com/api?token=secret",
		}),
	).toThrow();
});

it("never forwards credentials on redirects or exposes them in errors", async () => {
	const token = "jl_ai_aaaaaaaaaaaaaaaaaaaaaaaa";
	const client = new JittleLampClient(
		readConfig({ JL_AI_TOKEN: token }),
		(async (_url: URL | RequestInfo, init?: RequestInit) => {
			expect(init?.redirect).toBe("error");
			throw new Error(`secret ${token}`);
		}) as unknown as typeof fetch,
	);
	const result = await client.request("GET", "/protected/me");
	expect(result.isError).toBe(true);
	expect(JSON.stringify(result)).not.toContain(token);
	expect((await client.request("GET", "//evil.example")).isError).toBe(true);
});

it("preserves an API proxy path prefix", async () => {
	const config = readConfig({
		JL_AI_TOKEN: "jl_ai_aaaaaaaaaaaaaaaaaaaaaaaa",
		JITTLE_LAMP_API_ORIGIN: "https://jittlelamp.example/api/",
	});
	const client = new JittleLampClient(config, (async (
		url: URL | RequestInfo,
	) => {
		expect(String(url)).toBe("https://jittlelamp.example/api/protected/me");
		return Response.json({ ok: true });
	}) as unknown as typeof fetch);
	expect(
		(await client.request("GET", "/protected/me")).isError,
	).toBeUndefined();
});
