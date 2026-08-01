import { describe, expect, it } from "bun:test";
import { SignJWT } from "jose";

import { createApp } from "../src/app";
import { createDb } from "../src/db";
import {
	organizationMembers,
	organizationMigrationLinks,
	organizationMigrationStates,
	organizations,
	users,
} from "../src/db/schema";
import {
	applyMigrations,
	createTestEnv,
	expectApiError,
	getAuthFixture,
} from "./test-utils";

describe("organization migration write lock", () => {
	it("returns HTTP 423 from ordinary organization mutation routes", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-migration-lock-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);
		const db = createDb(databaseUrl);
		if (!db) throw new Error("test database unavailable");
		const clerkUserId = "clerk_migration_locked_admin";
		const [user] = await db.insert(users).values({ clerkUserId }).returning();
		const [organization] = await db
			.insert(organizations)
			.values({
				name: "Locked Team",
				isPersonal: false,
				personalOwnerUserId: null,
			})
			.returning();
		if (!user || !organization) throw new Error("fixtures unavailable");
		await db.insert(organizationMembers).values({
			organizationId: organization.id,
			userId: user.id,
			role: "admin",
		});
		const [link] = await db
			.insert(organizationMigrationLinks)
			.values({
				direction: "outbound",
				localOrganizationId: organization.id,
				remoteInstanceId: crypto.randomUUID(),
				remoteApiOrigin: "https://target.example.test",
				remoteWebOrigin: "https://target.example.test",
				protocolVersion: "1.0",
				state: "finalizing",
			})
			.returning();
		if (!link) throw new Error("link unavailable");
		await db.insert(organizationMigrationStates).values({
			organizationId: organization.id,
			linkId: link.id,
			role: "source",
			accessState: "finalizing_read_only",
		});

		const { privateKey, jwtKey } = await getAuthFixture();
		const token = await new SignJWT({ scope: "org:read" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject(clerkUserId)
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		const { app } = createApp(
			createTestEnv({ DATABASE_URL: databaseUrl, CLERK_JWT_KEY: jwtKey }),
		);
		const response = await app.handle(
			new Request(`http://localhost/orgs/${organization.id}`, {
				method: "PATCH",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ name: "Mutation must fail" }),
			}),
		);
		expect(response.status).toBe(423);
		await expectApiError(response, {
			code: "ORG_MIGRATION_READ_ONLY",
			message: "This organization is read-only during or after migration",
			status: 423,
		});

		await expect(async () => {
			await db.insert(organizationMembers).values({
				organizationId: organization.id,
				userId: user.id,
				role: "developer",
				teamId: crypto.randomUUID(),
			});
		}).toThrow();

		await db
			.update(organizationMigrationStates)
			.set({ accessState: "importing" });
		const importingResponse = await app.handle(
			new Request(`http://localhost/orgs/${organization.id}`, {
				method: "PATCH",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ name: "Import must stay hidden" }),
			}),
		);
		expect(importingResponse.status).toBe(423);
	});
});
