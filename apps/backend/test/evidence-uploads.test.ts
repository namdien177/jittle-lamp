import { describe, expect, it } from "bun:test";
import { recordingFileName, sessionArchiveFileName } from "@jittle-lamp/shared";
import { eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { SignJWT } from "jose";

import { createApp } from "../src/app";
import { createDb } from "../src/db";
import {
	automationApiTokens,
	evidenceArtifacts,
	evidences,
	organizationMembers,
	organizations,
	users,
} from "../src/db/schema";
import { ensureUserAndPersonalOrganization } from "../src/services/user-provisioning";
import { MAX_VIDEO_UPLOAD_BYTES } from "../src/services/video-normalizer";
import {
	applyMigrations,
	bytesBody,
	createAutomationEvidenceZip,
	expectApiError,
	getAuthFixture,
	sha256Hex,
	TEST_APP_SECRET,
} from "./test-utils";

describe("evidence upload routes", () => {
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

	it("creates manual uploads with recording and empty archive artifacts", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		const provisioned = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_manual_upload",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_manual_upload" },
		});

		const { privateKey, jwtKey } = await getAuthFixture();
		const token = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_manual_upload")
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);

		const normalizedRecording = new TextEncoder().encode("720p mp4");
		const { app } = createApp(
			{
				NODE_ENV: "development",
				DATABASE_URL: databaseUrl,
				APP_VERSION: "9.9.9",
				APP_SECRET: TEST_APP_SECRET,
				CLERK_JWT_KEY: jwtKey,
				CLERK_AUDIENCE: "test-audience",
			},
			{
				videoNormalizer: async () => ({
					payload: normalizedRecording,
					mimeType: "video/mp4",
				}),
			},
		);

		const recordingBody = "manual mp4 bytes";
		const archiveBody = JSON.stringify({
			schemaVersion: 3,
			sections: { actions: [], console: [], network: [] },
		});
		const sourceMetadata = JSON.stringify({
			localSessionId: "jl_manual_test_001",
			artifactFormat: "split",
			uploadMode: "raw-video",
			generatedArchive: true,
			durationMs: null,
			actionCount: 0,
			requestCount: 0,
		});
		const oversizedResponse = await app.handle(
			new Request("http://localhost/evidences/manual-uploads/start", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					sessionId: "jl_manual_too_large",
					title: "Oversized video",
					artifacts: [
						{
							key: "recording",
							kind: "recording",
							mimeType: "video/mp4",
							bytes: MAX_VIDEO_UPLOAD_BYTES + 1,
							checksum: "sha256:oversized",
						},
						{
							key: "archive",
							kind: "network-log",
							mimeType: "application/json",
							bytes: archiveBody.length,
							checksum: `sha256:${await sha256Hex(archiveBody)}`,
						},
					],
				}),
			}),
		);
		expect(oversizedResponse.status).toBe(413);
		await expectApiError(oversizedResponse, {
			code: "VIDEO_UPLOAD_TOO_LARGE",
			message: "Video files must be 60 MB or smaller",
			status: 413,
		});
		expect(
			await db.query.evidences.findFirst({
				where: eq(evidences.sourceExternalId, "jl_manual_too_large"),
			}),
		).toBeUndefined();
		const startResponse = await app.handle(
			new Request("http://localhost/evidences/manual-uploads/start", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					sessionId: "jl_manual_test_001",
					title: "Manual MP4 proof",
					sourceMetadata,
					artifacts: [
						{
							key: "recording",
							kind: "recording",
							mimeType: "video/mp4",
							bytes: recordingBody.length,
							checksum: `sha256:${await sha256Hex(recordingBody)}`,
						},
						{
							key: "archive",
							kind: "network-log",
							mimeType: "application/json",
							bytes: archiveBody.length,
							checksum: `sha256:${await sha256Hex(archiveBody)}`,
						},
					],
				}),
			}),
		);

		expect(startResponse.status).toBe(200);
		const startPayload = (await startResponse.json()) as {
			evidenceId: string;
			organizationId: string;
			uploadSessions: Array<{
				key: string;
				uploadId: string;
				uploadUrl: string;
			}>;
		};
		expect(startPayload.organizationId).toBe(provisioned.organizationId);
		expect(
			startPayload.uploadSessions.map((session) => session.key).sort(),
		).toEqual(["archive", "recording"]);

		for (const artifact of [
			{ key: "recording", body: recordingBody, mimeType: "video/mp4" },
			{ key: "archive", body: archiveBody, mimeType: "application/json" },
		]) {
			const uploadSession = startPayload.uploadSessions.find(
				(session) => session.key === artifact.key,
			);
			if (!uploadSession) throw new Error(`Missing ${artifact.key} upload`);

			const blobResponse = await app.handle(
				new Request(uploadSession.uploadUrl, {
					method: "PUT",
					headers: {
						"content-type": artifact.mimeType,
						authorization: `Bearer ${token}`,
					},
					body: artifact.body,
				}),
			);
			expect(blobResponse.status).toBe(204);

			const completeResponse = await app.handle(
				new Request(
					`http://localhost/evidences/uploads/${uploadSession.uploadId}/complete`,
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${token}`,
						},
						body: JSON.stringify({
							bytes: artifact.body.length,
							checksum: `sha256:${await sha256Hex(artifact.body)}`,
							mimeType: artifact.mimeType,
						}),
					},
				),
			);
			expect(completeResponse.status).toBe(200);
		}

		const createdEvidence = await db.query.evidences.findFirst({
			where: eq(evidences.id, startPayload.evidenceId),
			columns: {
				sourceType: true,
				sourceExternalId: true,
				sourceMetadata: true,
				createdBy: true,
				orgId: true,
			},
		});
		expect(createdEvidence).toMatchObject({
			sourceType: "manual-upload",
			sourceExternalId: "jl_manual_test_001",
			createdBy: provisioned.userId,
			orgId: provisioned.organizationId,
			sourceMetadata,
		});

		const artifacts = await db.query.evidenceArtifacts.findMany({
			where: eq(evidenceArtifacts.evidenceId, startPayload.evidenceId),
			columns: {
				kind: true,
				mimeType: true,
				bytes: true,
				uploadStatus: true,
			},
		});
		expect(artifacts).toHaveLength(2);
		expect(artifacts.map((artifact) => artifact.kind).sort()).toEqual([
			"network-log",
			"recording",
		]);
		expect(
			artifacts.every((artifact) => artifact.uploadStatus === "uploaded"),
		).toBe(true);
		expect(
			artifacts.find((artifact) => artifact.kind === "recording"),
		).toMatchObject({
			mimeType: "video/mp4",
			bytes: normalizedRecording.byteLength,
		});

		const evidenceResponse = await app.handle(
			new Request(`http://localhost/evidences/${startPayload.evidenceId}`, {
				headers: { authorization: `Bearer ${token}` },
			}),
		);
		expect(evidenceResponse.status).toBe(200);
		const evidencePayload = (await evidenceResponse.json()) as {
			evidence: {
				status: "ready" | "pending";
				sourceType: string;
				actionCount: number | null;
				requestCount: number | null;
			};
		};
		expect(evidencePayload.evidence).toMatchObject({
			status: "ready",
			sourceType: "manual-upload",
			actionCount: 0,
			requestCount: 0,
		});
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

	it("rejects oversized desktop recordings before creating evidence", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);

		const db = createDb(databaseUrl);
		expect(db).not.toBeNull();
		if (!db) {
			throw new Error("Database was not created");
		}

		await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_desktop_too_large",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_desktop_too_large" },
		});

		const { privateKey, jwtKey } = await getAuthFixture();
		const token = await new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_clerk_desktop_too_large")
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
			new Request("http://localhost/evidences/desktop-sessions/sync/start", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					sessionId: "jl_desktop_too_large",
					title: "Oversized desktop recording",
					artifacts: [
						{
							key: "recording",
							kind: "recording",
							mimeType: "video/webm",
							bytes: MAX_VIDEO_UPLOAD_BYTES + 1,
							checksum: "sha256:oversized",
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
			}),
		);

		expect(response.status).toBe(413);
		await expectApiError(response, {
			code: "VIDEO_UPLOAD_TOO_LARGE",
			message: "Video files must be 60 MB or smaller",
			status: 413,
		});
		expect(
			await db.query.evidences.findFirst({
				where: eq(evidences.sourceExternalId, "jl_desktop_too_large"),
			}),
		).toBeUndefined();
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
});
