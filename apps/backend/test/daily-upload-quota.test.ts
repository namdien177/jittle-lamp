import { describe, expect, it } from "bun:test";
import { SignJWT } from "jose";

import { createApp } from "../src/app";
import { createDb } from "../src/db";
import { evidenceArtifacts, evidences, organizations } from "../src/db/schema";
import {
	getDailyUploadQuota,
	ORGANIZATION_DAILY_UPLOAD_LIMIT_BYTES,
	PERSONAL_DAILY_UPLOAD_LIMIT_BYTES,
	startOfUtcDay,
} from "../src/services/daily-upload-quota";
import { ensureUserAndPersonalOrganization } from "../src/services/user-provisioning";
import {
	applyMigrations,
	expectApiError,
	getAuthFixture,
	TEST_APP_SECRET,
} from "./test-utils";

const MB = 1024 * 1024;

const createTestDb = async () => {
	const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
	await applyMigrations(databaseUrl);
	const db = createDb(databaseUrl);
	if (!db) {
		throw new Error("Database was not created");
	}
	return { databaseUrl, db };
};

describe("daily upload quota", () => {
	it("limits personal workspaces to 100 MB and organisations to 1.5 GB", async () => {
		const { db } = await createTestDb();
		const provisioned = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_quota_limits",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_quota_limits" },
		});
		const [team] = await db
			.insert(organizations)
			.values({ name: "Quota Team", isPersonal: false })
			.returning({ id: organizations.id });
		if (!team) throw new Error("Failed to create team organization");

		const personal = await getDailyUploadQuota(db, provisioned.organizationId);
		const organisation = await getDailyUploadQuota(db, team.id);

		expect(personal.limitBytes).toBe(PERSONAL_DAILY_UPLOAD_LIMIT_BYTES);
		expect(PERSONAL_DAILY_UPLOAD_LIMIT_BYTES).toBe(100 * MB);
		expect(organisation.limitBytes).toBe(ORGANIZATION_DAILY_UPLOAD_LIMIT_BYTES);
		expect(ORGANIZATION_DAILY_UPLOAD_LIMIT_BYTES).toBe(1536 * MB);
	});

	it("counts today's default-storage uploads but not failed, abandoned, earlier or own-storage ones", async () => {
		const { db } = await createTestDb();
		const provisioned = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_quota_usage",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_quota_usage" },
		});
		const orgId = provisioned.organizationId;
		const now = startOfUtcDay(Date.now()) + 12 * 60 * 60 * 1000;

		const [evidence] = await db
			.insert(evidences)
			.values({
				orgId,
				createdBy: provisioned.userId,
				title: "Quota usage",
				sourceType: "browser",
				scopeId: orgId,
				deletedAt: now,
			})
			.returning({ id: evidences.id });
		if (!evidence) throw new Error("Failed to create evidence");

		const artifact = (
			bytes: number,
			uploadStatus: "uploaded" | "uploading" | "failed",
			createdAt: number,
		) => ({
			evidenceId: evidence.id,
			kind: "attachment" as const,
			s3Key: `uploads/${crypto.randomUUID()}`,
			mimeType: "application/octet-stream",
			bytes,
			checksum: "sha256:abc",
			uploadStatus,
			createdAt,
		});
		await db.insert(evidenceArtifacts).values([
			artifact(10 * MB, "uploaded", now - 60_000),
			artifact(5 * MB, "uploading", now - 60_000),
			artifact(20 * MB, "uploading", now - 60 * 60 * 1000),
			artifact(30 * MB, "failed", now - 60_000),
			artifact(40 * MB, "uploaded", startOfUtcDay(now) - 1),
			{
				...artifact(50 * MB, "uploaded", now - 60_000),
				storageId: crypto.randomUUID(),
			},
		]);

		const quota = await getDailyUploadQuota(db, orgId, now);

		// Deleted evidence still counts: the limit is on what was added today. Bytes in the
		// organisation's own storage do not.
		expect(quota.usedBytes).toBe(15 * MB);
		expect(quota.windowStart).toBe(startOfUtcDay(now));
		expect(quota.resetsAt).toBe(startOfUtcDay(now) + 24 * 60 * 60 * 1000);
	});

	it("rejects an upload that would pass the personal daily limit", async () => {
		const { databaseUrl, db } = await createTestDb();
		await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_quota_route",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_quota_route" },
		});
		const { privateKey, jwtKey } = await getAuthFixture();
		const token = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_quota_route")
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

		const startUpload = (bytes: number) =>
			app.handle(
				new Request("http://localhost/evidences/uploads/start", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({
						title: "Quota upload",
						sourceType: "browser",
						artifact: {
							kind: "attachment",
							mimeType: "application/octet-stream",
							bytes,
							checksum: "sha256:abc",
						},
					}),
				}),
			);

		expect((await startUpload(60 * MB)).status).toBe(200);
		const rejected = await startUpload(50 * MB);
		expect(rejected.status).toBe(429);
		await expectApiError(rejected, {
			code: "DAILY_UPLOAD_LIMIT_EXCEEDED",
			message:
				"Daily upload limit of 100 MB reached for this organization (60 MB used today); it resets at 00:00 UTC",
			status: 429,
		});
		// The refused upload rolled back, so the remaining 40 MB is still available.
		expect((await startUpload(40 * MB)).status).toBe(200);
		expect((await db.select({ id: evidences.id }).from(evidences)).length).toBe(
			2,
		);
	});
});
