import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";

import { createApp } from "../src/app";
import { createDb } from "../src/db";
import { organizationMembers, organizations, users } from "../src/db/schema";
import { createAutomationApiToken } from "../src/services/automation-api-tokens";
import { ensureDefaultOrganizationRoles } from "../src/services/organization-permissions";
import { ensureUserAndPersonalOrganization } from "../src/services/user-provisioning";
import { applyMigrations, getAuthFixture, TEST_APP_SECRET } from "./test-utils";

// Integration fixture for the test-case platform: one team organisation with an admin, a QA
// engineer and a developer, each with a signed session token, and the Elysia app on top.

// Obviously fake secrets used across these tests.
export const FAKE_PASSWORD = "fake-Passw0rd-not-real";
export const FAKE_MODEL_KEY = "sk-fake-model-key-0000";

export type Member = {
	clerkUserId: string;
	userId: string;
	token: string;
};

export const createTestCaseFixture = async (
	options: {
		env?: Record<string, string | undefined>;
		dependencies?: Parameters<typeof createApp>[1];
	} = {},
) => {
	const databaseUrl = `file:/tmp/jittle-lamp-tc-${crypto.randomUUID()}.db`;
	await applyMigrations(databaseUrl);
	const db = createDb(databaseUrl);
	if (!db) throw new Error("Expected database");
	const [org] = await db
		.insert(organizations)
		.values({ name: "QA Platform", isPersonal: false })
		.returning({ id: organizations.id });
	if (!org) throw new Error("Expected organization");
	await ensureDefaultOrganizationRoles(db, org.id);
	const { privateKey, jwtKey } = await getAuthFixture();

	const member = async (role: string, orgId = org.id): Promise<Member> => {
		const clerkUserId = `user_tc_${role}_${crypto.randomUUID()}`;
		const provisioned = await ensureUserAndPersonalOrganization(db, {
			clerkUserId,
			source: "clerk-callback",
			rawPayload: {},
		});
		await db
			.insert(organizationMembers)
			.values({ organizationId: orgId, userId: provisioned.userId, role })
			.onConflictDoNothing();
		await db
			.update(users)
			.set({ activeOrgId: orgId })
			.where(eq(users.id, provisioned.userId));
		const token = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject(clerkUserId)
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("10m")
			.sign(privateKey);
		return { clerkUserId, userId: provisioned.userId, token };
	};

	const admin = await member("admin");
	const qa = await member("qa_engineer");
	const developer = await member("developer");

	const {
		app,
		artifactStorage,
		runtime,
		db: appDb,
	} = createApp(
		{
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
			JL_SECRETS_MASTER_KEY: randomBytes(32).toString("base64"),
			LOG_LEVEL: "error",
			...options.env,
		},
		options.dependencies,
	);

	const call = async <T = Record<string, unknown>>(
		path: string,
		init: {
			method?: string;
			token?: string | null;
			body?: unknown;
			raw?: BodyInit;
			headers?: Record<string, string>;
		} = {},
	): Promise<{ status: number; body: T; headers: Headers }> => {
		const headers: Record<string, string> = { ...init.headers };
		if (init.token) headers.authorization = `Bearer ${init.token}`;
		if (init.body !== undefined) headers["content-type"] = "application/json";
		const response = await app.handle(
			new Request(`http://localhost${path}`, {
				method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
				headers,
				...(init.raw !== undefined
					? { body: init.raw }
					: init.body !== undefined
						? { body: JSON.stringify(init.body) }
						: {}),
			}),
		);
		const text = await response.text();
		let body: unknown = text;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = text;
		}
		return {
			status: response.status,
			body: body as T,
			headers: response.headers,
		};
	};

	const automationToken = async (owner: Member) =>
		(
			await createAutomationApiToken(db, {
				userId: owner.userId,
				orgId: org.id,
				label: "CI",
				expiresAt: null,
			})
		).token;

	return {
		app,
		db,
		// The app's own database handle (per-db notification adapters are registered on it).
		appDb: appDb ?? db,
		databaseUrl,
		orgId: org.id,
		admin,
		qa,
		developer,
		member,
		call,
		artifactStorage,
		runtime,
		automationToken,
	};
};

export type TestCaseFixture = Awaited<ReturnType<typeof createTestCaseFixture>>;

export const loginTranscript = (title = "HQ admin logout clears the email") =>
	[
		`# ${title}`,
		"Tags: team:qa-pcf, feature:login, regression",
		"",
		"[Open] /login",
		"[Login: PCF_HQ_ADMIN] sign in as the HQ admin",
		'[Act] open the account menu and choose "Sign out"',
		"",
		"## Checkpoint: Logout returns a clean login form",
		"[Assert] the login form is shown again",
		"[Assert] the Email field is empty",
	].join("\n");
