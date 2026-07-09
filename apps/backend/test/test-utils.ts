import { expect } from "bun:test";
import { fileURLToPath } from "node:url";
import {
	createSessionArchive,
	createSessionDraft,
	recordingFileName,
	sessionArchiveFileName,
} from "@jittle-lamp/shared";
import { migrate } from "drizzle-orm/libsql/migrator";
import { strToU8, zipSync } from "fflate";
import { exportSPKI, generateKeyPair } from "jose";

import { createDb } from "../src/db";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export const applyMigrations = async (databaseUrl: string) => {
	const db = createDb(databaseUrl);
	if (!db) {
		throw new Error("Database was not created");
	}

	await migrate(db, { migrationsFolder });
};

export const sha256Hex = async (value: string): Promise<string> => {
	const payload = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", payload);
	return Array.from(new Uint8Array(digest))
		.map((part) => part.toString(16).padStart(2, "0"))
		.join("");
};

export const createAutomationEvidenceZip = (
	sessionId = "jl_automation_upload_001",
) => {
	const now = new Date("2024-06-01T12:00:00.000Z");
	const draft = createSessionDraft({
		page: { title: "Automation Upload", url: "https://example.com" },
		now,
	});
	const archive = createSessionArchive({
		...draft,
		sessionId,
		name: "Automation Upload",
		phase: "ready",
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		events: [
			{
				at: now.toISOString(),
				payload: {
					kind: "lifecycle",
					phase: "ready",
					detail: "Automation test completed.",
				},
			},
		],
	});

	return zipSync({
		[sessionArchiveFileName]: strToU8(JSON.stringify(archive)),
		[recordingFileName]: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
	});
};

export const bytesBody = (bytes: Uint8Array): ArrayBuffer =>
	Uint8Array.from(bytes).buffer;

type AuthFixture = {
	privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
	jwtKey: string;
};

export const TEST_APP_SECRET = "123456789012345678901234";

let authFixturePromise: Promise<AuthFixture> | null = null;
export const getAuthFixture = async (): Promise<AuthFixture> => {
	if (!authFixturePromise) {
		authFixturePromise = (async () => {
			const { privateKey, publicKey } = await generateKeyPair("RS256");
			return {
				privateKey,
				jwtKey: await exportSPKI(publicKey),
			};
		})();
	}

	return authFixturePromise;
};

export const createTestEnv = (
	overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
	NODE_ENV: "development",
	APP_VERSION: "9.9.9",
	APP_SECRET: TEST_APP_SECRET,
	...overrides,
});

export const expectApiError = async (
	response: Response,
	expected: {
		code: string;
		message: string;
		status: number;
	},
) => {
	const payload = (await response.json()) as {
		error: {
			code: string;
			message: string;
			status: number;
			requestId: unknown;
		};
	};

	expect(payload.error.code).toBe(expected.code);
	expect(payload.error.message).toBe(expected.message);
	expect(payload.error.status).toBe(expected.status);
	expect(payload.error.requestId).toBeString();
};
