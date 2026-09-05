import { expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { createApp } from "../src/app";
import { createDb } from "../src/db";
import {
	evidenceArtifacts,
	evidences,
	organizationMembers,
	organizationRoles,
	organizations,
} from "../src/db/schema";
import { ensureUserAndPersonalOrganization } from "../src/services/user-provisioning";
import { applyMigrations, getAuthFixture, TEST_APP_SECRET } from "./test-utils";

it("loads committed playback links together and rejects inaccessible or incomplete evidence", async () => {
	const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
	await applyMigrations(databaseUrl);
	const db = createDb(databaseUrl);
	if (!db) throw new Error("Database unavailable");
	const clerkUserId = "playback-test-user";
	const user = await ensureUserAndPersonalOrganization(db, {
		clerkUserId,
		source: "clerk-callback",
		rawPayload: {},
	});
	const [org] = await db
		.insert(organizations)
		.values({ name: "Playback", isPersonal: false })
		.returning();
	if (!org) throw new Error("Organization unavailable");
	await db
		.insert(organizationMembers)
		.values({ organizationId: org.id, userId: user.userId, role: "owner" });
	const [evidence] = await db
		.insert(evidences)
		.values({
			orgId: org.id,
			createdBy: user.userId,
			title: "Playback",
			sourceType: "browser",
		})
		.returning();
	if (!evidence) throw new Error("Evidence unavailable");
	const artifact = (
		id: string,
		kind: "recording" | "network-log",
		mimeType: string,
		uploadStatus: "uploaded" | "pending",
		createdAt: number,
	) => ({
		id,
		evidenceId: evidence.id,
		kind,
		mimeType,
		uploadStatus,
		createdAt,
		s3Key: `private/${id}`,
		bytes: 42,
		checksum: "checksum",
	});
	await db
		.insert(evidenceArtifacts)
		.values([
			artifact("webm", "recording", "video/webm", "uploaded", 1),
			artifact("mp4", "recording", "video/mp4", "uploaded", 2),
			artifact("pending", "recording", "video/mp4", "pending", 3),
			artifact("archive", "network-log", "application/json", "uploaded", 4),
		]);
	const { privateKey, jwtKey } = await getAuthFixture();
	const token = await new SignJWT({ scope: "read write" })
		.setProtectedHeader({ alg: "RS256" })
		.setSubject(clerkUserId)
		.setAudience("test-audience")
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(privateKey);
	const signedKeys: string[] = [];
	const { app } = createApp(
		{
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
		},
		{
			artifactStorage: {
				mode: "s3",
				putObject: async () => {},
				getObject: async () => new Uint8Array(),
				deleteObject: async () => {},
				createReadUrl: async ({ key }) => {
					signedKeys.push(key);
					return {
						url: `https://storage.test/${key}`,
						expiresAt: Date.now() + 900000,
						ttlSeconds: 900,
					};
				},
			},
		},
	);
	const request = (orgId = org.id, authenticated = true) =>
		app.handle(
			new Request(
				`http://localhost/evidences/${evidence.id}/playback?orgId=${orgId}`,
				{ headers: authenticated ? { authorization: `Bearer ${token}` } : {} },
			),
		);
	const response = await request();
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("private, no-store");
	const body = await response.json();
	expect(body.evidence.id).toBe(evidence.id);
	expect(body.evidence.createdByProfile).toBeNull();
	expect(
		body.readUrls.map((url: { artifactId: string }) => url.artifactId),
	).toEqual(["mp4", "archive"]);
	expect(body.artifacts.every((item: object) => !("s3Key" in item))).toBe(true);
	expect(signedKeys).toEqual(["private/mp4", "private/archive"]);
	expect((await request(org.id, false)).status).toBe(401);
	expect((await request(crypto.randomUUID())).status).toBe(403);
	await db
		.update(organizationMembers)
		.set({ role: "developer" })
		.where(eq(organizationMembers.organizationId, org.id));
	for (const permissions of [["evidence.view"], ["evidence.download"]]) {
		await db
			.update(organizationRoles)
			.set({ permissionsJson: JSON.stringify(permissions) })
			.where(eq(organizationRoles.organizationId, org.id));
		expect((await request()).status).toBe(403);
	}
	await db
		.delete(organizationRoles)
		.where(eq(organizationRoles.organizationId, org.id));
	await db
		.delete(organizationMembers)
		.where(eq(organizationMembers.organizationId, org.id));
	expect((await request()).status).toBe(403);
	await db
		.insert(organizationMembers)
		.values({ organizationId: org.id, userId: user.userId, role: "owner" });
	await db
		.update(evidenceArtifacts)
		.set({ uploadStatus: "pending" })
		.where(eq(evidenceArtifacts.id, "archive"));
	expect((await request()).status).toBe(409);
	await db
		.update(evidences)
		.set({ deletedAt: Date.now() })
		.where(eq(evidences.id, evidence.id));
	expect((await request()).status).toBe(404);
	expect(signedKeys).toHaveLength(2);
});
