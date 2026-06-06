import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";

import { createApp } from "../src/app";
import { parseEnv } from "../src/config/env";
import { createDb } from "../src/db";
import {
	desktopAuthFlows,
	deviceSessions,
	evidenceArtifacts,
	evidences,
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
import {
	acceptInvitationByToken,
	createOrganizationInvitationCode,
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
			role: "member",
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
		expect(payload.user).toMatchObject({
			displayName: "user_clerk_settings_profile",
			email: null,
		});
		expect(payload.activeOrgId).toBe(teamOrganization.id);
		expect(payload.organizations).toContainEqual({
			id: provisioned.organizationId,
			name: "My Space",
			role: "owner",
			isPersonal: true,
			isActive: false,
		});
		expect(payload.organizations).toContainEqual({
			id: teamOrganization.id,
			name: "Team Settings",
			role: "member",
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

		const startResponse = await app.handle(
			new Request("http://localhost/evidences/uploads/start", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
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
						],
					}),
				},
			),
		);
		expect(syncResponse.status).toBe(200);
		const syncPayload = (await syncResponse.json()) as {
			uploadSessions: Array<{ uploadUrl: string }>;
		};
		expect(syncPayload.uploadSessions).toHaveLength(2);
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

		expect(firstProvision.membershipRole).toBe("owner");
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
			role: "member",
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
		expect(accepted.role).toBe("member");

		const membership = await db.query.organizationMembers.findFirst({
			where: and(
				eq(organizationMembers.userId, joiner.userId),
				eq(organizationMembers.organizationId, owner.organizationId),
			),
			columns: { organizationId: true, role: true, guestExpiresAt: true },
		});
		expect(membership?.organizationId).toBe(owner.organizationId);
		expect(membership?.role).toBe("member");
		expect(membership?.guestExpiresAt).toBeNumber();
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
			role: "member",
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
			shareLink: { id: string; token: string };
		};

		const unauthResolve = await app.handle(
			new Request(
				`http://localhost/share-links/${createdPayload.shareLink.token}/resolve`,
			),
		);
		expect(unauthResolve.status).toBe(401);

		const outsiderResolve = await app.handle(
			new Request(
				`http://localhost/share-links/${createdPayload.shareLink.token}/resolve`,
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
				`http://localhost/share-links/${createdPayload.shareLink.token}/resolve`,
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
				`http://localhost/share-links/${createdPayload.shareLink.token}/resolve`,
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
			shareLink: { token: string };
		};

		const now = Date.now();
		await db
			.update(shareLinks)
			.set({ expiresAt: now - 1, updatedAt: now })
			.where(eq(shareLinks.evidenceId, evidence.id));

		const resolveResponse = await app.handle(
			new Request(
				`http://localhost/share-links/${payload.shareLink.token}/resolve`,
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
			message: "Only permitted creators can move this evidence",
			status: 403,
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
