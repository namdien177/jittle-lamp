import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	cacheAiAccessTokenSecret,
	clearCachedAiAccessTokenSecret,
	clearCachedInactiveAiAccessTokenSecrets,
	readCachedActivePermanentAiAccessTokenSecret,
	readCachedAiAccessTokenSecret,
	readVisibleActivePermanentAiDebugTokenSecret,
} from "../apps/evidence-web/src/ai-prompt";

const tokenIds = ["older-active", "newer-missing", "revoked", "expired", "mcp"];

function installLocalStorageStub(): void {
	const values = new Map<string, string>();
	const localStorage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
	};

	Object.defineProperty(globalThis, "window", {
		value: { localStorage },
		configurable: true,
	});
}

describe("AI prompt token cache", () => {
	beforeEach(() => {
		installLocalStorageStub();
	});

	afterEach(() => {
		for (const tokenId of tokenIds) {
			clearCachedAiAccessTokenSecret(tokenId);
		}
	});

	test("reuses a cached active permanent debug token secret", () => {
		cacheAiAccessTokenSecret("older-active", "jl_ai_cached_secret");

		const token = readCachedActivePermanentAiAccessTokenSecret(
			[
				{
					id: "newer-missing",
					scopes: ["evidence:debug"],
					createdAt: 300,
					expiresAt: null,
					revokedAt: null,
				},
				{
					id: "older-active",
					scopes: ["evidence:debug"],
					createdAt: 200,
					expiresAt: null,
					revokedAt: null,
				},
			],
			1_000,
		);

		expect(token).toBe("jl_ai_cached_secret");
	});

	test("never selects an MCP token for visible or cached debug prompt reuse", () => {
		const mcpToken = {
			id: "mcp",
			scopes: ["evidence:debug", "mcp"],
			createdAt: 300,
			expiresAt: null,
			revokedAt: null,
			token: "jl_ai_mcp_secret",
		};
		const debugToken = {
			id: "older-active",
			scopes: ["evidence:debug"],
			createdAt: 200,
			expiresAt: null,
			revokedAt: null,
			token: "jl_ai_debug_secret",
		};
		cacheAiAccessTokenSecret(mcpToken.id, mcpToken.token);
		cacheAiAccessTokenSecret(debugToken.id, debugToken.token);

		expect(readVisibleActivePermanentAiDebugTokenSecret([mcpToken], 1_000)).toBeNull();
		expect(readCachedActivePermanentAiAccessTokenSecret([mcpToken], 1_000)).toBeNull();
		expect(
			readVisibleActivePermanentAiDebugTokenSecret([mcpToken, debugToken], 1_000),
		).toBe(debugToken.token);
		expect(
			readCachedActivePermanentAiAccessTokenSecret([mcpToken, debugToken], 1_000),
		).toBe(debugToken.token);
	});

	test("visible debug selection skips missing, revoked, and temporary secrets", () => {
		const debugToken = {
			id: "older-active",
			scopes: ["evidence:debug"],
			createdAt: 100,
			expiresAt: null,
			revokedAt: null,
			token: "jl_ai_visible_secret",
		};
		expect(readVisibleActivePermanentAiDebugTokenSecret([
			{ ...debugToken, id: "newer-missing", createdAt: 400, token: null },
			{ ...debugToken, id: "revoked", createdAt: 300, revokedAt: 900 },
			{ ...debugToken, id: "temporary", createdAt: 200, expiresAt: 2_000 },
			debugToken,
		], 1_000)).toBe(debugToken.token);
	});

	test("clears cached secrets for revoked and expired token rows", () => {
		cacheAiAccessTokenSecret("revoked", "jl_ai_revoked_secret");
		cacheAiAccessTokenSecret("expired", "jl_ai_expired_secret");

		clearCachedInactiveAiAccessTokenSecrets(
			[
				{
					id: "revoked",
					createdAt: 100,
					expiresAt: null,
					revokedAt: 900,
				},
				{
					id: "expired",
					createdAt: 100,
					expiresAt: 500,
					revokedAt: null,
				},
			],
			1_000,
		);

		expect(readCachedAiAccessTokenSecret("revoked")).toBeNull();
		expect(readCachedAiAccessTokenSecret("expired")).toBeNull();
	});
});
