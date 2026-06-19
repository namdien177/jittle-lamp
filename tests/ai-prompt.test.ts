import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	cacheAiAccessTokenSecret,
	clearCachedAiAccessTokenSecret,
	clearCachedInactiveAiAccessTokenSecrets,
	readCachedActivePermanentAiAccessTokenSecret,
	readCachedAiAccessTokenSecret,
} from "../apps/evidence-web/src/ai-prompt";

const tokenIds = ["older-active", "newer-missing", "revoked", "expired"];

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

	test("reuses any cached active permanent token secret", () => {
		cacheAiAccessTokenSecret("older-active", "jl_ai_cached_secret");

		const token = readCachedActivePermanentAiAccessTokenSecret(
			[
				{
					id: "newer-missing",
					createdAt: 300,
					expiresAt: null,
					revokedAt: null,
				},
				{
					id: "older-active",
					createdAt: 200,
					expiresAt: null,
					revokedAt: null,
				},
			],
			1_000,
		);

		expect(token).toBe("jl_ai_cached_secret");
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
