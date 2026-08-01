import { describe, expect, it } from "bun:test";
import {
	canonicalHash,
	canonicalJson,
	emptyMigrationProgress,
	migrationDiscoverySchema,
	migrationProgressSchema,
	orderedManifestHash,
} from "@jittle-lamp/shared";
import { parseEnv } from "../src/config/env";
import { buildRuntimeConfig } from "../src/config/runtime";
import {
	createMigrationCryptography,
	createMigrationPassphrase,
	isRestrictedMigrationAddress,
	redactMigrationLogValue,
	validateMigrationTargetOrigin,
} from "../src/services/migration-security";

describe("migration protocol", () => {
	it("canonicalizes nested records independent of key insertion order", async () => {
		const left = { z: 1, nested: { b: true, a: "same" }, skip: undefined };
		const right = { nested: { a: "same", b: true }, z: 1 };
		expect(canonicalJson(left)).toBe(canonicalJson(right));
		expect(await canonicalHash(left)).toBe(await canonicalHash(right));
	});

	it("roots manifests in stable source identity order", async () => {
		const a = {
			kind: "record" as const,
			entityType: "evidence",
			sourceId: "a",
			contentHash: "a".repeat(64),
		};
		const b = { ...a, sourceId: "b", contentHash: "b".repeat(64) };
		expect(await orderedManifestHash([b, a])).toBe(
			await orderedManifestHash([a, b]),
		);
	});

	it("publishes strict discovery and progress contracts", () => {
		expect(
			migrationDiscoverySchema.parse({
				product: "jittle-lamp",
				instanceId: crypto.randomUUID(),
				applicationVersion: "1.7.3",
				protocolVersion: "1.0",
				features: ["resumable-import"],
				apiOrigin: "https://api.example.test",
				webOrigin: "https://example.test",
				limits: { maxRecordsPerPage: 100, maxArtifactBytes: 1024 },
			}),
		).toBeDefined();
		expect(
			migrationProgressSchema.parse(emptyMigrationProgress()),
		).toBeDefined();
	});

	it("encrypts stored credentials with authenticated encryption", async () => {
		const cryptography = createMigrationCryptography();
		const encrypted = await cryptography.encrypt("an app secret", "link-token");
		expect(encrypted).not.toContain("link-token");
		expect(await cryptography.decrypt("an app secret", encrypted)).toBe(
			"link-token",
		);
		await expect(
			cryptography.decrypt("the wrong app secret", encrypted),
		).rejects.toThrow();
		expect(createMigrationPassphrase(cryptography)).toMatch(
			/^jl_mig_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/,
		);
	});

	it("rejects unsafe peer origins after DNS resolution", async () => {
		await expect(
			validateMigrationTargetOrigin({
				origin: "https://metadata.example.test",
				nodeEnv: "production",
				resolve: async () => ["169.254.169.254"],
			}),
		).rejects.toThrow("restricted");
		await expect(
			validateMigrationTargetOrigin({
				origin: "https://user:password@example.test/path?token=x",
				nodeEnv: "production",
			}),
		).rejects.toThrow("origin without credentials");
		expect(isRestrictedMigrationAddress("10.1.2.3")).toBeTrue();
		expect(isRestrictedMigrationAddress("8.8.8.8")).toBeFalse();
	});

	it("allows admin-entered private hosts while keeping hard network blocks", async () => {
		expect(
			await validateMigrationTargetOrigin({
				origin: "https://migration.internal",
				nodeEnv: "production",
				allowPrivateNetworks: true,
				resolve: async () => ["10.2.3.4"],
			}),
		).toBe("https://migration.internal");
		await expect(
			validateMigrationTargetOrigin({
				origin: "https://metadata.internal",
				nodeEnv: "production",
				allowPrivateNetworks: true,
				resolve: async () => ["169.254.169.254"],
			}),
		).rejects.toThrow("restricted");
		expect(
			redactMigrationLogValue({ linkId: "ok", nested: { sessionToken: "no" } }),
		).toEqual({ linkId: "ok", nested: { sessionToken: "[REDACTED]" } });
	});

	it("bounds worker concurrency", () => {
		const runtime = buildRuntimeConfig(
			parseEnv({
				NODE_ENV: "development",
				MIGRATION_WORKER_CONCURRENCY: "4",
			}),
		);
		expect(runtime.migrationWorkerConcurrency).toBe(4);
		expect(() => parseEnv({ MIGRATION_WORKER_CONCURRENCY: "5" })).toThrow();
	});
});
