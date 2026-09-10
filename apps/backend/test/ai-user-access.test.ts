import { describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";

import { createApp } from "../src/app";
import { createDb } from "../src/db";
import {
	aiAccessTokens,
	aiAccessTokenUsageLogs,
	evidences,
	organizationMembers,
	provisioningEvents,
} from "../src/db/schema";
import {
	AI_ACCESS_TOKEN_SCOPE,
	AI_MCP_TOKEN_SCOPE,
	createAiAccessToken,
	revokeAiAccessToken,
} from "../src/services/ai-access-tokens";
import {
	isAiUserRouteAllowed,
	verifyAiUserAccess,
} from "../src/services/ai-user-access";
import {
	approveDesktopAuthFlow,
	pollDesktopAuthFlow,
	startDesktopAuthFlow,
} from "../src/services/desktop-auth";
import { ensureUserAndPersonalOrganization } from "../src/services/user-provisioning";
import { applyMigrations, createTestEnv, TEST_APP_SECRET } from "./test-utils";

const fixture = async (deviceAuth = false) => {
	const databaseUrl = `file:/tmp/jittle-lamp-ai-user-${crypto.randomUUID()}.db`;
	await applyMigrations(databaseUrl);
	const db = createDb(databaseUrl);
	if (!db) throw new Error("Expected database");
	const clerkUserId = `user_ai_${crypto.randomUUID()}`;
	const owner = await ensureUserAndPersonalOrganization(db, {
		clerkUserId,
		source: "clerk-callback",
		rawPayload: {},
	});
	const { token, accessToken } = await createAiAccessToken(db, {
		userId: owner.userId,
		label: "MCP test",
		expiresAt: null,
		scopes: [AI_ACCESS_TOKEN_SCOPE, AI_MCP_TOKEN_SCOPE],
	});
	const { app, runtime } = createApp(
		createTestEnv({
			DATABASE_URL: databaseUrl,
			APP_SECRET: deviceAuth ? TEST_APP_SECRET : undefined,
		}),
	);
	const request = (path: string, method = "GET", body?: unknown) =>
		new Request(`http://localhost${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return { app, db, owner, clerkUserId, runtime, token, accessToken, request };
};

describe("AI user access", () => {
	it("allows evidence work and navigation while excluding settings and credentials", () => {
		for (const [method, path] of [
			["GET", "/protected/me"],
			["GET", "/orgs"],
			["POST", "/orgs/org-1/select-active"],
			["GET", "/evidences/tags"],
			["PATCH", "/evidences/evidence-1/tags"],
			["POST", "/evidences/evidence-1/comments"],
			["POST", "/evidences/evidence-1/share-links"],
			["POST", "/evidences/bulk-delete"],
			["PUT", "/evidences/uploads/upload-1/blob"],
			["POST", "/automation/evidences/zip"],
		] as const) {
			expect(isAiUserRouteAllowed(method, path)).toBe(true);
		}
		for (const [method, path] of [
			["POST", "/orgs"],
			["PATCH", "/orgs/org-1/settings"],
			["GET", "/orgs/org-1/members"],
			["PATCH", "/orgs/org-1/roles/admin"],
			["POST", "/orgs/org-1/invitations"],
			["GET", "/orgs/org-1/activity"],
			["POST", "/orgs/org-1/leave"],
			["POST", "/evidences/tags"],
			["PATCH", "/evidences/tags"],
			["DELETE", "/evidences/tags/"],
			["PATCH", "/evidences/tags/tag-1"],
			["DELETE", "/evidences/tags/tag-1"],
			["GET", "/ai/access-tokens"],
			["POST", "/ai/access-tokens"],
			["GET", "/automation/api-tokens"],
			["POST", "/desktop-auth/flows/complete"],
			["POST", "/extension-auth/flows/complete"],
			["GET", "/orgs/org-1/migrations"],
			["POST", "/evidences/new-admin-action"],
			["GET", "/orgs/org-1%2fsettings"],
		] as const) {
			expect(isAiUserRouteAllowed(method, path)).toBe(false);
		}
	});

	it("preserves debug-only tokens and rejects missing, revoked, and expired tokens", async () => {
		const { db, owner, token, accessToken, request } = await fixture();
		const debug = await createAiAccessToken(db, {
			userId: owner.userId,
			label: "Existing debugger",
			expiresAt: null,
		});
		const debugAccess = await verifyAiUserAccess(
			db,
			new Request("http://localhost/evidences", {
				headers: { authorization: `Bearer ${debug.token}` },
			}),
		);
		expect(debugAccess).toMatchObject({
			ok: false,
			status: 403,
			code: "AI_AUTH_INSUFFICIENT_SCOPE",
		});
		expect(
			await verifyAiUserAccess(db, new Request("http://localhost/evidences")),
		).toMatchObject({ ok: false, status: 401 });
		expect(
			await verifyAiUserAccess(
				db,
				new Request("http://localhost/evidences", {
					headers: { cookie: `__session=${token}` },
				}),
			),
		).toMatchObject({ ok: false, status: 401 });
		await db
			.update(aiAccessTokens)
			.set({ expiresAt: Date.now() - 1 })
			.where(eq(aiAccessTokens.id, accessToken.id));
		expect(await verifyAiUserAccess(db, request("/evidences"))).toMatchObject({
			ok: false,
			status: 401,
		});
		await db
			.update(aiAccessTokens)
			.set({ expiresAt: null })
			.where(eq(aiAccessTokens.id, accessToken.id));
		await revokeAiAccessToken(db, {
			tokenId: accessToken.id,
			userId: owner.userId,
		});
		expect(await verifyAiUserAccess(db, request("/evidences"))).toMatchObject({
			ok: false,
			status: 401,
		});
	});

	it("uses the token owner without Clerk configuration or provisioning and audits calls", async () => {
		const { app, db, owner, accessToken, request } = await fixture();
		const before = await db.query.provisioningEvents.findMany();
		const response = await app.handle(request("/protected/me"));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			localUserId: owner.userId,
			activeOrgId: owner.organizationId,
		});
		for (const path of [
			"/ai/access-tokens",
			"/automation/api-tokens",
			`/orgs/${owner.organizationId}/members`,
		]) {
			const denied = await app.handle(request(path));
			expect(denied.status).toBe(403);
			expect(await denied.json()).toMatchObject({
				error: { code: "AI_ACTION_FORBIDDEN" },
			});
		}
		expect(await db.select().from(provisioningEvents)).toHaveLength(
			before.length,
		);
		const usage = await db.query.aiAccessTokenUsageLogs.findMany({
			where: eq(aiAccessTokenUsageLogs.tokenId, accessToken.id),
		});
		expect(usage).toHaveLength(4);
		expect(usage.every((entry) => entry.userId === owner.userId)).toBe(true);
	});

	it("prevents an extension session from issuing, reading, or revoking AI credentials", async () => {
		const { app, db, clerkUserId, runtime, accessToken, token } =
			await fixture(true);
		const flow = await startDesktopAuthFlow(db, runtime, "extension");
		await approveDesktopAuthFlow(db, runtime, {
			userCode: flow.userCode,
			clerkUserId,
		});
		const extension = await pollDesktopAuthFlow(db, runtime, flow.deviceCode);
		if (extension.status !== "approved")
			throw new Error("Expected extension session");
		for (const [method, path, body] of [
			["POST", "/ai/access-tokens", { access: "mcp" }],
			["GET", "/ai/access-tokens", undefined],
			["DELETE", `/ai/access-tokens/${accessToken.id}`, undefined],
		] as const) {
			const response = await app.handle(
				new Request(`http://localhost${path}`, {
					method,
					headers: {
						authorization: `Bearer ${extension.accessToken}`,
						...(body ? { "content-type": "application/json" } : {}),
					},
					...(body ? { body: JSON.stringify(body) } : {}),
				}),
			);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				error: { code: "AI_TOKEN_HUMAN_SESSION_REQUIRED" },
			});
		}
		const credentials = await db.query.aiAccessTokens.findMany();
		expect(credentials).toHaveLength(1);
		expect(credentials[0]).toMatchObject({
			id: accessToken.id,
			tokenSecret: token,
			revokedAt: null,
		});
	});

	it("keeps tenant and current membership permissions on ordinary evidence routes", async () => {
		const { app, db, owner, request } = await fixture();
		const outsider = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: `user_outsider_${crypto.randomUUID()}`,
			source: "clerk-callback",
			rawPayload: {},
		});
		const [ownedEvidence, otherEvidence] = await db
			.insert(evidences)
			.values(
				[owner, outsider].map((user) => ({
					orgId: user.organizationId,
					createdBy: user.userId,
					title: "Original title",
					sourceType: "browser",
					scopeType: "organization" as const,
					scopeId: user.organizationId,
				})),
			)
			.returning({ id: evidences.id });
		if (!ownedEvidence || !otherEvidence) throw new Error("Expected evidence");
		const renamed = await app.handle(
			request(`/evidences/${ownedEvidence.id}`, "PATCH", {
				title: "MCP title",
			}),
		);
		expect(renamed.status).toBe(200);
		expect(
			await db.query.evidences.findFirst({
				where: eq(evidences.id, ownedEvidence.id),
			}),
		).toMatchObject({ title: "MCP title", createdBy: owner.userId });
		expect(
			(await app.handle(request(`/evidences/${otherEvidence.id}`))).status,
		).toBe(404);
		await db
			.delete(organizationMembers)
			.where(
				and(
					eq(organizationMembers.organizationId, owner.organizationId),
					eq(organizationMembers.userId, owner.userId),
				),
			);
		const denied = await app.handle(
			request(`/evidences/${ownedEvidence.id}`, "PATCH", {
				title: "Denied title",
			}),
		);
		expect(denied.status).toBe(404);
		expect(
			await db.query.evidences.findFirst({
				where: eq(evidences.id, ownedEvidence.id),
			}),
		).toMatchObject({ title: "MCP title" });
	});
});
