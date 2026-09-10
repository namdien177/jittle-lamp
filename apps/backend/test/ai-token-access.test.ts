import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";

import { createApp } from "../src/app";
import { createDb } from "../src/db";
import { aiAccessTokens } from "../src/db/schema";
import { ensureUserAndPersonalOrganization } from "../src/services/user-provisioning";
import { applyMigrations, createTestEnv, getAuthFixture } from "./test-utils";

describe("AI token access selection", () => {
	it("requires explicit MCP access and preserves evidence debug defaults", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);
		const db = createDb(databaseUrl);
		if (!db) throw new Error("Database was not created");
		const clerkUserId = `user_ai_token_access_${crypto.randomUUID()}`;
		const account = await ensureUserAndPersonalOrganization(db, {
			clerkUserId,
			source: "clerk-callback",
			rawPayload: { userId: clerkUserId },
		});
		const { privateKey, jwtKey } = await getAuthFixture();
		const clerkToken = await new SignJWT({})
			.setProtectedHeader({ alg: "RS256" })
			.setSubject(clerkUserId)
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		const { app } = createApp(
			createTestEnv({
				DATABASE_URL: databaseUrl,
				CLERK_JWT_KEY: jwtKey,
				CLERK_AUDIENCE: "test-audience",
			}),
		);

		for (const testCase of [
			{ body: {}, scopes: ["evidence:debug"], label: "AI evidence debugger" },
			{
				body: { access: "debug" },
				scopes: ["evidence:debug"],
				label: "AI evidence debugger",
			},
			{
				body: { access: "mcp" },
				scopes: ["evidence:debug", "mcp"],
				label: "AI MCP client",
			},
		]) {
			const response = await app.handle(
				new Request("http://localhost/ai/access-tokens", {
					method: "POST",
					headers: {
						authorization: `Bearer ${clerkToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(testCase.body),
				}),
			);
			expect(response.status).toBe(200);
			const payload = (await response.json()) as {
				accessToken: { id: string; scopes: string[]; label: string };
			};
			expect(payload.accessToken.scopes).toEqual(testCase.scopes);
			expect(payload.accessToken.label).toBe(testCase.label);
			const stored = await db.query.aiAccessTokens.findFirst({
				where: eq(aiAccessTokens.id, payload.accessToken.id),
			});
			expect(stored?.userId).toBe(account.userId);
			expect(stored?.scopes).toBe(testCase.scopes.join(" "));
		}

		const invalidResponse = await app.handle(
			new Request("http://localhost/ai/access-tokens", {
				method: "POST",
				headers: {
					authorization: `Bearer ${clerkToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ access: "organization:admin" }),
			}),
		);
		expect(invalidResponse.status).toBe(422);
		expect(
			await db.query.aiAccessTokens.findMany({
				where: eq(aiAccessTokens.userId, account.userId),
			}),
		).toHaveLength(3);
	});
});
