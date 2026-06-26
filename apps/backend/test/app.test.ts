import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import {
	createSessionArchive,
	createSessionDraft,
	recordingFileName,
	sessionArchiveFileName,
} from "@jittle-lamp/shared";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { strToU8, zipSync } from "fflate";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";

import { createApp } from "../src/app";
import { parseEnv } from "../src/config/env";
import { createDb } from "../src/db";
import {
	aiAccessTokens,
	aiAccessTokenUsageLogs,
	automationApiTokens,
	desktopAuthFlows,
	desktopRecordingSessions,
	deviceSessions,
	evidenceArtifacts,
	evidenceComments,
	evidences,
	organizationActivityLogs,
	organizationJoinRequests,
	organizationMembers,
	organizations,
	provisioningEvents,
	shareLinks,
	users,
} from "../src/db/schema";
import {
	cleanupExpiredDeviceAuthState,
	revokeDeviceSession,
} from "../src/services/desktop-auth";
import { cleanupExpiredOrganizationActivityLogs } from "../src/services/organization-activity";
import {
	acceptInvitationByToken,
	createOrganizationInvitationCode,
	reviewOrganizationJoinRequest,
	updateOrganizationRolePermissions,
	updateOrganizationSettings,
} from "../src/services/organization-management";
import {
	ensureUserAndPersonalOrganization,
	retryFailedProvisioning,
} from "../src/services/user-provisioning";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

const applyMigrations = async (databaseUrl: string) => {
	const db = createDb(databaseUrl);
	if (!db) {
		throw new Error("Database was not created");
	}

	await migrate(db, { migrationsFolder });
};

const sha256Hex = async (value: string): Promise<string> => {
	const payload = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", payload);
	return Array.from(new Uint8Array(digest))
		.map((part) => part.toString(16).padStart(2, "0"))
		.join("");
};

