import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";

import { createApp } from "../src/app";
import { createDb } from "../src/db";
import {
	evidences,
	organizationMembers,
	organizations,
	users,
} from "../src/db/schema";
import { ensureUserAndPersonalOrganization } from "../src/services/user-provisioning";
import {
	applyMigrations,
	expectApiError,
	getAuthFixture,
	TEST_APP_SECRET,
} from "./test-utils";

// Anyone in the organisation who can view its evidence can tag it; the organisation's tag list
// (create, rename, delete) stays with evidence.tags.manage (moderators and admins).

const setup = async () => {
	const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
	await applyMigrations(databaseUrl);
	const db = createDb(databaseUrl);
	if (!db) throw new Error("Database was not created");

	const [team] = await db
		.insert(organizations)
		.values({ name: "Tagging team", isPersonal: false })
		.returning({ id: organizations.id });
	if (!team) throw new Error("Failed to create team organization");

	const { privateKey, jwtKey } = await getAuthFixture();
	const tokenFor = (clerkUserId: string) =>
		new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject(clerkUserId)
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

	const member = async (clerkUserId: string, role: string | null) => {
		const provisioned = await ensureUserAndPersonalOrganization(db, {
			clerkUserId,
			source: "clerk-callback",
			rawPayload: { userId: clerkUserId },
		});
		// An outsider stays in their personal organisation only.
		if (role === null)
			return { ...provisioned, token: await tokenFor(clerkUserId) };
		await db.insert(organizationMembers).values({
			organizationId: team.id,
			userId: provisioned.userId,
			role,
		});
		await db
			.update(users)
			.set({ activeOrgId: team.id, updatedAt: Date.now() })
			.where(eq(users.id, provisioned.userId));
		return { ...provisioned, token: await tokenFor(clerkUserId) };
	};

	const { app } = createApp({
		NODE_ENV: "development",
		DATABASE_URL: databaseUrl,
		APP_VERSION: "9.9.9",
		APP_SECRET: TEST_APP_SECRET,
		CLERK_JWT_KEY: jwtKey,
		CLERK_AUDIENCE: "test-audience",
	});
	const request = (
		token: string,
		path: string,
		method = "GET",
		body?: unknown,
	) =>
		app.handle(
			new Request(`http://localhost${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);

	const owner = await member("user_clerk_tags_owner", "admin");
	const [evidence] = await db
		.insert(evidences)
		.values({
			orgId: team.id,
			createdBy: owner.userId,
			title: "Checkout crash",
			sourceType: "browser",
			scopeType: "organization",
			scopeId: team.id,
		})
		.returning({ id: evidences.id });
	if (!evidence) throw new Error("Expected evidence");

	return { team, evidence, member, request };
};

const listTags = async (
	request: Awaited<ReturnType<typeof setup>>["request"],
	token: string,
) => {
	const response = await request(token, "/evidences/tags");
	expect(response.status).toBe(200);
	return ((await response.json()) as { tags: { id: string; name: string }[] })
		.tags;
};

describe("evidence tags", () => {
	it("lets a developer tag evidence in their organisation", async () => {
		const { evidence, member, request } = await setup();
		const developer = await member("user_clerk_tags_developer", "developer");
		const [first, second] = await listTags(request, developer.token);
		if (!first || !second) throw new Error("Expected default tags");

		const response = await request(
			developer.token,
			`/evidences/${evidence.id}/tags`,
			"PATCH",
			{
				tagIds: [first.id, second.id],
			},
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			evidence: { tags: { id: string }[] };
		};
		expect(body.evidence.tags.map((tag) => tag.id).sort()).toEqual(
			[first.id, second.id].sort(),
		);
	});

	it("lets a developer clear the tags", async () => {
		const { evidence, member, request } = await setup();
		const developer = await member(
			"user_clerk_tags_developer_clear",
			"developer",
		);

		const response = await request(
			developer.token,
			`/evidences/${evidence.id}/tags`,
			"PATCH",
			{ tagIds: [] },
		);

		expect(response.status).toBe(200);
	});

	it("keeps the tag list itself with moderators and admins", async () => {
		const { member, request } = await setup();
		const developer = await member(
			"user_clerk_tags_developer_create",
			"developer",
		);

		const response = await request(developer.token, "/evidences/tags", "POST", {
			name: "Flaky",
			color: "#ef4444",
		});

		expect(response.status).toBe(403);
		await expectApiError(response, {
			code: "EVIDENCE_TAGS_MANAGE_FORBIDDEN",
			message: "Your role cannot manage evidence tags",
			status: 403,
		});
	});

	it("refuses someone outside the organisation", async () => {
		const { evidence, member, request } = await setup();
		const outsider = await member("user_clerk_tags_outsider", null);

		const response = await request(
			outsider.token,
			`/evidences/${evidence.id}/tags`,
			"PATCH",
			{ tagIds: [] },
		);

		expect(response.status).toBe(403);
		await expectApiError(response, {
			code: "EVIDENCE_TAGS_FORBIDDEN",
			message: "Your role cannot update evidence tags",
			status: 403,
		});
	});
});