const createAutomationEvidenceZip = (
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

const bytesBody = (bytes: Uint8Array): ArrayBuffer =>
	Uint8Array.from(bytes).buffer;

type AuthFixture = {
	privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
	jwtKey: string;
};

const TEST_APP_SECRET = "123456789012345678901234";

let authFixturePromise: Promise<AuthFixture> | null = null;
const getAuthFixture = async (): Promise<AuthFixture> => {
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

const createTestEnv = (
	overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
	NODE_ENV: "development",
	APP_VERSION: "9.9.9",
	APP_SECRET: TEST_APP_SECRET,
	...overrides,
});

const expectApiError = async (
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

describe("env validation", () => {
	it("requires APP_SECRET in production", () => {
		expect(() =>
			parseEnv({
				NODE_ENV: "production",
				PORT: "3001",
				HOST: "127.0.0.1",
				APP_VERSION: "1.0.0",
			}),
		).toThrow();
	});

	it("accepts local env without APP_SECRET", () => {
		expect(() =>
			parseEnv({
				NODE_ENV: "local",
				PORT: "3001",
				HOST: "127.0.0.1",
				APP_VERSION: "1.0.0",
			}),
		).not.toThrow();
	});

	it("requires full Clerk request-auth config in staging", () => {
		expect(() =>
			parseEnv({
				NODE_ENV: "staging",
				PORT: "3001",
				HOST: "127.0.0.1",
				APP_VERSION: "1.0.0",
				APP_SECRET: TEST_APP_SECRET,
				CLERK_SECRET_KEY: "sk_test_example",
			}),
		).toThrow();
	});

	it("requires Turso auth token for remote libsql URLs", () => {
		expect(() =>
			parseEnv({
				NODE_ENV: "development",
				PORT: "3001",
				HOST: "127.0.0.1",
				APP_VERSION: "1.0.0",
				APP_SECRET: TEST_APP_SECRET,
				DATABASE_URL: "libsql://example.turso.io",
			}),
		).toThrow();
	});
});

describe("routes", () => {
	it("emits x-request-id header on 404 responses", async () => {
		const { app } = createApp(createTestEnv());

		const response = await app.handle(
			new Request("http://localhost/does-not-exist"),
		);

		expect(response.status).toBe(404);
		expect(response.headers.get("x-request-id")).toBeString();
	});

	it("returns version payload", async () => {
		const { app } = createApp(createTestEnv());

		const response = await app.handle(new Request("http://localhost/version"));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			version: "9.9.9",
			env: "development",
		});
	});

	it("serves OpenAPI JSON in development", async () => {
		const { app } = createApp(createTestEnv());

		const response = await app.handle(
			new Request("http://localhost/docs/json"),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			info: { version: string };
			paths: Record<string, unknown>;
		};
		expect(payload.info.version).toBe("9.9.9");
		expect(payload.paths["/protected/me"]).toBeDefined();
	});

	it("blocks protected routes without an auth token", async () => {
		const { app } = createApp(createTestEnv());

		const response = await app.handle(
			new Request("http://localhost/protected/me"),
		);

		expect(response.status).toBe(401);
		await expectApiError(response, {
			code: "AUTH_UNAUTHENTICATED",
			message: "Authentication required",
			status: 401,
		});
	});

	it("rejects invalid auth tokens", async () => {
		const { app } = createApp(
			createTestEnv({
				CLERK_JWT_KEY:
					"-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----",
			}),
		);

		const response = await app.handle(
			new Request("http://localhost/protected/me", {
				headers: { authorization: "Bearer invalid-token" },
			}),
		);

		expect(response.status).toBe(401);
		await expectApiError(response, {
			code: "AUTH_INVALID_TOKEN",
			message: "Invalid or expired auth token",
			status: 401,
		});
	});

	it("injects auth context for authenticated requests", async () => {
		const { privateKey, jwtKey } = await getAuthFixture();
		const token = await new SignJWT({ org_id: "org_123", scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_123")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp(
			createTestEnv({
				CLERK_JWT_KEY: jwtKey,
				CLERK_AUDIENCE: "test-audience",
			}),
		);

		const response = await app.handle(
			new Request("http://localhost/protected/me", {
				headers: { authorization: `Bearer ${token}` },
			}),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			userId: string;
			orgId: string;
			activeOrgId: string | null;
			roles: string[];
			scopes: string[];
		};
		expect(payload).toMatchObject({
			userId: "user_123",
			orgId: "org_123",
			roles: [],
			scopes: ["read", "write"],
		});
		expect(
			payload.activeOrgId === null || typeof payload.activeOrgId === "string",
		).toBeTrue();
	});

	it("normalizes Clerk authorized party origins for auth checks", async () => {
		const { privateKey, jwtKey } = await getAuthFixture();
		const token = await new SignJWT({
			azp: "https://viewer.example.test",
			scope: "read write",
		})
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_authorized_party")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp(
			createTestEnv({
				CLERK_JWT_KEY: jwtKey,
				CLERK_AUTHORIZED_PARTIES: "https://viewer.example.test/",
			}),
		);

		const response = await app.handle(
			new Request("http://localhost/protected/me", {
				headers: { authorization: `Bearer ${token}` },
			}),
		);

		expect(response.status).toBe(200);
		expect((await response.json()) as { userId: string }).toMatchObject({
			userId: "user_authorized_party",
		});
	});

	it("returns profile and member organizations for the authenticated user", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const provisioned = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_settings_profile",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_settings_profile" },
		});

		const [teamOrganization] = await db
			.insert(organizations)
			.values({ name: "Team Settings", isPersonal: false })
			.returning({ id: organizations.id });
		if (!teamOrganization) {
			throw new Error("Failed to create team organization");
		}

		await db.insert(organizationMembers).values({
			organizationId: teamOrganization.id,
			userId: provisioned.userId,
			role: "developer",
		});
		await db
			.update(users)
			.set({ activeOrgId: teamOrganization.id, updatedAt: Date.now() })
			.where(eq(users.id, provisioned.userId));

		const { privateKey, jwtKey } = await getAuthFixture();
		const token = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_settings_profile")
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

		const response = await app.handle(
			new Request("http://localhost/protected/me", {
				headers: { authorization: `Bearer ${token}` },
			}),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			userId: string;
			localUserId: string | null;
			user: { displayName: string; email: string | null };
			activeOrgId: string | null;
			organizations: Array<{
				id: string;
				name: string;
				role: string;
				isPersonal: boolean;
				isActive: boolean;
			}>;
		};
		expect(payload.userId).toBe("user_clerk_settings_profile");
		expect(payload.localUserId).toBe(provisioned.userId);
		expect(payload.user).toMatchObject({
			displayName: "user_clerk_settings_profile",
			email: null,
		});
		expect(payload.activeOrgId).toBe(teamOrganization.id);
		expect(payload.organizations).toContainEqual({
			id: provisioned.organizationId,
			name: "My Space",
			role: "admin",
			isPersonal: true,
			isActive: false,
		});
		expect(payload.organizations).toContainEqual({
			id: teamOrganization.id,
			name: "Team Settings",
			role: "developer",
			isPersonal: false,
			isActive: true,
		});
	});

	it("allows CORS preflight for the configured web origin", async () => {
		const { app } = createApp(
			createTestEnv({
				WEB_APP_ORIGIN: "https://viewer.example.test/",
			}),
		);

		const response = await app.handle(
			new Request("http://localhost/desktop-auth/flows/complete", {
				method: "OPTIONS",
				headers: {
					"access-control-request-headers": "authorization,content-type",
					"access-control-request-method": "POST",
					origin: "https://viewer.example.test",
				},
			}),
		);

		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-origin")).toBe(
			"https://viewer.example.test",
		);
		expect(response.headers.get("access-control-allow-headers")).toContain(
			"authorization",
		);
	});

	it("allows CORS preflight for Clerk authorized party origins", async () => {
		const { app } = createApp(
			createTestEnv({
				CLERK_AUTHORIZED_PARTIES:
					"https://viewer.example.test,https://desktop.example.test/",
			}),
		);

		const response = await app.handle(
			new Request("http://localhost/desktop-auth/flows/complete", {
				method: "OPTIONS",
				headers: {
					"access-control-request-headers": "authorization,content-type",
					"access-control-request-method": "POST",
					origin: "https://desktop.example.test",
				},
			}),
		);

		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-origin")).toBe(
			"https://desktop.example.test",
		);
	});

	it("bridges browser Clerk approval into a polled desktop token", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);
		const { privateKey, jwtKey } = await getAuthFixture();
		const clerkToken = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_desktop_auth_bridge")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		const { app } = createApp(
			createTestEnv({
				DATABASE_URL: databaseUrl,
				CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZSQ",
				CLERK_JWT_KEY: jwtKey,
				CLERK_AUDIENCE: "test-audience",
				WEB_APP_ORIGIN: "https://viewer.example.test",
			}),
		);

		const startResponse = await app.handle(
			new Request("http://localhost/desktop-auth/flows", { method: "POST" }),
		);
		expect(startResponse.status).toBe(200);
		const started = (await startResponse.json()) as {
			deviceCode: string;
			userCode: string;
			verificationUriComplete: string;
		};
		expect(started.userCode).toContain("-");
		expect(
			started.verificationUriComplete.startsWith(
				"https://viewer.example.test/desktop-auth?user_code=",
			),
		).toBeTrue();

		const pendingResponse = await app.handle(
			new Request(
				`http://localhost/desktop-auth/flows/${encodeURIComponent(started.deviceCode)}`,
			),
		);
		expect(pendingResponse.status).toBe(200);
		expect((await pendingResponse.json()) as { status: string }).toMatchObject({
			status: "pending",
		});

		const completeResponse = await app.handle(
			new Request("http://localhost/desktop-auth/flows/complete", {
				method: "POST",
				headers: {
					authorization: `Bearer ${clerkToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ userCode: started.userCode }),
			}),
		);
		expect(completeResponse.status).toBe(200);
		expect((await completeResponse.json()) as { status: string }).toMatchObject(
			{
				status: "approved",
			},
		);

		const approvedResponse = await app.handle(
			new Request(
				`http://localhost/desktop-auth/flows/${encodeURIComponent(started.deviceCode)}`,
			),
		);
		expect(approvedResponse.status).toBe(200);
		const approved = (await approvedResponse.json()) as {
			status: string;
			accessToken: string;
			clerkUserId: string;
		};
		expect(approved.status).toBe("approved");
		expect(approved.clerkUserId).toBe("user_desktop_auth_bridge");
		expect(approved.accessToken).toBeString();

		const meResponse = await app.handle(
			new Request("http://localhost/protected/me", {
				headers: { authorization: `Bearer ${approved.accessToken}` },
			}),
		);
		expect(meResponse.status).toBe(200);
		expect((await meResponse.json()) as { userId: string }).toMatchObject({
			userId: "user_desktop_auth_bridge",
		});
	});

	it("bridges browser Clerk approval into a persistent extension token", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);
		const { privateKey, jwtKey } = await getAuthFixture();
		const clerkToken = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_extension_auth_bridge")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		const { app } = createApp(
			createTestEnv({
				DATABASE_URL: databaseUrl,
				CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZSQ",
				CLERK_JWT_KEY: jwtKey,
				CLERK_AUDIENCE: "test-audience",
				WEB_APP_ORIGIN: "https://viewer.example.test",
			}),
		);

		const startResponse = await app.handle(
			new Request("http://localhost/extension-auth/flows", { method: "POST" }),
		);
		expect(startResponse.status).toBe(200);
		const started = (await startResponse.json()) as {
			deviceCode: string;
			userCode: string;
			verificationUriComplete: string;
		};
		expect(started.userCode).toContain("-");
		expect(
			started.verificationUriComplete.startsWith(
				"https://viewer.example.test/extension-auth?user_code=",
			),
		).toBeTrue();

		const completeResponse = await app.handle(
			new Request("http://localhost/extension-auth/flows/complete", {
				method: "POST",
				headers: {
					authorization: `Bearer ${clerkToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ userCode: started.userCode }),
			}),
		);
		expect(completeResponse.status).toBe(200);

		const approvedResponse = await app.handle(
			new Request(
				`http://localhost/extension-auth/flows/${encodeURIComponent(started.deviceCode)}`,
			),
		);
		expect(approvedResponse.status).toBe(200);
		const approved = (await approvedResponse.json()) as {
			status: string;
			accessToken: string;
			refreshToken: string;
			clerkUserId: string;
			expiresInSeconds: number;
		};
		expect(approved.status).toBe("approved");
		expect(approved.clerkUserId).toBe("user_extension_auth_bridge");
		expect(approved.expiresInSeconds).toBe(30 * 24 * 60 * 60);
		expect(approved.accessToken).toBeString();
		expect(approved.refreshToken).toBeString();

		const refreshResponse = await app.handle(
			new Request("http://localhost/extension-auth/sessions/refresh", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ refreshToken: approved.refreshToken }),
			}),
		);
		expect(refreshResponse.status).toBe(200);
		const refreshed = (await refreshResponse.json()) as {
			accessToken: string;
			refreshToken: string;
			clerkUserId: string;
		};
		expect(refreshed.accessToken).toBeString();
		expect(refreshed.refreshToken).toBeString();
		expect(refreshed.refreshToken).not.toBe(approved.refreshToken);
		expect(refreshed.clerkUserId).toBe("user_extension_auth_bridge");

		const meResponse = await app.handle(
			new Request("http://localhost/protected/me", {
				headers: { authorization: `Bearer ${refreshed.accessToken}` },
			}),
		);
		expect(meResponse.status).toBe(200);
		expect((await meResponse.json()) as { userId: string }).toMatchObject({
			userId: "user_extension_auth_bridge",
		});
	});

	it("rejects client-provided orgId when starting uploads", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_uploads_reject_orgid",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_uploads_reject_orgid" },
		});

		const { privateKey, jwtKey } = await getAuthFixture();
		const token = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_uploads_reject_orgid")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const response = await app.handle(
			new Request("http://localhost/evidences/uploads/start", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					title: "Upload draft",
					sourceType: "browser",
					orgId: crypto.randomUUID(),
					artifact: {
						kind: "recording",
						mimeType: "video/webm",
						bytes: 128,
						checksum: "sha256:abc",
					},
				}),
			}),
		);

		expect(response.status).toBe(400);
		await expectApiError(response, {
			code: "EVIDENCE_UPLOAD_CLIENT_ORG_FORBIDDEN",
			message: "Client-provided orgId is not allowed",
			status: 400,
		});
	});

	it("allows developer members to start evidence uploads", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const provisioned = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_uploads_developer",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_uploads_developer" },
		});

		const [teamOrganization] = await db
			.insert(organizations)
			.values({ name: "Developer Uploads", isPersonal: false })
			.returning({ id: organizations.id });
		if (!teamOrganization) {
			throw new Error("Failed to create team organization");
		}

		await db.insert(organizationMembers).values({
			organizationId: teamOrganization.id,
			userId: provisioned.userId,
			role: "developer",
		});
		await db
			.update(users)
			.set({ activeOrgId: teamOrganization.id, updatedAt: Date.now() })
			.where(eq(users.id, provisioned.userId));

		const { privateKey, jwtKey } = await getAuthFixture();
		const token = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_uploads_developer")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const startResponse = await app.handle(
			new Request("http://localhost/evidences/uploads/start", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					title: "Developer upload draft",
					sourceType: "browser",
					artifact: {
						kind: "recording",
						mimeType: "video/webm",
						bytes: 11,
						checksum: `sha256:${await sha256Hex("hello world")}`,
					},
				}),
			}),
		);

		expect(startResponse.status).toBe(200);
		const startPayload = (await startResponse.json()) as {
			organizationId: string;
		};
		expect(startPayload.organizationId).toBe(teamOrganization.id);
	});

	it("scopes upload lifecycle to the active organization", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const provisioned = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_uploads_scope",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_uploads_scope" },
		});

		const { privateKey, jwtKey } = await getAuthFixture();
		const token = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_uploads_scope")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const activityFrom = Date.now() - 1000;
		const startResponse = await app.handle(
			new Request("http://localhost/evidences/uploads/start", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
					"x-forwarded-for": "203.0.113.10, 10.0.0.2",
				},
				body: JSON.stringify({
					title: "Team upload draft",
					sourceType: "browser",
					artifact: {
						kind: "recording",
						mimeType: "video/webm",
						bytes: 11,
						checksum: `sha256:${await sha256Hex("hello world")}`,
					},
				}),
			}),
		);

		expect(startResponse.status).toBe(200);
		const startPayload = (await startResponse.json()) as {
			uploadId: string;
			evidenceId: string;
			organizationId: string;
		};
		expect(startPayload.organizationId).toBe(provisioned.organizationId);

		const createdEvidence = await db.query.evidences.findFirst({
			where: eq(evidences.id, startPayload.evidenceId),
			columns: { orgId: true, createdBy: true },
		});
		expect(createdEvidence?.orgId).toBe(provisioned.organizationId);
		expect(createdEvidence?.createdBy).toBe(provisioned.userId);

		const blobResponse = await app.handle(
			new Request(
				`http://localhost/evidences/uploads/${startPayload.uploadId}/blob`,
				{
					method: "PUT",
					headers: {
						"content-type": "video/webm",
						authorization: `Bearer ${token}`,
					},
					body: "hello world",
				},
			),
		);
		expect(blobResponse.status).toBe(204);

		const completeResponse = await app.handle(
			new Request(
				`http://localhost/evidences/uploads/${startPayload.uploadId}/complete`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({
						bytes: 11,
						checksum: `sha256:${await sha256Hex("hello world")}`,
						mimeType: "video/webm",
					}),
				},
			),
		);

		expect(completeResponse.status).toBe(200);
		expect(await completeResponse.json()).toEqual({
			uploadId: startPayload.uploadId,
			evidenceId: startPayload.evidenceId,
			status: "committed",
		});

		const storedArtifact = await db.query.evidenceArtifacts.findFirst({
			where: eq(evidenceArtifacts.id, startPayload.uploadId),
			columns: { uploadStatus: true },
		});
		expect(storedArtifact?.uploadStatus).toBe("uploaded");

		const activityResponse = await app.handle(
			new Request(
				`http://localhost/orgs/${provisioned.organizationId}/activity?action=evidence.created&userId=${provisioned.userId}&from=${activityFrom}&to=${Date.now() + 1000}`,
				{ headers: { authorization: `Bearer ${token}` } },
			),
		);
		expect(activityResponse.status).toBe(200);
		const activityPayload = (await activityResponse.json()) as {
			logs: Array<{
				action: string;
				actorUserId: string | null;
				entityType: string;
				entityId: string | null;
				message: string;
				metadata: Record<string, unknown>;
				ipAddress: string | null;
			}>;
		};
		expect(activityPayload.logs).toHaveLength(1);
		expect(activityPayload.logs[0]).toMatchObject({
			action: "evidence.created",
			actorUserId: provisioned.userId,
			entityType: "evidence",
			entityId: startPayload.evidenceId,
			message: "Created evidence session",
			ipAddress: "203.0.113.10",
		});
		expect(activityPayload.logs[0]?.metadata.entityUrl).toBe(
			`/evidence/${startPayload.evidenceId}`,
		);
	});

	it("uploads automation evidence ZIPs with API tokens", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const provisioned = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_automation_upload",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_automation_upload" },
		});

		const { privateKey, jwtKey } = await getAuthFixture();
		const clerkToken = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_automation_upload")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const tokenResponse = await app.handle(
			new Request("http://localhost/automation/api-tokens", {
				method: "POST",
				headers: {
					authorization: `Bearer ${clerkToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					label: "CI evidence uploader",
					permanent: true,
				}),
			}),
		);
		expect(tokenResponse.status).toBe(200);
		const tokenPayload = (await tokenResponse.json()) as {
			token: string;
			apiToken: { id: string; orgId: string; token: string };
		};
		expect(tokenPayload.token).toStartWith("jl_api_");
		expect(tokenPayload.apiToken).toMatchObject({
			orgId: provisioned.organizationId,
			token: tokenPayload.token,
		});

		const uploadZip = createAutomationEvidenceZip();
		const uploadResponse = await app.handle(
			new Request(
				"http://localhost/automation/evidences/zip?title=CI%20Run%20Evidence",
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${tokenPayload.token}`,
						"content-type": "application/zip",
						"x-forwarded-for": "203.0.113.80",
					},
					body: bytesBody(uploadZip),
				},
			),
		);
		expect(uploadResponse.status).toBe(200);
		const uploadPayload = (await uploadResponse.json()) as {
			evidence: { id: string; orgId: string; title: string };
			artifacts: Array<{ id: string; kind: string; checksum: string }>;
			limits: { maxZipBytes: number };
		};
		expect(uploadPayload.evidence).toMatchObject({
			orgId: provisioned.organizationId,
			title: "CI Run Evidence",
		});
		expect(
			uploadPayload.artifacts.map((artifact) => artifact.kind).sort(),
		).toEqual(["network-log", "recording"]);
		expect(uploadPayload.limits.maxZipBytes).toBe(20 * 1024 * 1024);

		const createdEvidence = await db.query.evidences.findFirst({
			where: eq(evidences.id, uploadPayload.evidence.id),
			columns: {
				sourceType: true,
				sourceExternalId: true,
				createdBy: true,
				orgId: true,
			},
		});
		expect(createdEvidence).toMatchObject({
			sourceType: "automation-test",
			sourceExternalId: "jl_automation_upload_001",
			createdBy: provisioned.userId,
			orgId: provisioned.organizationId,
		});

		const artifacts = await db.query.evidenceArtifacts.findMany({
			where: eq(evidenceArtifacts.evidenceId, uploadPayload.evidence.id),
			columns: { kind: true, uploadStatus: true, bytes: true },
		});
		expect(artifacts).toHaveLength(2);
		expect(
			artifacts.every((artifact) => artifact.uploadStatus === "uploaded"),
		).toBe(true);
		expect(artifacts.every((artifact) => artifact.bytes > 0)).toBe(true);

		const storedToken = await db.query.automationApiTokens.findFirst({
			where: eq(automationApiTokens.id, tokenPayload.apiToken.id),
			columns: { lastUsedAt: true },
		});
		expect(storedToken?.lastUsedAt).toBeNumber();

		const tooLargeResponse = await app.handle(
			new Request("http://localhost/automation/evidences/zip", {
				method: "POST",
				headers: {
					authorization: `Bearer ${tokenPayload.token}`,
					"content-type": "application/zip",
					"content-length": String(20 * 1024 * 1024 + 1),
				},
				body: bytesBody(uploadZip),
			}),
		);
		expect(tooLargeResponse.status).toBe(413);
		await expectApiError(tooLargeResponse, {
			code: "AUTOMATION_UPLOAD_TOO_LARGE",
			message: "Automation evidence ZIP must be 20 MB or smaller",
			status: 413,
		});

		const invalidZip = zipSync({
			[sessionArchiveFileName]: strToU8("{}"),
			[recordingFileName]: new Uint8Array([0x1a]),
			"extra.txt": strToU8("not allowed"),
		});
		const invalidZipResponse = await app.handle(
			new Request("http://localhost/automation/evidences/zip", {
				method: "POST",
				headers: {
					authorization: `Bearer ${tokenPayload.token}`,
					"content-type": "application/zip",
				},
				body: bytesBody(invalidZip),
			}),
		);
		expect(invalidZipResponse.status).toBe(400);
		await expectApiError(invalidZipResponse, {
			code: "AUTOMATION_UPLOAD_ZIP_INVALID",
			message:
				"ZIP must contain exactly session.archive.json and recording.webm at the root",
			status: 400,
		});

		const revokeResponse = await app.handle(
			new Request(
				`http://localhost/automation/api-tokens/${tokenPayload.apiToken.id}`,
				{
					method: "DELETE",
					headers: { authorization: `Bearer ${clerkToken}` },
				},
			),
		);
		expect(revokeResponse.status).toBe(200);

		const revokedUploadResponse = await app.handle(
			new Request("http://localhost/automation/evidences/zip", {
				method: "POST",
				headers: {
					authorization: `Bearer ${tokenPayload.token}`,
					"content-type": "application/zip",
				},
				body: bytesBody(uploadZip),
			}),
		);
		expect(revokedUploadResponse.status).toBe(401);
		await expectApiError(revokedUploadResponse, {
			code: "AUTOMATION_AUTH_INVALID_TOKEN",
			message: "Invalid or expired automation API token",
			status: 401,
		});
	});

	it("retains organization activity logs for 60 days", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const provisioned = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_activity_retention",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_activity_retention" },
		});

		const now = Date.now();
		await db.insert(organizationActivityLogs).values([
			{
				organizationId: provisioned.organizationId,
				actorUserId: provisioned.userId,
				action: "evidence.copied.out",
				entityType: "evidence",
				entityId: crypto.randomUUID(),
				message: "Expired copy log",
				metadataJson: "{}",
				createdAt: now - 61 * 24 * 60 * 60 * 1000,
			},
			{
				organizationId: provisioned.organizationId,
				actorUserId: provisioned.userId,
				action: "evidence.copied.in",
				entityType: "evidence",
				entityId: crypto.randomUUID(),
				message: "Retained copy log",
				metadataJson: "{}",
				createdAt: now - 60 * 24 * 60 * 60 * 1000,
			},
		]);

		const removed = await cleanupExpiredOrganizationActivityLogs(db, now);
		expect(removed).toBe(1);

		const remaining = await db.query.organizationActivityLogs.findMany({
			where: eq(
				organizationActivityLogs.organizationId,
				provisioned.organizationId,
			),
			columns: { message: true },
		});
		expect(remaining).toEqual([{ message: "Retained copy log" }]);
	});

	it("uses forwarded proxy origin when returning blob upload URLs", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_uploads_forwarded_origin",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_uploads_forwarded_origin" },
		});

		const { privateKey, jwtKey } = await getAuthFixture();
		const token = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_uploads_forwarded_origin")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
			JITTLE_LAMP_API_ORIGIN: "https://jl-api.monthlyparty.com",
		});

		const startResponse = await app.handle(
			new Request("http://internal-service/evidences/uploads/start", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
					"x-forwarded-proto": "https",
					"x-forwarded-host": "jl-api.monthlyparty.com",
				},
				body: JSON.stringify({
					title: "Forwarded upload draft",
					sourceType: "browser",
					artifact: {
						kind: "recording",
						mimeType: "video/webm",
						bytes: 11,
						checksum: `sha256:${await sha256Hex("hello world")}`,
					},
				}),
			}),
		);
		expect(startResponse.status).toBe(200);
		const startPayload = (await startResponse.json()) as {
			uploadSession: { uploadUrl: string };
		};
		expect(startPayload.uploadSession.uploadUrl).toStartWith(
			"https://jl-api.monthlyparty.com/evidences/uploads/",
		);

		const syncResponse = await app.handle(
			new Request(
				"http://internal-service/evidences/desktop-sessions/sync/start",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token}`,
						"x-forwarded-proto": "https",
						"x-forwarded-host": "jl-api.monthlyparty.com",
					},
					body: JSON.stringify({
						sessionId: "local-session-forwarded-origin",
						title: "Forwarded desktop session",
						artifacts: [
							{
								key: "recording",
								kind: "recording",
								mimeType: "video/webm",
								bytes: 11,
								checksum: `sha256:${await sha256Hex("hello world")}`,
							},
							{
								key: "archive",
								kind: "network-log",
								mimeType: "application/json",
								bytes: 2,
								checksum: `sha256:${await sha256Hex("{}")}`,
							},
							{
								key: "playback",
								kind: "recording",
								mimeType: "video/mp4",
								bytes: 12,
								checksum: `sha256:${await sha256Hex("mp4 playback")}`,
							},
						],
					}),
				},
			),
		);
		expect(syncResponse.status).toBe(200);
		const syncPayload = (await syncResponse.json()) as {
			uploadSessions: Array<{ uploadUrl: string }>;
		};
		expect(syncPayload.uploadSessions).toHaveLength(3);
		for (const uploadSession of syncPayload.uploadSessions) {
			expect(uploadSession.uploadUrl).toStartWith(
				"https://jl-api.monthlyparty.com/evidences/uploads/",
			);
		}

		// An untrusted forwarded host must not be reflected into the upload URL;
		// it falls back to the configured API origin instead.
		const injectionResponse = await app.handle(
			new Request("http://internal-service/evidences/uploads/start", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
					"x-forwarded-proto": "https",
					"x-forwarded-host": "attacker.example.com",
				},
				body: JSON.stringify({
					title: "Injection attempt upload draft",
					sourceType: "browser",
					artifact: {
						kind: "recording",
						mimeType: "video/webm",
						bytes: 11,
						checksum: `sha256:${await sha256Hex("hello world")}`,
					},
				}),
			}),
		);
		expect(injectionResponse.status).toBe(200);
		const injectionPayload = (await injectionResponse.json()) as {
			uploadSession: { uploadUrl: string };
		};
		expect(injectionPayload.uploadSession.uploadUrl).toStartWith(
			"https://jl-api.monthlyparty.com/evidences/uploads/",
		);
		expect(injectionPayload.uploadSession.uploadUrl).not.toContain(
			"attacker.example.com",
		);
	});

	it("replaces cloud artifacts when resyncing a desktop session", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_uploads_desktop_resync",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_uploads_desktop_resync" },
		});

		const { privateKey, jwtKey } = await getAuthFixture();
		const token = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_uploads_desktop_resync")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const startDesktopSync = (body: Record<string, unknown>) =>
			app.handle(
				new Request("http://localhost/evidences/desktop-sessions/sync/start", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token}`,
					},
					body: JSON.stringify(body),
				}),
			);

		const initialResponse = await startDesktopSync({
			sessionId: "local-session-resync",
			title: "Original desktop session",
			sourceMetadata: "original",
			artifacts: [
				{
					key: "recording",
					kind: "recording",
					mimeType: "video/webm",
					bytes: 11,
					checksum: `sha256:${await sha256Hex("hello world")}`,
				},
				{
					key: "archive",
					kind: "network-log",
					mimeType: "application/json",
					bytes: 2,
					checksum: `sha256:${await sha256Hex("{}")}`,
				},
			],
		});
		expect(initialResponse.status).toBe(200);
		const initialPayload = (await initialResponse.json()) as {
			evidenceId: string;
			organizationId: string;
			uploadSessions: Array<{ uploadId: string; storageKey: string }>;
		};

		const resyncResponse = await startDesktopSync({
			sessionId: "local-session-resync",
			title: "Updated desktop session",
			sourceMetadata: "updated",
			replaceEvidenceId: initialPayload.evidenceId,
			artifacts: [
				{
					key: "recording",
					kind: "recording",
					mimeType: "video/webm",
					bytes: 12,
					checksum: `sha256:${await sha256Hex("hello world!")}`,
				},
				{
					key: "archive",
					kind: "network-log",
					mimeType: "application/json",
					bytes: 13,
					checksum: `sha256:${await sha256Hex('{"ok":true}')}`,
				},
			],
		});
		expect(resyncResponse.status).toBe(200);
		const resyncPayload = (await resyncResponse.json()) as {
			evidenceId: string;
			organizationId: string;
			uploadSessions: Array<{ uploadId: string; storageKey: string }>;
		};

		expect(resyncPayload.evidenceId).toBe(initialPayload.evidenceId);
		expect(resyncPayload.organizationId).toBe(initialPayload.organizationId);
		expect(
			resyncPayload.uploadSessions.map((session) => session.uploadId),
		).not.toEqual(
			initialPayload.uploadSessions.map((session) => session.uploadId),
		);

		const evidence = await db.query.evidences.findFirst({
			where: eq(evidences.id, initialPayload.evidenceId),
			columns: { title: true, sourceMetadata: true },
		});
		expect(evidence).toEqual({
			title: "Updated desktop session",
			sourceMetadata: "updated",
		});

		const artifacts = await db.query.evidenceArtifacts.findMany({
			where: eq(evidenceArtifacts.evidenceId, initialPayload.evidenceId),
			columns: { id: true, bytes: true, uploadStatus: true },
		});
		expect(artifacts).toHaveLength(2);
		expect(artifacts.map((artifact) => artifact.id).sort()).toEqual(
			resyncPayload.uploadSessions.map((session) => session.uploadId).sort(),
		);
		expect(
			artifacts.map((artifact) => artifact.bytes).sort((a, b) => a - b),
		).toEqual([12, 13]);
		expect(
			artifacts.every((artifact) => artifact.uploadStatus === "uploading"),
		).toBe(true);

		const staleReplaceEvidenceId = crypto.randomUUID();
		const staleReplaceResponse = await startDesktopSync({
			sessionId: "local-session-stale-replace",
			title: "Stale replacement desktop session",
			sourceMetadata: "stale-replacement",
			replaceEvidenceId: staleReplaceEvidenceId,
			artifacts: [
				{
					key: "recording",
					kind: "recording",
					mimeType: "video/webm",
					bytes: 14,
					checksum: `sha256:${await sha256Hex("fresh recording")}`,
				},
				{
					key: "archive",
					kind: "network-log",
					mimeType: "application/json",
					bytes: 15,
					checksum: `sha256:${await sha256Hex('{"fresh":true}')}`,
				},
			],
		});
		expect(staleReplaceResponse.status).toBe(200);
		const staleReplacePayload = (await staleReplaceResponse.json()) as {
			evidenceId: string;
			organizationId: string;
		};
		expect(staleReplacePayload.evidenceId).not.toBe(staleReplaceEvidenceId);
		expect(staleReplacePayload.organizationId).toBe(
			initialPayload.organizationId,
		);

		const sessionRows = await db.query.desktopRecordingSessions.findMany({
			columns: { sessionId: true, evidenceId: true, orgId: true },
		});
		expect(
			sessionRows.some(
				(row) =>
					row.sessionId === "local-session-stale-replace" &&
					row.evidenceId === staleReplacePayload.evidenceId &&
					row.orgId === initialPayload.organizationId,
			),
		).toBe(true);
	});

	it("does not allow completion before blob upload exists", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_uploads_missing_blob",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_uploads_missing_blob" },
		});

		const { privateKey, jwtKey } = await getAuthFixture();
		const checksum = `sha256:${await sha256Hex("hello world")}`;
		const token = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_uploads_missing_blob")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const startResponse = await app.handle(
			new Request("http://localhost/evidences/uploads/start", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					title: "Missing blob upload",
					sourceType: "browser",
					artifact: {
						kind: "recording",
						mimeType: "video/webm",
						bytes: 11,
						checksum,
					},
				}),
			}),
		);
		expect(startResponse.status).toBe(200);
		const startPayload = (await startResponse.json()) as { uploadId: string };

		const completeResponse = await app.handle(
			new Request(
				`http://localhost/evidences/uploads/${startPayload.uploadId}/complete`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({
						bytes: 11,
						checksum,
						mimeType: "video/webm",
					}),
				},
			),
		);

		expect(completeResponse.status).toBe(409);
		await expectApiError(completeResponse, {
			code: "UPLOAD_BLOB_MISSING",
			message: "Upload blob was not found; upload binary before completing",
			status: 409,
		});
	});

	it("rejects blob upload and completion after upload session expires", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_uploads_expired",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_uploads_expired" },
		});

		const { privateKey, jwtKey } = await getAuthFixture();
		const checksum = `sha256:${await sha256Hex("hello world")}`;
		const token = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_uploads_expired")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const startResponse = await app.handle(
			new Request("http://localhost/evidences/uploads/start", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					title: "Expired upload",
					sourceType: "browser",
					artifact: {
						kind: "recording",
						mimeType: "video/webm",
						bytes: 11,
						checksum,
					},
				}),
			}),
		);
		expect(startResponse.status).toBe(200);
		const startPayload = (await startResponse.json()) as { uploadId: string };

		await db
			.update(evidenceArtifacts)
			.set({ createdAt: Date.now() - 10 * 60 * 1000, updatedAt: Date.now() })
			.where(eq(evidenceArtifacts.id, startPayload.uploadId));

		const blobResponse = await app.handle(
			new Request(
				`http://localhost/evidences/uploads/${startPayload.uploadId}/blob`,
				{
					method: "PUT",
					headers: {
						"content-type": "video/webm",
						authorization: `Bearer ${token}`,
					},
					body: "hello world",
				},
			),
		);
		expect(blobResponse.status).toBe(410);
		await expectApiError(blobResponse, {
			code: "UPLOAD_SESSION_EXPIRED",
			message: "Upload session has expired; start a new upload",
			status: 410,
		});

		const completeResponse = await app.handle(
			new Request(
				`http://localhost/evidences/uploads/${startPayload.uploadId}/complete`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({
						bytes: 11,
						checksum,
						mimeType: "video/webm",
					}),
				},
			),
		);
		expect(completeResponse.status).toBe(410);
		await expectApiError(completeResponse, {
			code: "UPLOAD_SESSION_EXPIRED",
			message: "Upload session has expired; start a new upload",
			status: 410,
		});
	});

	it("provisions one personal organization per user", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const firstProvision = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_abc",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_abc" },
		});
		const secondProvision = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_abc",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_abc" },
		});

		expect(firstProvision.membershipRole).toBe("admin");
		expect(firstProvision.eventId).toBeString();
		expect(secondProvision.userId).toBe(firstProvision.userId);
		expect(secondProvision.organizationId).toBe(firstProvision.organizationId);
		expect(secondProvision.eventId).toBeNull();
	});

	it("accepts static invitation codes with password, domain, and guest expiry", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const owner = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_code_owner",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_code_owner" },
		});
		const joiner = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_code_joiner",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_code_joiner" },
		});

		const code = await createOrganizationInvitationCode(db, {
			organizationId: owner.organizationId,
			label: "LittleLives onboarding",
			role: "developer",
			createdBy: owner.userId,
			password: "secret",
			emailDomain: "littlelives.com",
			guestExpiresAfterDays: 3,
		});

		await expect(
			acceptInvitationByToken(db, {
				token: code.code,
				password: "secret",
				localUserId: joiner.userId,
				userEmail: "person@example.com",
			}),
		).rejects.toThrow("littlelives.com");

		const accepted = await acceptInvitationByToken(db, {
			token: code.code,
			password: "secret",
			localUserId: joiner.userId,
			userEmail: "person@littlelives.com",
		});
		expect(accepted.organizationId).toBe(owner.organizationId);
		expect(accepted.role).toBe("developer");
		expect(accepted.status).toBe("accepted");

		const membership = await db.query.organizationMembers.findFirst({
			where: and(
				eq(organizationMembers.userId, joiner.userId),
				eq(organizationMembers.organizationId, owner.organizationId),
			),
			columns: { organizationId: true, role: true, guestExpiresAt: true },
		});
		expect(membership?.organizationId).toBe(owner.organizationId);
		expect(membership?.role).toBe("developer");
		expect(membership?.guestExpiresAt).toBeNumber();
	});

	it("queues invitation-code joins when organization approval is required", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const owner = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_approval_owner",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_approval_owner" },
		});
		const joiner = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_approval_joiner",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_approval_joiner" },
		});

		await updateOrganizationSettings(db, {
			organizationId: owner.organizationId,
			requireInvitationApproval: true,
		});
		const code = await createOrganizationInvitationCode(db, {
			organizationId: owner.organizationId,
			label: "Approval required",
			role: "qa_engineer",
			createdBy: owner.userId,
		});

		const accepted = await acceptInvitationByToken(db, {
			token: code.code,
			localUserId: joiner.userId,
			userEmail: "person@example.com",
		});
		expect(accepted.status).toBe("pending_approval");

		const pendingRequest = await db.query.organizationJoinRequests.findFirst({
			where: and(
				eq(organizationJoinRequests.organizationId, owner.organizationId),
				eq(organizationJoinRequests.userId, joiner.userId),
			),
			columns: { id: true, requestedRole: true, status: true },
		});
		expect(pendingRequest?.requestedRole).toBe("qa_engineer");
		expect(pendingRequest?.status).toBe("pending");

		const membershipBeforeApproval =
			await db.query.organizationMembers.findFirst({
				where: and(
					eq(organizationMembers.userId, joiner.userId),
					eq(organizationMembers.organizationId, owner.organizationId),
				),
				columns: { id: true },
			});
		expect(membershipBeforeApproval).toBeUndefined();

		if (!pendingRequest) throw new Error("Expected pending join request");
		await reviewOrganizationJoinRequest(db, {
			organizationId: owner.organizationId,
			requestId: pendingRequest.id,
			reviewerLocalUserId: owner.userId,
			decision: "approved",
		});

		const membershipAfterApproval =
			await db.query.organizationMembers.findFirst({
				where: and(
					eq(organizationMembers.userId, joiner.userId),
					eq(organizationMembers.organizationId, owner.organizationId),
				),
				columns: { role: true },
			});
		expect(membershipAfterApproval?.role).toBe("qa_engineer");
	});

	it("does not allow admin-only permissions on non-admin roles", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const owner = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_admin_only_role_owner",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_admin_only_role_owner" },
		});

		await expect(
			updateOrganizationRolePermissions(db, {
				organizationId: owner.organizationId,
				role: "moderator",
				permissions: [
					"evidence.view",
					"invitations.disable",
					"invitations.create",
				],
			}),
		).rejects.toThrow("Only the Admin role can hold admin-only permissions.");
	});

	it("only retries failed provisioning for the same Clerk user", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const [failedEvent] = await db
			.insert(provisioningEvents)
			.values({
				clerkUserId: "user_clerk_owner",
				source: "clerk-callback",
				rawPayload: JSON.stringify({ userId: "user_clerk_owner" }),
				status: "failed",
				errorMessage: "simulated failure",
			})
			.returning({ id: provisioningEvents.id });

		if (!failedEvent) {
			throw new Error("Expected failed provisioning event to be created");
		}

		await expect(
			retryFailedProvisioning(
				db,
				failedEvent.id,
				"user_clerk_different_authenticated_user",
			),
		).rejects.toThrow(
			`No failed provisioning event found for ${failedEvent.id}`,
		);
	});

	it("selects active organization only when user is a member", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const provisioned = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_active_org",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_active_org" },
		});

		const [teamOrganization] = await db
			.insert(organizations)
			.values({ name: "Team Alpha", isPersonal: false })
			.returning({ id: organizations.id });
		if (!teamOrganization) {
			throw new Error("Failed to create team organization");
		}

		await db.insert(organizationMembers).values({
			organizationId: teamOrganization.id,
			userId: provisioned.userId,
			role: "qa_engineer",
		});

		const { privateKey, jwtKey } = await getAuthFixture();
		const token = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_active_org")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const selectResponse = await app.handle(
			new Request(
				`http://localhost/orgs/${teamOrganization.id}/select-active`,
				{
					method: "POST",
					headers: { authorization: `Bearer ${token}` },
				},
			),
		);
		expect(selectResponse.status).toBe(200);
		expect(await selectResponse.json()).toEqual({
			organizationId: teamOrganization.id,
		});

		const updatedUser = await db.query.users.findFirst({
			where: eq(users.id, provisioned.userId),
			columns: { activeOrgId: true },
		});
		expect(updatedUser?.activeOrgId).toBe(teamOrganization.id);

		const outsiderSelectResponse = await app.handle(
			new Request(
				`http://localhost/orgs/${crypto.randomUUID()}/select-active`,
				{
					method: "POST",
					headers: { authorization: `Bearer ${token}` },
				},
			),
		);
		expect(outsiderSelectResponse.status).toBe(403);
		await expectApiError(outsiderSelectResponse, {
			code: "ORG_MEMBERSHIP_REQUIRED",
			message: "Selected organization must be a member organization",
			status: 403,
		});

		const startResponse = await app.handle(
			new Request("http://localhost/evidences/uploads/start", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					title: "Active org evidence",
					sourceType: "browser",
					artifact: {
						kind: "recording",
						mimeType: "video/webm",
						bytes: 16,
						checksum: `sha256:${await sha256Hex("active-org-payload")}`,
					},
				}),
			}),
		);
		expect(startResponse.status).toBe(200);
		const startPayload = (await startResponse.json()) as { evidenceId: string };
		const evidence = await db.query.evidences.findFirst({
			where: eq(evidences.id, startPayload.evidenceId),
			columns: { orgId: true },
		});
		expect(evidence?.orgId).toBe(teamOrganization.id);
	});

	it("deletes a non-personal organization when the current user is the last admin", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const provisioned = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_delete_org_admin",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_delete_org_admin" },
		});

		const [teamOrganization] = await db
			.insert(organizations)
			.values({ name: "Disposable org", isPersonal: false })
			.returning({ id: organizations.id });
		if (!teamOrganization) {
			throw new Error("Expected organization to be created");
		}

		await db.insert(organizationMembers).values({
			organizationId: teamOrganization.id,
			userId: provisioned.userId,
			role: "admin",
		});
		await db
			.update(users)
			.set({ activeOrgId: teamOrganization.id })
			.where(eq(users.id, provisioned.userId));

		const { privateKey, jwtKey } = await getAuthFixture();
		const token = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_delete_org_admin")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const response = await app.handle(
			new Request(`http://localhost/orgs/${teamOrganization.id}`, {
				method: "DELETE",
				headers: { authorization: `Bearer ${token}` },
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });

		const deleted = await db.query.organizations.findFirst({
			where: eq(organizations.id, teamOrganization.id),
			columns: { id: true },
		});
		expect(deleted).toBeUndefined();

		const user = await db.query.users.findFirst({
			where: eq(users.id, provisioned.userId),
			columns: { activeOrgId: true },
		});
		expect(user?.activeOrgId).toBe(provisioned.organizationId);
	});

	it("does not delete an organization while another member remains", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const admin = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_delete_org_blocked_admin",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_delete_org_blocked_admin" },
		});
		const member = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_delete_org_blocked_member",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_delete_org_blocked_member" },
		});

		const [teamOrganization] = await db
			.insert(organizations)
			.values({ name: "Shared org", isPersonal: false })
			.returning({ id: organizations.id });
		if (!teamOrganization) {
			throw new Error("Expected organization to be created");
		}

		await db.insert(organizationMembers).values([
			{
				organizationId: teamOrganization.id,
				userId: admin.userId,
				role: "admin",
			},
			{
				organizationId: teamOrganization.id,
				userId: member.userId,
				role: "developer",
			},
		]);

		const { privateKey, jwtKey } = await getAuthFixture();
		const token = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_delete_org_blocked_admin")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const response = await app.handle(
			new Request(`http://localhost/orgs/${teamOrganization.id}`, {
				method: "DELETE",
				headers: { authorization: `Bearer ${token}` },
			}),
		);

		expect(response.status).toBe(400);
		await expectApiError(response, {
			code: "ORG_DELETE_FAILED",
			message: "Only the last remaining admin can delete this organization.",
			status: 400,
		});
	});

	it("returns persisted active org for already-provisioned users", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const provisioned = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_existing_active_org",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_existing_active_org" },
		});

		const [teamOrganization] = await db
			.insert(organizations)
			.values({ name: "Team Persisted Active Org", isPersonal: false })
			.returning({ id: organizations.id });
		if (!teamOrganization) {
			throw new Error("Failed to create team organization");
		}

		await db.insert(organizationMembers).values({
			organizationId: teamOrganization.id,
			userId: provisioned.userId,
			role: "member",
		});

		await db
			.update(users)
			.set({ activeOrgId: teamOrganization.id, updatedAt: Date.now() })
			.where(eq(users.id, provisioned.userId));

		const existing = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_existing_active_org",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_existing_active_org" },
		});

		expect(existing.eventId).toBeNull();
		expect(existing.userId).toBe(provisioned.userId);
		expect(existing.organizationId).toBe(provisioned.organizationId);
		expect(existing.activeOrgId).toBe(teamOrganization.id);
	});

	it("filters evidence list/load to active org unless explicit member org query is provided", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const provisioned = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_evidence_org_filters",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_evidence_org_filters" },
		});

		const [teamOrganization] = await db
			.insert(organizations)
			.values({ name: "Team Beta", isPersonal: false })
			.returning({ id: organizations.id });
		const [teamOnlyOrganization] = await db
			.insert(organizations)
			.values({ name: "Team Gamma", isPersonal: false })
			.returning({ id: organizations.id });
		if (!teamOrganization || !teamOnlyOrganization) {
			throw new Error("Failed to create team organizations");
		}

		await db.insert(organizationMembers).values({
			organizationId: teamOrganization.id,
			userId: provisioned.userId,
			role: "member",
		});
		await db.insert(organizationMembers).values({
			organizationId: teamOnlyOrganization.id,
			userId: provisioned.userId,
			teamId: crypto.randomUUID(),
			role: "member",
		});

		const [personalEvidence] = await db
			.insert(evidences)
			.values({
				orgId: provisioned.organizationId,
				createdBy: provisioned.userId,
				title: "Personal evidence",
				sourceType: "browser",
				thumbnailBase64: "ZmFrZS10aHVtYg==",
				thumbnailMimeType: "image/jpeg",
				scopeType: "organization",
				scopeId: provisioned.organizationId,
			})
			.returning({ id: evidences.id });
		const [teamEvidence] = await db
			.insert(evidences)
			.values({
				orgId: teamOrganization.id,
				createdBy: provisioned.userId,
				title: "Team evidence",
				sourceType: "browser",
				scopeType: "organization",
				scopeId: teamOrganization.id,
			})
			.returning({ id: evidences.id });
		if (!personalEvidence || !teamEvidence) {
			throw new Error("Expected evidence seed data to be created");
		}

		const { privateKey, jwtKey } = await getAuthFixture();
		const token = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_evidence_org_filters")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const defaultList = await app.handle(
			new Request("http://localhost/evidences", {
				headers: { authorization: `Bearer ${token}` },
			}),
		);
		expect(defaultList.status).toBe(200);
		const defaultListPayload = (await defaultList.json()) as {
			orgId: string;
			evidences: Array<{
				id: string;
				thumbnailBase64: string | null;
				thumbnailMimeType: string | null;
			}>;
		};
		expect(defaultListPayload.orgId).toBe(provisioned.organizationId);
		expect(defaultListPayload.evidences.map((evidence) => evidence.id)).toEqual(
			[personalEvidence.id],
		);
		expect(defaultListPayload.evidences[0]).toMatchObject({
			thumbnailBase64: "ZmFrZS10aHVtYg==",
			thumbnailMimeType: "image/jpeg",
		});

		const blockedLoad = await app.handle(
			new Request(`http://localhost/evidences/${teamEvidence.id}`, {
				headers: { authorization: `Bearer ${token}` },
			}),
		);
		expect(blockedLoad.status).toBe(404);

		const explicitTeamList = await app.handle(
			new Request(
				`http://localhost/evidences?orgId=${encodeURIComponent(teamOrganization.id)}`,
				{
					headers: { authorization: `Bearer ${token}` },
				},
			),
		);
		expect(explicitTeamList.status).toBe(200);
		const explicitTeamListPayload = (await explicitTeamList.json()) as {
			orgId: string;
			evidences: Array<{ id: string }>;
		};
		expect(explicitTeamListPayload.orgId).toBe(teamOrganization.id);
		expect(
			explicitTeamListPayload.evidences.map((evidence) => evidence.id),
		).toEqual([teamEvidence.id]);

		const explicitTeamLoad = await app.handle(
			new Request(
				`http://localhost/evidences/${teamEvidence.id}?orgId=${encodeURIComponent(teamOrganization.id)}`,
				{
					headers: { authorization: `Bearer ${token}` },
				},
			),
		);
		expect(explicitTeamLoad.status).toBe(200);
		const explicitTeamLoadPayload = (await explicitTeamLoad.json()) as {
			evidence: { id: string; orgId: string };
		};
		expect(explicitTeamLoadPayload.evidence).toMatchObject({
			id: teamEvidence.id,
			orgId: teamOrganization.id,
		});

		const explicitTeamOnlyOrgList = await app.handle(
			new Request(
				`http://localhost/evidences?orgId=${encodeURIComponent(teamOnlyOrganization.id)}`,
				{
					headers: { authorization: `Bearer ${token}` },
				},
			),
		);
		expect(explicitTeamOnlyOrgList.status).toBe(403);
		await expectApiError(explicitTeamOnlyOrgList, {
			code: "ORG_MEMBERSHIP_REQUIRED",
			message: "Selected organization must be a member organization",
			status: 403,
		});

		await db
			.update(users)
			.set({ activeOrgId: teamOnlyOrganization.id })
			.where(eq(users.id, provisioned.userId));

		const defaultTeamOnlyActiveOrgList = await app.handle(
			new Request("http://localhost/evidences", {
				headers: { authorization: `Bearer ${token}` },
			}),
		);
		expect(defaultTeamOnlyActiveOrgList.status).toBe(403);
		await expectApiError(defaultTeamOnlyActiveOrgList, {
			code: "ORG_MEMBERSHIP_REQUIRED",
			message: "Selected organization must be a member organization",
			status: 403,
		});
	});

	it("issues account AI tokens and uses them to load evidence debug context", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const provisioned = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_ai_debug",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_ai_debug" },
		});
		const [evidence] = await db
			.insert(evidences)
			.values({
				orgId: provisioned.organizationId,
				createdBy: provisioned.userId,
				title: "Checkout failure evidence",
				sourceType: "desktop-session",
				sourceExternalId: "session-ai-debug",
				sourceMetadata: JSON.stringify({ url: "https://example.test/cart" }),
				scopeType: "organization",
				scopeId: provisioned.organizationId,
			})
			.returning({ id: evidences.id });
		if (!evidence) {
			throw new Error("Expected evidence to be created");
		}

		await db.insert(desktopRecordingSessions).values({
			sessionId: "session-ai-debug",
			evidenceId: evidence.id,
			orgId: provisioned.organizationId,
			createdBy: provisioned.userId,
			sourceMetadata: JSON.stringify({ viewport: "1440x900" }),
		});
		await db.insert(evidenceArtifacts).values([
			{
				evidenceId: evidence.id,
				kind: "recording",
				s3Key: `uploads/${provisioned.organizationId}/${evidence.id}/recording-video`,
				mimeType: "video/webm",
				bytes: 42,
				checksum: `sha256:${await sha256Hex("video")}`,
				uploadStatus: "uploaded",
			},
			{
				evidenceId: evidence.id,
				kind: "network-log",
				s3Key: `uploads/${provisioned.organizationId}/${evidence.id}/archive-json`,
				mimeType: "application/json",
				bytes: 21,
				checksum: `sha256:${await sha256Hex("{}")}`,
				uploadStatus: "uploaded",
			},
		]);

		const { privateKey, jwtKey } = await getAuthFixture();
		const clerkToken = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_ai_debug")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const issueResponse = await app.handle(
			new Request("http://localhost/ai/access-tokens", {
				method: "POST",
				headers: {
					authorization: `Bearer ${clerkToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					label: "Cursor evidence check",
					permanent: true,
				}),
			}),
		);
		expect(issueResponse.status).toBe(200);
		const issuePayload = (await issueResponse.json()) as {
			token: string;
			accessToken: {
				id: string;
				label: string;
				token: string;
				tokenVersion: "v1" | "v2";
				tokenPrefix: string;
				scopes: string[];
				expiresAt: number | null;
			};
		};
		expect(issuePayload.token).toStartWith("jl_ai_");
		expect(issuePayload.accessToken).toMatchObject({
			label: "Cursor evidence check",
			token: issuePayload.token,
			tokenVersion: "v2",
			scopes: ["evidence:debug"],
			expiresAt: null,
		});

		const storedToken = await db.query.aiAccessTokens.findFirst({
			where: eq(aiAccessTokens.id, issuePayload.accessToken.id),
			columns: {
				tokenHash: true,
				tokenSecret: true,
				tokenVersion: true,
				tokenPrefix: true,
				lastUsedAt: true,
			},
		});
		expect(storedToken?.tokenHash).toBeNull();
		expect(storedToken?.tokenSecret).toBe(issuePayload.token);
		expect(storedToken?.tokenVersion).toBe("v2");
		expect(storedToken?.tokenPrefix).toBe(issuePayload.accessToken.tokenPrefix);
		expect(storedToken?.lastUsedAt).toBeNull();

		const listResponse = await app.handle(
			new Request("http://localhost/ai/access-tokens", {
				headers: { authorization: `Bearer ${clerkToken}` },
			}),
		);
		expect(listResponse.status).toBe(200);
		const listPayload = (await listResponse.json()) as {
			accessTokens: Array<{
				id: string;
				token: string | null;
				tokenVersion: "v1" | "v2";
			}>;
		};
		const listedV2Token = listPayload.accessTokens.find(
			(token) => token.id === issuePayload.accessToken.id,
		);
		expect(listedV2Token?.token).toBe(issuePayload.token);
		expect(listedV2Token?.tokenVersion).toBe("v2");

		const legacyToken = "jl_ai_legacy_hash_only_token";
		const [legacyRow] = await db
			.insert(aiAccessTokens)
			.values({
				userId: provisioned.userId,
				label: "Legacy hash-only token",
				tokenHash: await sha256Hex(legacyToken),
				tokenVersion: "v1",
				tokenPrefix: legacyToken.slice(0, 14),
				scopes: "evidence:debug",
				createdAt: Date.now(),
				expiresAt: null,
			})
			.returning({ id: aiAccessTokens.id });
		if (!legacyRow) {
			throw new Error("Expected legacy AI token row to be created");
		}

		const legacyDebugResponse = await app.handle(
			new Request(`http://localhost/ai/evidences/${evidence.id}/debug`, {
				headers: { authorization: `Bearer ${legacyToken}` },
			}),
		);
		expect(legacyDebugResponse.status).toBe(200);
		const legacyDebugPayload = (await legacyDebugResponse.json()) as {
			access: { tokenId: string };
		};
		expect(legacyDebugPayload.access.tokenId).toBe(legacyRow.id);

		await db.insert(aiAccessTokenUsageLogs).values({
			tokenId: issuePayload.accessToken.id,
			userId: provisioned.userId,
			evidenceId: evidence.id,
			method: "GET",
			path: "/ai/evidences/stale/debug",
			ipAddress: "198.51.100.20",
			userAgent: "StaleAgent/1.0",
			createdAt: Date.now() - 61 * 24 * 60 * 60 * 1000,
		});

		const debugResponse = await app.handle(
			new Request(`http://localhost/ai/evidences/${evidence.id}/debug`, {
				headers: {
					authorization: `Bearer ${issuePayload.token}`,
					"x-forwarded-for": "203.0.113.10, 10.0.0.2",
					"user-agent": "EvidenceBot/1.0",
				},
			}),
		);
		expect(debugResponse.status).toBe(200);
		const debugPayload = (await debugResponse.json()) as {
			access: { tokenId: string; userId: string };
			organization: { id: string };
			evidence: { id: string; status: "ready" | "pending" };
			desktopSession: { sessionId: string } | null;
			artifacts: Array<{
				id: string;
				role: "recording" | "session_archive" | "other";
				readUrl: null | { url: string };
				readUrlUnavailableReason: string | null;
			}>;
			debug: {
				llmsUrl: string;
				recommendedArtifactId: string | null;
				recommendedArtifactRole: string | null;
			};
		};
		expect(debugPayload.access).toMatchObject({
			tokenId: issuePayload.accessToken.id,
			userId: provisioned.userId,
		});
		expect(debugPayload.organization.id).toBe(provisioned.organizationId);
		expect(debugPayload.evidence).toMatchObject({
			id: evidence.id,
			status: "ready",
		});
		expect(debugPayload.desktopSession?.sessionId).toBe("session-ai-debug");
		const archiveArtifact = debugPayload.artifacts.find(
			(artifact) => artifact.role === "session_archive",
		);
		if (!archiveArtifact) {
			throw new Error("Expected session archive artifact");
		}
		expect(archiveArtifact.readUrl).toBeNull();
		expect(archiveArtifact.readUrlUnavailableReason).toBe(
			"s3_storage_not_configured",
		);
		expect(debugPayload.debug.recommendedArtifactId).toBe(archiveArtifact.id);
		expect(debugPayload.debug.recommendedArtifactRole).toBe("session_archive");
		expect(debugPayload.debug.llmsUrl).toBe("http://localhost/llms.txt");

		const usedToken = await db.query.aiAccessTokens.findFirst({
			where: eq(aiAccessTokens.id, issuePayload.accessToken.id),
			columns: { lastUsedAt: true },
		});
		expect(usedToken?.lastUsedAt).toBeNumber();

		const usageLogs = await db.query.aiAccessTokenUsageLogs.findMany({
			where: eq(aiAccessTokenUsageLogs.tokenId, issuePayload.accessToken.id),
			columns: {
				userId: true,
				evidenceId: true,
				method: true,
				path: true,
				ipAddress: true,
				userAgent: true,
			},
		});
		expect(usageLogs).toEqual([
			{
				userId: provisioned.userId,
				evidenceId: evidence.id,
				method: "GET",
				path: `/ai/evidences/${evidence.id}/debug`,
				ipAddress: "203.0.113.10",
				userAgent: "EvidenceBot/1.0",
			},
		]);

		const revokeResponse = await app.handle(
			new Request(
				`http://localhost/ai/access-tokens/${issuePayload.accessToken.id}`,
				{
					method: "DELETE",
					headers: { authorization: `Bearer ${clerkToken}` },
				},
			),
		);
		expect(revokeResponse.status).toBe(200);

		const revokedDebugResponse = await app.handle(
			new Request(`http://localhost/ai/evidences/${evidence.id}/debug`, {
				headers: { authorization: `Bearer ${issuePayload.token}` },
			}),
		);
		expect(revokedDebugResponse.status).toBe(401);
		await expectApiError(revokedDebugResponse, {
			code: "AI_AUTH_INVALID_TOKEN",
			message: "Invalid or expired AI access token",
			status: 401,
		});
	});

	it("lists organization evidence from multiple recorders with creator filters and pagination", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);
		const db = createDb(databaseUrl);
		if (!db) {
			throw new Error("Database was not created");
		}

		const owner = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_list_owner",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_list_owner" },
		});
		const recorderA = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_list_recorder_a",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_list_recorder_a" },
		});
		const recorderB = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_list_recorder_b",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_list_recorder_b" },
		});

		await db.insert(organizationMembers).values([
			{
				organizationId: owner.organizationId,
				userId: recorderA.userId,
				role: "member",
			},
			{
				organizationId: owner.organizationId,
				userId: recorderB.userId,
				role: "member",
			},
		]);

		const now = Date.now();
		const inserted = await db
			.insert(evidences)
			.values([
				{
					orgId: owner.organizationId,
					createdBy: owner.userId,
					title: "Old owner evidence",
					sourceType: "browser",
					scopeType: "organization",
					scopeId: owner.organizationId,
					createdAt: now - 3_000,
					updatedAt: now - 3_000,
				},
				{
					orgId: owner.organizationId,
					createdBy: recorderA.userId,
					title: "Newest A evidence",
					sourceType: "browser",
					scopeType: "organization",
					scopeId: owner.organizationId,
					createdAt: now - 1_000,
					updatedAt: now - 1_000,
				},
				{
					orgId: owner.organizationId,
					createdBy: recorderB.userId,
					title: "Middle B evidence",
					sourceType: "browser",
					scopeType: "organization",
					scopeId: owner.organizationId,
					createdAt: now - 2_000,
					updatedAt: now - 2_000,
				},
			])
			.returning({ id: evidences.id, createdBy: evidences.createdBy });

		const { privateKey, jwtKey } = await getAuthFixture();
		const ownerToken = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_list_owner")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const filtered = await app.handle(
			new Request(
				`http://localhost/evidences?createdBy=${recorderA.userId},${recorderB.userId}&limit=1&page=1`,
				{ headers: { authorization: `Bearer ${ownerToken}` } },
			),
		);
		expect(filtered.status).toBe(200);
		const payload = (await filtered.json()) as {
			evidences: Array<{ id: string; createdBy: string }>;
			total: number;
			page: number;
			limit: number;
		};
		expect(payload.total).toBe(2);
		expect(payload.page).toBe(1);
		expect(payload.limit).toBe(1);
		expect(payload.evidences).toHaveLength(1);
		expect(payload.evidences[0]?.createdBy).toBe(recorderA.userId);
		expect(payload.evidences[0]?.id).toBe(
			inserted.find((row) => row.createdBy === recorderA.userId)?.id,
		);

		const searched = await app.handle(
			new Request("http://localhost/evidences?search=Middle%20B&limit=24", {
				headers: { authorization: `Bearer ${ownerToken}` },
			}),
		);
		expect(searched.status).toBe(200);
		const searchedPayload = (await searched.json()) as {
			evidences: Array<{ id: string; title: string }>;
			total: number;
		};
		expect(searchedPayload.total).toBe(1);
		expect(searchedPayload.evidences).toHaveLength(1);
		expect(searchedPayload.evidences[0]?.title).toBe("Middle B evidence");
	});

	it("allows evidence members to add and list discussion comments", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const owner = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_comments_owner",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_comments_owner" },
		});
		const outsider = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_comments_outsider",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_comments_outsider" },
		});

		const [evidence] = await db
			.insert(evidences)
			.values({
				orgId: owner.organizationId,
				createdBy: owner.userId,
				title: "Discussable evidence",
				sourceType: "browser",
				scopeType: "organization",
				scopeId: owner.organizationId,
			})
			.returning({ id: evidences.id });
		if (!evidence) {
			throw new Error("Expected evidence to be created");
		}

		const { privateKey, jwtKey } = await getAuthFixture();
		const signToken = (subject: string) =>
			new SignJWT({ scope: "read write" })
				.setProtectedHeader({ alg: "RS256" })
				.setSubject(subject)
				.setAudience("test-audience")
				.setIssuedAt()
				.setExpirationTime("5m")
				.sign(privateKey);

		const ownerToken = await signToken("user_clerk_comments_owner");
		const outsiderToken = await signToken("user_clerk_comments_outsider");

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const createResponse = await app.handle(
			new Request(`http://localhost/evidences/${evidence.id}/comments`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${ownerToken}`,
				},
				body: JSON.stringify({ body: " Please check this transition. " }),
			}),
		);
		expect(createResponse.status).toBe(200);
		const createPayload = (await createResponse.json()) as {
			comment: {
				id: string;
				body: string;
				createdBy: string;
				authorLabel: string;
				createdAt: number;
			};
		};
		expect(createPayload.comment.body).toBe("Please check this transition.");
		expect(createPayload.comment.createdBy).toBe(owner.userId);
		expect(createPayload.comment.authorLabel).toBe(
			`User ${owner.userId.slice(0, 8)}`,
		);
		expect(createPayload.comment.createdAt).toBeNumber();

		const listResponse = await app.handle(
			new Request(`http://localhost/evidences/${evidence.id}/comments`, {
				headers: { authorization: `Bearer ${ownerToken}` },
			}),
		);
		expect(listResponse.status).toBe(200);
		const listPayload = (await listResponse.json()) as {
			comments: Array<{ id: string; body: string }>;
		};
		expect(listPayload.comments).toMatchObject([
			{ id: createPayload.comment.id, body: "Please check this transition." },
		]);

		const outsiderResponse = await app.handle(
			new Request(`http://localhost/evidences/${evidence.id}/comments`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${outsiderToken}`,
				},
				body: JSON.stringify({ body: "I should not get in" }),
			}),
		);
		expect(outsiderResponse.status).toBe(404);

		const stored = await db.query.evidenceComments.findMany({
			where: eq(evidenceComments.evidenceId, evidence.id),
			columns: { body: true },
		});
		expect(stored).toEqual([{ body: "Please check this transition." }]);
		expect(outsider.organizationId).not.toBe(owner.organizationId);
	});

	it("enforces internal-only share link resolution and revoke flow", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const owner = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_share_owner",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_share_owner" },
		});
		const outsider = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_share_outsider",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_share_outsider" },
		});

		const [evidence] = await db
			.insert(evidences)
			.values({
				orgId: owner.organizationId,
				createdBy: owner.userId,
				title: "Shareable evidence",
				sourceType: "browser",
				scopeType: "organization",
				scopeId: owner.organizationId,
			})
			.returning({ id: evidences.id });
		if (!evidence) {
			throw new Error("Expected evidence to be created");
		}

		const { privateKey, jwtKey } = await getAuthFixture();
		const signToken = (subject: string) =>
			new SignJWT({ scope: "read write" })
				.setProtectedHeader({ alg: "RS256" })
				.setSubject(subject)
				.setAudience("test-audience")
				.setIssuedAt()
				.setExpirationTime("5m")
				.sign(privateKey);

		const ownerToken = await signToken("user_clerk_share_owner");
		const outsiderToken = await signToken("user_clerk_share_outsider");

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const createResponse = await app.handle(
			new Request(`http://localhost/evidences/${evidence.id}/share-links`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${ownerToken}`,
				},
				body: JSON.stringify({ expiresInMs: 60_000 }),
			}),
		);
		expect(createResponse.status).toBe(200);
		const createdPayload = (await createResponse.json()) as {
			shareLink: { id: string; slug: string; token: string };
		};
		expect(createdPayload.shareLink.slug).toBeString();

		const unauthResolve = await app.handle(
			new Request(
				`http://localhost/share-links/${createdPayload.shareLink.slug}/resolve`,
			),
		);
		expect(unauthResolve.status).toBe(401);

		const outsiderResolve = await app.handle(
			new Request(
				`http://localhost/share-links/${createdPayload.shareLink.slug}/resolve`,
				{
					headers: { authorization: `Bearer ${outsiderToken}` },
				},
			),
		);
		expect(outsiderResolve.status).toBe(200);
		const outsiderPayload = (await outsiderResolve.json()) as {
			shareLink: { access: string };
			organization: { id: string; name: string };
		};
		expect(outsiderPayload.shareLink.access).toBe("denied");
		expect(outsiderPayload.organization.id).toBe(owner.organizationId);
		expect(outsiderPayload.organization.name).toBeString();

		const ownerResolve = await app.handle(
			new Request(
				`http://localhost/share-links/${createdPayload.shareLink.slug}/resolve`,
				{
					headers: { authorization: `Bearer ${ownerToken}` },
				},
			),
		);
		expect(ownerResolve.status).toBe(200);

		const revokeResponse = await app.handle(
			new Request(
				`http://localhost/share-links/${createdPayload.shareLink.id}/revoke`,
				{
					method: "POST",
					headers: { authorization: `Bearer ${ownerToken}` },
				},
			),
		);
		expect(revokeResponse.status).toBe(200);

		const revokedResolve = await app.handle(
			new Request(
				`http://localhost/share-links/${createdPayload.shareLink.slug}/resolve`,
				{
					headers: { authorization: `Bearer ${ownerToken}` },
				},
			),
		);
		expect(revokedResolve.status).toBe(404);

		const persisted = await db.query.shareLinks.findFirst({
			where: eq(shareLinks.id, createdPayload.shareLink.id),
			columns: { revokedAt: true },
		});
		expect(persisted?.revokedAt).toBeNumber();
		expect(outsider.organizationId).not.toBe(owner.organizationId);
	});

	it("treats expired links as non-resolvable", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const owner = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_share_expiry",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_share_expiry" },
		});

		const [evidence] = await db
			.insert(evidences)
			.values({
				orgId: owner.organizationId,
				createdBy: owner.userId,
				title: "Expiring evidence",
				sourceType: "browser",
				scopeType: "organization",
				scopeId: owner.organizationId,
			})
			.returning({ id: evidences.id });
		if (!evidence) {
			throw new Error("Expected evidence to be created");
		}

		const { privateKey, jwtKey } = await getAuthFixture();
		const token = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_share_expiry")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const createResponse = await app.handle(
			new Request(`http://localhost/evidences/${evidence.id}/share-links`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({ expiresInMs: 60_000 }),
			}),
		);
		expect(createResponse.status).toBe(200);
		const payload = (await createResponse.json()) as {
			shareLink: { slug: string; token: string };
		};

		const now = Date.now();
		await db
			.update(shareLinks)
			.set({ expiresAt: now - 1, updatedAt: now })
			.where(eq(shareLinks.evidenceId, evidence.id));

		const resolveResponse = await app.handle(
			new Request(
				`http://localhost/share-links/${payload.shareLink.slug}/resolve`,
				{ headers: { authorization: `Bearer ${token}` } },
			),
		);
		expect(resolveResponse.status).toBe(404);
		await expectApiError(resolveResponse, {
			code: "SHARE_LINK_NOT_FOUND",
			message: "Share link is invalid, expired, or revoked",
			status: 404,
		});
	});

	it("blocks evidence moves from members who are not creators or owners", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const owner = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_move_owner",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_move_owner" },
		});
		const member = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_move_member",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_move_member" },
		});

		const [targetOrg] = await db
			.insert(organizations)
			.values({ name: "Move target org", isPersonal: false })
			.returning({ id: organizations.id });
		if (!targetOrg) {
			throw new Error("Expected target organization to be created");
		}

		await db.insert(organizationMembers).values([
			{
				organizationId: owner.organizationId,
				userId: member.userId,
				role: "member",
			},
			{
				organizationId: targetOrg.id,
				userId: owner.userId,
				role: "owner",
			},
			{
				organizationId: targetOrg.id,
				userId: member.userId,
				role: "member",
			},
		]);

		const [evidence] = await db
			.insert(evidences)
			.values({
				orgId: owner.organizationId,
				createdBy: owner.userId,
				title: "Move protected evidence",
				sourceType: "browser",
				scopeType: "organization",
				scopeId: owner.organizationId,
			})
			.returning({ id: evidences.id });
		if (!evidence) {
			throw new Error("Expected evidence to be created");
		}

		const { privateKey, jwtKey } = await getAuthFixture();
		const memberToken = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_move_member")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const response = await app.handle(
			new Request(`http://localhost/evidences/${evidence.id}/move`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${memberToken}`,
				},
				body: JSON.stringify({ targetOrgId: targetOrg.id }),
			}),
		);

		expect(response.status).toBe(403);
		await expectApiError(response, {
			code: "EVIDENCE_MOVE_FORBIDDEN",
			message: "Only the recorder can move this evidence",
			status: 403,
		});
	});

	it("copies evidence to another workspace and keeps the original in place", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const owner = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_copy_owner",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_copy_owner" },
		});
		const copier = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_copy_member",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_copy_member" },
		});

		const [targetOrg] = await db
			.insert(organizations)
			.values({ name: "Copy destination", isPersonal: false })
			.returning({ id: organizations.id });
		if (!targetOrg) {
			throw new Error("Expected target organization to be created");
		}

		await db.insert(organizationMembers).values([
			{
				organizationId: owner.organizationId,
				userId: copier.userId,
				role: "member",
			},
			{
				organizationId: targetOrg.id,
				userId: copier.userId,
				role: "owner",
			},
		]);

		const [evidence] = await db
			.insert(evidences)
			.values({
				orgId: owner.organizationId,
				createdBy: owner.userId,
				title: "Copyable evidence",
				sourceType: "browser",
				scopeType: "organization",
				scopeId: owner.organizationId,
			})
			.returning({ id: evidences.id });
		if (!evidence) {
			throw new Error("Expected evidence to be created");
		}

		await db.insert(evidenceArtifacts).values({
			evidenceId: evidence.id,
			kind: "recording",
			s3Key: `uploads/${owner.organizationId}/${evidence.id}/recording`,
			mimeType: "video/webm",
			bytes: 123,
			checksum: "checksum-copy-source",
			uploadStatus: "uploaded",
		});

		const { privateKey, jwtKey } = await getAuthFixture();
		const copierToken = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_copy_member")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const response = await app.handle(
			new Request(`http://localhost/evidences/${evidence.id}/copy`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${copierToken}`,
				},
				body: JSON.stringify({ targetOrgId: targetOrg.id }),
			}),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			evidence: { id: string; orgId: string; sourceEvidenceId: string };
			copy: { artifactCount: number; fromOrgId: string; toOrgId: string };
		};
		expect(payload.evidence.id).not.toBe(evidence.id);
		expect(payload.evidence.orgId).toBe(targetOrg.id);
		expect(payload.evidence.sourceEvidenceId).toBe(evidence.id);
		expect(payload.copy.artifactCount).toBe(1);
		expect(payload.copy.fromOrgId).toBe(owner.organizationId);
		expect(payload.copy.toOrgId).toBe(targetOrg.id);

		const original = await db.query.evidences.findFirst({
			where: eq(evidences.id, evidence.id),
			columns: { orgId: true, createdBy: true },
		});
		expect(original?.orgId).toBe(owner.organizationId);
		expect(original?.createdBy).toBe(owner.userId);

		const copied = await db.query.evidences.findFirst({
			where: eq(evidences.id, payload.evidence.id),
			columns: { orgId: true, createdBy: true, scopeId: true },
		});
		expect(copied?.orgId).toBe(targetOrg.id);
		expect(copied?.createdBy).toBe(copier.userId);
		expect(copied?.scopeId).toBe(targetOrg.id);

		const copiedArtifacts = await db.query.evidenceArtifacts.findMany({
			where: eq(evidenceArtifacts.evidenceId, payload.evidence.id),
			columns: { s3Key: true, uploadStatus: true },
		});
		expect(copiedArtifacts).toEqual([
			{
				s3Key: `uploads/${owner.organizationId}/${evidence.id}/recording`,
				uploadStatus: "uploaded",
			},
		]);

		const activity = await db.query.organizationActivityLogs.findMany({
			where: inArray(organizationActivityLogs.organizationId, [
				owner.organizationId,
				targetOrg.id,
			]),
			columns: { organizationId: true, action: true, entityId: true },
		});
		expect(activity).toContainEqual({
			organizationId: owner.organizationId,
			action: "evidence.copied.out",
			entityId: evidence.id,
		});
		expect(activity).toContainEqual({
			organizationId: targetOrg.id,
			action: "evidence.copied.in",
			entityId: payload.evidence.id,
		});
	});

	it("moves evidence transactionally and invalidates share links", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const creator = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_move_creator",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_move_creator" },
		});

		const [targetOrg] = await db
			.insert(organizations)
			.values({ name: "Move destination", isPersonal: false })
			.returning({ id: organizations.id });
		if (!targetOrg) {
			throw new Error("Expected target organization to be created");
		}

		await db.insert(organizationMembers).values({
			organizationId: targetOrg.id,
			userId: creator.userId,
			role: "owner",
		});

		const [evidence] = await db
			.insert(evidences)
			.values({
				orgId: creator.organizationId,
				createdBy: creator.userId,
				title: "Movable evidence",
				sourceType: "browser",
				scopeType: "organization",
				scopeId: creator.organizationId,
			})
			.returning({ id: evidences.id });
		if (!evidence) {
			throw new Error("Expected evidence to be created");
		}

		await db.insert(shareLinks).values([
			{
				tokenHash: crypto.randomUUID().replaceAll("-", ""),
				evidenceId: evidence.id,
				orgId: creator.organizationId,
				scopeType: "organization",
				scopeId: creator.organizationId,
				expiresAt: Date.now() + 60_000,
				createdBy: creator.userId,
			},
			{
				tokenHash: `${crypto.randomUUID().replaceAll("-", "")}abc`,
				evidenceId: evidence.id,
				orgId: creator.organizationId,
				scopeType: "organization",
				scopeId: creator.organizationId,
				expiresAt: Date.now() + 60_000,
				createdBy: creator.userId,
			},
		]);

		const { privateKey, jwtKey } = await getAuthFixture();
		const creatorToken = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_move_creator")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const response = await app.handle(
			new Request(`http://localhost/evidences/${evidence.id}/move`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${creatorToken}`,
				},
				body: JSON.stringify({ targetOrgId: targetOrg.id }),
			}),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			evidence: { orgId: string };
			move: {
				invalidatedShareLinks: number;
				fromOrgId: string;
				toOrgId: string;
			};
		};
		expect(payload.evidence.orgId).toBe(targetOrg.id);
		expect(payload.move.fromOrgId).toBe(creator.organizationId);
		expect(payload.move.toOrgId).toBe(targetOrg.id);
		expect(payload.move.invalidatedShareLinks).toBe(2);

		const movedEvidence = await db.query.evidences.findFirst({
			where: eq(evidences.id, evidence.id),
			columns: { orgId: true, scopeId: true },
		});
		expect(movedEvidence?.orgId).toBe(targetOrg.id);
		expect(movedEvidence?.scopeId).toBe(targetOrg.id);

		const remainingLinks = await db.query.shareLinks.findMany({
			where: eq(shareLinks.evidenceId, evidence.id),
			columns: { id: true },
		});
		expect(remainingLinks).toHaveLength(0);
	});

	it("renames evidence for a workspace member", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const member = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_rename_member",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_rename_member" },
		});

		const [evidence] = await db
			.insert(evidences)
			.values({
				orgId: member.organizationId,
				createdBy: member.userId,
				title: "Original title",
				sourceType: "browser",
				scopeType: "organization",
				scopeId: member.organizationId,
			})
			.returning({ id: evidences.id });
		if (!evidence) {
			throw new Error("Expected evidence to be created");
		}

		const { privateKey, jwtKey } = await getAuthFixture();
		const memberToken = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_rename_member")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const response = await app.handle(
			new Request(`http://localhost/evidences/${evidence.id}`, {
				method: "PATCH",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${memberToken}`,
				},
				body: JSON.stringify({ title: "Renamed checkout regression" }),
			}),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			evidence: { id: string; title: string };
		};
		expect(payload.evidence.title).toBe("Renamed checkout regression");

		const renamed = await db.query.evidences.findFirst({
			where: eq(evidences.id, evidence.id),
			columns: { title: true },
		});
		expect(renamed?.title).toBe("Renamed checkout regression");
	});

	it("allows members to rename their own evidence without update role permissions", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		if (!db) {
			throw new Error("Database was not created");
		}

		const owner = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_own_rename_owner",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_own_rename_owner" },
		});
		const member = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_own_rename_member",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_own_rename_member" },
		});
		await db.insert(organizationMembers).values({
			organizationId: owner.organizationId,
			userId: member.userId,
			role: "developer",
		});

		const [ownEvidence, othersEvidence] = await db
			.insert(evidences)
			.values([
				{
					orgId: owner.organizationId,
					createdBy: member.userId,
					title: "Member-owned evidence",
					sourceType: "browser",
					scopeType: "organization",
					scopeId: owner.organizationId,
				},
				{
					orgId: owner.organizationId,
					createdBy: owner.userId,
					title: "Owner evidence",
					sourceType: "browser",
					scopeType: "organization",
					scopeId: owner.organizationId,
				},
			])
			.returning({ id: evidences.id });
		if (!ownEvidence || !othersEvidence) {
			throw new Error("Expected evidence records to be created");
		}

		const { privateKey, jwtKey } = await getAuthFixture();
		const memberToken = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_own_rename_member")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const ownResponse = await app.handle(
			new Request(`http://localhost/evidences/${ownEvidence.id}`, {
				method: "PATCH",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${memberToken}`,
				},
				body: JSON.stringify({ title: "Renamed by creator" }),
			}),
		);
		expect(ownResponse.status).toBe(200);

		const othersResponse = await app.handle(
			new Request(`http://localhost/evidences/${othersEvidence.id}`, {
				method: "PATCH",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${memberToken}`,
				},
				body: JSON.stringify({ title: "Should not rename" }),
			}),
		);
		expect(othersResponse.status).toBe(403);
		await expectApiError(othersResponse, {
			code: "EVIDENCE_RENAME_FORBIDDEN",
			message:
				"Only permitted owners or evidence managers can rename this evidence",
			status: 403,
		});
	});

	it("mints a desktop token only once per approved flow", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);
		const { privateKey, jwtKey } = await getAuthFixture();
		const clerkToken = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_desktop_single_use")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		const { app } = createApp(
			createTestEnv({
				DATABASE_URL: databaseUrl,
				CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZSQ",
				CLERK_JWT_KEY: jwtKey,
				CLERK_AUDIENCE: "test-audience",
				WEB_APP_ORIGIN: "https://viewer.example.test",
			}),
		);

		const started = (await (
			await app.handle(
				new Request("http://localhost/desktop-auth/flows", { method: "POST" }),
			)
		).json()) as { deviceCode: string; userCode: string };

		await app.handle(
			new Request("http://localhost/desktop-auth/flows/complete", {
				method: "POST",
				headers: {
					authorization: `Bearer ${clerkToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ userCode: started.userCode }),
			}),
		);

		const firstPoll = (await (
			await app.handle(
				new Request(
					`http://localhost/desktop-auth/flows/${encodeURIComponent(started.deviceCode)}`,
				),
			)
		).json()) as { status: string; accessToken?: string };
		expect(firstPoll.status).toBe("approved");
		expect(firstPoll.accessToken).toBeString();

		const secondPoll = (await (
			await app.handle(
				new Request(
					`http://localhost/desktop-auth/flows/${encodeURIComponent(started.deviceCode)}`,
				),
			)
		).json()) as { status: string; accessToken?: string };
		expect(secondPoll.status).toBe("expired");
		expect(secondPoll.accessToken).toBeUndefined();
	});

	it("rejects a revoked device session token", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);
		const db = createDb(databaseUrl);
		if (!db) {
			throw new Error("Database was not created");
		}
		const { privateKey, jwtKey } = await getAuthFixture();
		const clerkToken = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_desktop_revoke")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		const { app } = createApp(
			createTestEnv({
				DATABASE_URL: databaseUrl,
				CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZSQ",
				CLERK_JWT_KEY: jwtKey,
				CLERK_AUDIENCE: "test-audience",
				WEB_APP_ORIGIN: "https://viewer.example.test",
			}),
		);

		const started = (await (
			await app.handle(
				new Request("http://localhost/desktop-auth/flows", { method: "POST" }),
			)
		).json()) as { deviceCode: string; userCode: string };
		await app.handle(
			new Request("http://localhost/desktop-auth/flows/complete", {
				method: "POST",
				headers: {
					authorization: `Bearer ${clerkToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ userCode: started.userCode }),
			}),
		);
		const approved = (await (
			await app.handle(
				new Request(
					`http://localhost/desktop-auth/flows/${encodeURIComponent(started.deviceCode)}`,
				),
			)
		).json()) as { accessToken: string };

		const beforeRevoke = await app.handle(
			new Request("http://localhost/protected/me", {
				headers: { authorization: `Bearer ${approved.accessToken}` },
			}),
		);
		expect(beforeRevoke.status).toBe(200);

		const session = await db.query.deviceSessions.findFirst({
			where: eq(deviceSessions.clerkUserId, "user_desktop_revoke"),
			columns: { id: true },
		});
		expect(session?.id).toBeString();
		if (!session) {
			throw new Error("Expected device session to exist");
		}
		expect(await revokeDeviceSession(db, session.id)).toBe(true);

		const afterRevoke = await app.handle(
			new Request("http://localhost/protected/me", {
				headers: { authorization: `Bearer ${approved.accessToken}` },
			}),
		);
		expect(afterRevoke.status).toBe(401);
	});

	it("confines extension tokens to evidence scopes", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);
		const { privateKey, jwtKey } = await getAuthFixture();
		const clerkToken = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_extension_scope")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		const { app } = createApp(
			createTestEnv({
				DATABASE_URL: databaseUrl,
				CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZSQ",
				CLERK_JWT_KEY: jwtKey,
				CLERK_AUDIENCE: "test-audience",
				WEB_APP_ORIGIN: "https://viewer.example.test",
			}),
		);

		const started = (await (
			await app.handle(
				new Request("http://localhost/extension-auth/flows", {
					method: "POST",
				}),
			)
		).json()) as { deviceCode: string; userCode: string };
		await app.handle(
			new Request("http://localhost/extension-auth/flows/complete", {
				method: "POST",
				headers: {
					authorization: `Bearer ${clerkToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ userCode: started.userCode }),
			}),
		);
		const approved = (await (
			await app.handle(
				new Request(
					`http://localhost/extension-auth/flows/${encodeURIComponent(started.deviceCode)}`,
				),
			)
		).json()) as { accessToken: string };

		// Organization management is outside the extension's granted scopes.
		const orgsResponse = await app.handle(
			new Request("http://localhost/orgs", {
				headers: { authorization: `Bearer ${approved.accessToken}` },
			}),
		);
		expect(orgsResponse.status).toBe(403);
		await expectApiError(orgsResponse, {
			code: "AUTH_INSUFFICIENT_SCOPE",
			message:
				"This session is not permitted to perform this action (requires 'org:read')",
			status: 403,
		});

		// Uploading evidence is within scope and must still succeed.
		const uploadResponse = await app.handle(
			new Request("http://localhost/evidences/uploads/start", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${approved.accessToken}`,
				},
				body: JSON.stringify({
					title: "Extension upload",
					sourceType: "browser",
					artifact: {
						kind: "recording",
						mimeType: "video/webm",
						bytes: 11,
						checksum: `sha256:${await sha256Hex("hello world")}`,
					},
				}),
			}),
		);
		expect(uploadResponse.status).toBe(200);
		const upload = (await uploadResponse.json()) as { evidenceId: string };

		// Renaming evidence requires management scope, not just extension write scope.
		const renameResponse = await app.handle(
			new Request(`http://localhost/evidences/${upload.evidenceId}`, {
				method: "PATCH",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${approved.accessToken}`,
				},
				body: JSON.stringify({ title: "Renamed by extension token" }),
			}),
		);
		expect(renameResponse.status).toBe(403);
		await expectApiError(renameResponse, {
			code: "AUTH_INSUFFICIENT_SCOPE",
			message:
				"This session is not permitted to perform this action (requires 'evidence:manage')",
			status: 403,
		});
	});

	it("cleans up expired and revoked device auth state", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);
		const db = createDb(databaseUrl);
		if (!db) {
			throw new Error("Database was not created");
		}

		const now = 1_000_000_000_000;
		const [validSession] = await db
			.insert(deviceSessions)
			.values([
				{
					clerkUserId: "user_gc_valid",
					client: "desktop",
					scope: "evidence:read",
					expiresAt: now + 60_000,
					updatedAt: now,
				},
				{
					clerkUserId: "user_gc_expired",
					client: "extension",
					scope: "evidence:read",
					expiresAt: now - 60_000,
					updatedAt: now,
				},
				{
					clerkUserId: "user_gc_revoked",
					client: "desktop",
					scope: "evidence:read",
					expiresAt: now + 60_000,
					revokedAt: now - 1,
					updatedAt: now,
				},
			])
			.returning({ id: deviceSessions.id });
		if (!validSession) {
			throw new Error("Expected device session to be created");
		}

		await db.insert(desktopAuthFlows).values([
			{
				deviceCodeHash: "a".repeat(64),
				userCodeHash: "b".repeat(64),
				expiresAt: now - 60_000,
			},
			{
				deviceCodeHash: "c".repeat(64),
				userCodeHash: "d".repeat(64),
				expiresAt: now + 60_000,
			},
		]);

		const removed = await cleanupExpiredDeviceAuthState(db, now);
		expect(removed).toBe(2);

		const remainingSessions = await db.query.deviceSessions.findMany({
			columns: { id: true },
		});
		expect(remainingSessions.map((session) => session.id)).toEqual([
			validSession.id,
		]);

		const remainingFlows = await db.query.desktopAuthFlows.findMany({
			columns: { expiresAt: true },
		});
		expect(remainingFlows).toHaveLength(1);
		expect(remainingFlows[0]?.expiresAt).toBe(now + 60_000);
	});

	it("bulk soft-deletes selected evidence for moderators", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		if (!db) {
			throw new Error("Database was not created");
		}

		const owner = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_bulk_delete_owner",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_bulk_delete_owner" },
		});
		const moderator = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_bulk_delete_moderator",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_bulk_delete_moderator" },
		});
		await db.insert(organizationMembers).values({
			organizationId: owner.organizationId,
			userId: moderator.userId,
			role: "moderator",
		});

		const rows = await db
			.insert(evidences)
			.values([
				{
					orgId: owner.organizationId,
					createdBy: owner.userId,
					title: "Owner evidence",
					sourceType: "browser",
					scopeType: "organization",
					scopeId: owner.organizationId,
				},
				{
					orgId: owner.organizationId,
					createdBy: moderator.userId,
					title: "Moderator evidence",
					sourceType: "browser",
					scopeType: "organization",
					scopeId: owner.organizationId,
				},
			])
			.returning({ id: evidences.id });

		const { privateKey, jwtKey } = await getAuthFixture();
		const moderatorToken = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_bulk_delete_moderator")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const response = await app.handle(
			new Request("http://localhost/evidences/bulk-delete", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${moderatorToken}`,
				},
				body: JSON.stringify({ ids: rows.map((row) => row.id) }),
			}),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			evidences: Array<{
				id: string;
				deletedAt: number;
				deletePurgesAt: number;
			}>;
			deleted: { mode: "soft"; count: number };
		};
		expect(payload.deleted).toEqual({ mode: "soft", count: 2 });
		expect(payload.evidences.every((row) => row.deletedAt > 0)).toBeTrue();
		expect(
			payload.evidences.every((row) => row.deletePurgesAt > row.deletedAt),
		).toBeTrue();

		const persisted = await db.query.evidences.findMany({
			where: inArray(
				evidences.id,
				rows.map((row) => row.id),
			),
			columns: { id: true, deletedAt: true, deletedBy: true },
		});
		expect(persisted).toHaveLength(2);
		expect(persisted.every((row) => row.deletedAt !== null)).toBeTrue();
		expect(
			persisted.every((row) => row.deletedBy === moderator.userId),
		).toBeTrue();

		const listResponse = await app.handle(
			new Request("http://localhost/evidences", {
				headers: { authorization: `Bearer ${moderatorToken}` },
			}),
		);
		expect(listResponse.status).toBe(200);
		const listPayload = (await listResponse.json()) as {
			evidences: Array<{ id: string }>;
			total: number;
		};
		expect(listPayload.total).toBe(0);
		expect(listPayload.evidences).toHaveLength(0);
	});

	it("allows members to delete their own evidence without delete role permissions", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		if (!db) {
			throw new Error("Database was not created");
		}

		const owner = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_own_delete_owner",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_own_delete_owner" },
		});
		const member = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_own_delete_member",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_own_delete_member" },
		});
		await db.insert(organizationMembers).values({
			organizationId: owner.organizationId,
			userId: member.userId,
			role: "developer",
		});

		const [ownEvidence, othersEvidence] = await db
			.insert(evidences)
			.values([
				{
					orgId: owner.organizationId,
					createdBy: member.userId,
					title: "Member-owned evidence",
					sourceType: "browser",
					scopeType: "organization",
					scopeId: owner.organizationId,
				},
				{
					orgId: owner.organizationId,
					createdBy: owner.userId,
					title: "Owner evidence",
					sourceType: "browser",
					scopeType: "organization",
					scopeId: owner.organizationId,
				},
			])
			.returning({ id: evidences.id });
		if (!ownEvidence || !othersEvidence) {
			throw new Error("Expected evidence records to be created");
		}

		const { privateKey, jwtKey } = await getAuthFixture();
		const memberToken = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_own_delete_member")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const ownResponse = await app.handle(
			new Request(`http://localhost/evidences/${ownEvidence.id}`, {
				method: "DELETE",
				headers: { authorization: `Bearer ${memberToken}` },
			}),
		);
		expect(ownResponse.status).toBe(200);

		const othersResponse = await app.handle(
			new Request(`http://localhost/evidences/${othersEvidence.id}`, {
				method: "DELETE",
				headers: { authorization: `Bearer ${memberToken}` },
			}),
		);
		expect(othersResponse.status).toBe(403);
		await expectApiError(othersResponse, {
			code: "EVIDENCE_DELETE_FORBIDDEN",
			message:
				"Only the recorder, admins, or moderators can delete this evidence",
			status: 403,
		});
	});

	it("returns 404 (not 403) when a non-member targets evidence in another org", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);
		const db = createDb(databaseUrl);
		if (!db) {
			throw new Error("Database was not created");
		}

		const owner = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_enum_owner",
			source: "clerk-callback",
			rawPayload: { userId: "user_enum_owner" },
		});
		await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_enum_outsider",
			source: "clerk-callback",
			rawPayload: { userId: "user_enum_outsider" },
		});

		const [evidence] = await db
			.insert(evidences)
			.values({
				orgId: owner.organizationId,
				createdBy: owner.userId,
				title: "Private evidence",
				sourceType: "browser",
				scopeType: "organization",
				scopeId: owner.organizationId,
			})
			.returning({ id: evidences.id });
		if (!evidence) {
			throw new Error("Expected evidence to be created");
		}

		const { privateKey, jwtKey } = await getAuthFixture();
		const outsiderToken = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_enum_outsider")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const { app } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		});

		const renameResponse = await app.handle(
			new Request(`http://localhost/evidences/${evidence.id}`, {
				method: "PATCH",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${outsiderToken}`,
				},
				body: JSON.stringify({ title: "Renamed by outsider" }),
			}),
		);
		expect(renameResponse.status).toBe(404);
		await expectApiError(renameResponse, {
			code: "EVIDENCE_NOT_FOUND",
			message: "Evidence not found",
			status: 404,
		});

		const deleteResponse = await app.handle(
			new Request(`http://localhost/evidences/${evidence.id}`, {
				method: "DELETE",
				headers: { authorization: `Bearer ${outsiderToken}` },
			}),
		);
		expect(deleteResponse.status).toBe(404);
		await expectApiError(deleteResponse, {
			code: "EVIDENCE_NOT_FOUND",
			message: "Evidence not found",
			status: 404,
		});
	});
});
