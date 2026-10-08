import { describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";

import { createApp } from "../src/app";
import { createDb } from "../src/db";
import {
	evidenceArtifacts,
	evidences,
	organizationMembers,
	organizationStorageDailyUsage,
	organizations,
	users,
} from "../src/db/schema";
import type { ArtifactStorage } from "../src/services/artifact-storage";
import { recordStorageDailyUsage } from "../src/services/organization-storage";
import { createStorageTransferWorker } from "../src/services/storage-transfer";
import { ensureUserAndPersonalOrganization } from "../src/services/user-provisioning";
import {
	applyMigrations,
	getAuthFixture,
	sha256Hex,
	TEST_APP_SECRET,
} from "./test-utils";

// Obviously fake values; never real credentials.
const FAKE_ACCESS_KEY = "AKIAFAKEFORTESTS1234";
const FAKE_SECRET = "fake-secret-for-tests-only";

type Bucket = Map<string, Uint8Array>;

// In-memory S3: one map per bucket, a bucket named `broken-*` fails every call.
const createFakeS3 = () => {
	const buckets = new Map<string, Bucket>();
	const bucket = (name: string): Bucket => {
		let found = buckets.get(name);
		if (!found) {
			found = new Map();
			buckets.set(name, found);
		}
		return found;
	};
	const storageFor = (name: string): ArtifactStorage => {
		const fail = () => {
			if (name.startsWith("broken-")) throw new Error("AccessDenied");
		};
		return {
			mode: "s3",
			putObject: async ({ key, body }) => {
				fail();
				bucket(name).set(key, Uint8Array.from(body));
			},
			getObject: async ({ key }) => {
				fail();
				const body = bucket(name).get(key);
				if (!body) throw new Error(`NoSuchKey ${key}`);
				return Uint8Array.from(body);
			},
			deleteObject: async ({ key }) => {
				fail();
				bucket(name).delete(key);
			},
			createReadUrl: async ({ key }) => {
				fail();
				return {
					url: `https://${name}.storage.test/${key}`,
					expiresAt: Date.now() + 900_000,
					ttlSeconds: 900,
				};
			},
		};
	};
	return { bucket, storageFor };
};

const setup = async () => {
	const databaseUrl = `file:/tmp/jittle-lamp-storage-${crypto.randomUUID()}.db`;
	await applyMigrations(databaseUrl);
	const db = createDb(databaseUrl);
	if (!db) throw new Error("Database unavailable");
	const admin = await ensureUserAndPersonalOrganization(db, {
		clerkUserId: "storage-admin",
		source: "clerk-callback",
		rawPayload: {},
	});
	const developer = await ensureUserAndPersonalOrganization(db, {
		clerkUserId: "storage-developer",
		source: "clerk-callback",
		rawPayload: {},
	});
	const [org] = await db
		.insert(organizations)
		.values({ name: "Storage Org", isPersonal: false })
		.returning();
	if (!org) throw new Error("Organization unavailable");
	await db.insert(organizationMembers).values([
		{ organizationId: org.id, userId: admin.userId, role: "admin" },
		{ organizationId: org.id, userId: developer.userId, role: "developer" },
	]);
	for (const userId of [admin.userId, developer.userId]) {
		await db
			.update(users)
			.set({ activeOrgId: org.id })
			.where(eq(users.id, userId));
	}
	const { privateKey, jwtKey } = await getAuthFixture();
	const tokenFor = (subject: string) =>
		new SignJWT({ scope: "read write" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject(subject)
			.setAudience("test-audience")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
	const s3 = createFakeS3();
	const created = createApp(
		{
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_SECRET: TEST_APP_SECRET,
			CLERK_JWT_KEY: jwtKey,
			CLERK_AUDIENCE: "test-audience",
			JL_SECRETS_MASTER_KEY: randomBytes(32).toString("base64"),
		},
		{
			artifactStorage: s3.storageFor("jittle-lamp-default"),
			storageClientFactory: (config) => s3.storageFor(config.bucket),
		},
	);
	const adminToken = await tokenFor("storage-admin");
	const developerToken = await tokenFor("storage-developer");
	const call = async (
		method: string,
		path: string,
		options: { token?: string; body?: unknown } = {},
	) => {
		const response = await created.app.handle(
			new Request(`http://localhost${path}`, {
				method,
				headers: {
					authorization: `Bearer ${options.token ?? adminToken}`,
					...(options.body !== undefined
						? {
								"content-type":
									typeof options.body === "string"
										? "video/webm"
										: "application/json",
							}
						: {}),
				},
				...(options.body !== undefined
					? {
							body:
								typeof options.body === "string"
									? options.body
									: JSON.stringify(options.body),
						}
					: {}),
			}),
		);
		const text = await response.text();
		return {
			status: response.status,
			text,
			// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted field by field.
			json: (text ? JSON.parse(text) : null) as Record<string, any>,
		};
	};
	// Inserts an uploaded artifact whose object exists in the given bucket.
	const seedArtifact = async (input: {
		createdBy: string;
		bucket: string;
		storageId?: string | null;
		body?: string;
		kind?: "recording" | "network-log";
		orgId?: string;
		s3Key?: string;
		checksum?: string;
		createdAt?: number;
	}) => {
		const body = new TextEncoder().encode(input.body ?? "recording bytes");
		const [evidence] = await db
			.insert(evidences)
			.values({
				orgId: input.orgId ?? org.id,
				createdBy: input.createdBy,
				title: "Seeded",
				sourceType: "browser",
			})
			.returning();
		if (!evidence) throw new Error("Evidence unavailable");
		const s3Key = input.s3Key ?? `uploads/${org.id}/${crypto.randomUUID()}`;
		const [artifact] = await db
			.insert(evidenceArtifacts)
			.values({
				evidenceId: evidence.id,
				kind: input.kind ?? "recording",
				s3Key,
				storageId: input.storageId ?? null,
				mimeType: "video/webm",
				bytes: body.byteLength,
				checksum:
					input.checksum ??
					`sha256:${createHash("sha256").update(body).digest("hex")}`,
				uploadStatus: "uploaded",
				...(input.createdAt ? { createdAt: input.createdAt } : {}),
			})
			.returning();
		if (!artifact) throw new Error("Artifact unavailable");
		s3.bucket(input.bucket).set(s3Key, body);
		return { evidence, artifact };
	};
	const storageInput = (bucket: string, name = "Team bucket") => ({
		name,
		region: "ap-southeast-1",
		bucket,
		accessKeyId: FAKE_ACCESS_KEY,
		secretAccessKey: FAKE_SECRET,
	});
	return {
		db,
		org,
		admin,
		developer,
		s3,
		call,
		seedArtifact,
		storageInput,
		developerToken,
		transfers: created.organizationStorage?.transfers,
	};
};

describe("organization storage", () => {
	it("reports usage to every member and keeps configuration to managers", async () => {
		const ctx = await setup();
		const now = Date.now();
		await ctx.seedArtifact({
			createdBy: ctx.admin.userId,
			bucket: "jittle-lamp-default",
			body: "x".repeat(100),
			createdAt: now,
		});
		await ctx.seedArtifact({
			createdBy: ctx.developer.userId,
			bucket: "jittle-lamp-default",
			body: "y".repeat(40),
			kind: "network-log",
			createdAt: now,
		});
		const binned = await ctx.seedArtifact({
			createdBy: ctx.developer.userId,
			bucket: "jittle-lamp-default",
			body: "z".repeat(10),
			createdAt: now,
		});
		await ctx.db
			.update(evidences)
			.set({ deletedAt: now, deletePurgesAt: now + 1000 })
			.where(eq(evidences.id, binned.evidence.id));

		const usage = await ctx.call(
			"GET",
			`/orgs/${ctx.org.id}/storage/usage?granularity=day`,
			{ token: ctx.developerToken },
		);
		expect(usage.status).toBe(200);
		expect(usage.json.totals).toEqual({
			bytes: 150,
			artifactCount: 3,
			evidenceCount: 2,
			binBytes: 10,
		});
		expect(
			usage.json.byMember.map((row: { userId: string; bytes: number }) => [
				row.userId,
				row.bytes,
			]),
		).toEqual([
			[ctx.admin.userId, 100],
			[ctx.developer.userId, 50],
		]);
		expect(usage.json.byKind.map((row: { kind: string }) => row.kind)).toEqual([
			"recording",
			"network-log",
		]);
		expect(usage.json.byStorage).toEqual([
			{
				storageId: null,
				name: "JittleLamp storage",
				removed: false,
				bytes: 150,
				artifactCount: 3,
			},
		]);
		expect(usage.json.timeline).toHaveLength(30);
		expect(usage.json.timeline.at(-1)).toMatchObject({
			addedBytes: 150,
			storedBytes: 150,
		});

		const overview = await ctx.call("GET", `/orgs/${ctx.org.id}/storage`, {
			token: ctx.developerToken,
		});
		expect(overview.status).toBe(200);
		expect(overview.json.canManage).toBe(false);
		expect(overview.json.defaultStorageUsage.bytes).toBe(150);

		const denied = await ctx.call("POST", `/orgs/${ctx.org.id}/storages`, {
			token: ctx.developerToken,
			body: ctx.storageInput("team-bucket"),
		});
		expect(denied.status).toBe(403);

		const outsider = await ctx.call(
			"GET",
			`/orgs/${crypto.randomUUID()}/storage/usage`,
		);
		expect(outsider.status).toBe(403);

		expect(await recordStorageDailyUsage(ctx.db, now)).toBe(1);
		const snapshot = await ctx.db.query.organizationStorageDailyUsage.findFirst(
			{ where: eq(organizationStorageDailyUsage.orgId, ctx.org.id) },
		);
		expect(snapshot).toMatchObject({ storageKey: "default", bytes: 150 });
	});

	it("verifies, encrypts and routes uploads to a custom storage", async () => {
		const ctx = await setup();
		const broken = await ctx.call("POST", `/orgs/${ctx.org.id}/storages`, {
			body: ctx.storageInput("broken-bucket"),
		});
		expect(broken.status).toBe(422);
		expect(broken.json.error.code).toBe("STORAGE_CONNECTION_FAILED");

		const loopback = await ctx.call("POST", `/orgs/${ctx.org.id}/storages`, {
			body: {
				...ctx.storageInput("team-bucket"),
				endpoint: "http://127.0.0.1:9000",
			},
		});
		expect(loopback.status).toBe(400);
		expect(loopback.json.error.code).toBe("STORAGE_ENDPOINT_NOT_ALLOWED");

		const created = await ctx.call("POST", `/orgs/${ctx.org.id}/storages`, {
			body: ctx.storageInput("team-bucket"),
		});
		expect(created.status).toBe(201);
		expect(created.text).not.toContain(FAKE_SECRET);
		expect(created.json.accessKeyLast4).toBe("1234");
		const storageId = created.json.id as string;
		const stored = await ctx.db.query.organizationStorages.findFirst();
		expect(stored?.credentialsEnc).toBeTruthy();
		expect(stored?.credentialsEnc).not.toContain(FAKE_SECRET);
		// The canary object is cleaned up.
		expect(ctx.s3.bucket("team-bucket").size).toBe(0);

		const duplicate = await ctx.call("POST", `/orgs/${ctx.org.id}/storages`, {
			body: ctx.storageInput("team-bucket", "Again"),
		});
		expect(duplicate.status).toBe(409);

		const disableWithoutTarget = await ctx.call(
			"PATCH",
			`/orgs/${ctx.org.id}/storage/settings`,
			{ body: { defaultStorageDisabled: true } },
		);
		expect(disableWithoutTarget.status).toBe(400);

		const settings = await ctx.call(
			"PATCH",
			`/orgs/${ctx.org.id}/storage/settings`,
			{ body: { defaultStorageId: storageId, defaultStorageDisabled: true } },
		);
		expect(settings.status).toBe(200);
		expect(settings.json).toEqual({
			defaultStorageId: storageId,
			defaultStorageDisabled: true,
		});

		const start = await ctx.call("POST", "/evidences/uploads/start", {
			token: ctx.developerToken,
			body: {
				title: "Routed upload",
				sourceType: "browser",
				artifact: {
					kind: "recording",
					mimeType: "video/webm",
					bytes: 11,
					checksum: `sha256:${await sha256Hex("hello world")}`,
				},
			},
		});
		expect(start.status).toBe(200);
		const artifact = await ctx.db.query.evidenceArtifacts.findFirst({
			where: eq(evidenceArtifacts.id, start.json.uploadId),
		});
		expect(artifact?.storageId).toBe(storageId);

		// The blob follows the artifact even after the write target changes.
		await ctx.call("PATCH", `/orgs/${ctx.org.id}/storage/settings`, {
			body: { defaultStorageId: null, defaultStorageDisabled: false },
		});
		const blob = await ctx.call(
			"PUT",
			`/evidences/uploads/${start.json.uploadId}/blob`,
			{ token: ctx.developerToken, body: "hello world" },
		);
		expect([200, 204]).toContain(blob.status);
		expect(ctx.s3.bucket("team-bucket").has(artifact?.s3Key ?? "")).toBe(true);
		expect(ctx.s3.bucket("jittle-lamp-default").size).toBe(0);
	});

	it("transfers from the default storage and removes storages without re-linking", async () => {
		const ctx = await setup();
		const created = await ctx.call("POST", `/orgs/${ctx.org.id}/storages`, {
			body: ctx.storageInput("team-bucket"),
		});
		const storageId = created.json.id as string;

		const moved = await ctx.seedArtifact({
			createdBy: ctx.admin.userId,
			bucket: "jittle-lamp-default",
			body: "moved bytes",
		});
		// Another organisation's copy shares the object: it must survive the transfer.
		const [otherOrg] = await ctx.db
			.insert(organizations)
			.values({ name: "Other", isPersonal: false })
			.returning();
		if (!otherOrg) throw new Error("Organization unavailable");
		await ctx.seedArtifact({
			createdBy: ctx.admin.userId,
			bucket: "jittle-lamp-default",
			orgId: otherOrg.id,
			s3Key: moved.artifact.s3Key,
			body: "moved bytes",
		});
		const corrupt = await ctx.seedArtifact({
			createdBy: ctx.admin.userId,
			bucket: "jittle-lamp-default",
			body: "corrupt",
			checksum: `sha256:${"0".repeat(64)}`,
		});
		const solo = await ctx.seedArtifact({
			createdBy: ctx.admin.userId,
			bucket: "jittle-lamp-default",
			body: "solo bytes",
		});

		const transfer = await ctx.call(
			"POST",
			`/orgs/${ctx.org.id}/storage/transfers`,
			{ body: { sourceStorageId: null, targetStorageId: storageId } },
		);
		expect(transfer.status).toBe(201);
		expect(transfer.json.artifactsTotal).toBe(3);
		const again = await ctx.call(
			"POST",
			`/orgs/${ctx.org.id}/storage/transfers`,
			{ body: { sourceStorageId: null, targetStorageId: storageId } },
		);
		expect(again.status).toBe(409);

		if (!ctx.transfers) throw new Error("Transfers unavailable");
		const worker = createStorageTransferWorker({
			db: ctx.db,
			transfers: ctx.transfers,
		});
		expect(await worker.runOnce()).toBe(true);
		const finished = await ctx.call(
			"GET",
			`/orgs/${ctx.org.id}/storage/transfers/${transfer.json.id}`,
		);
		expect(finished.json).toMatchObject({
			status: "completed",
			artifactsDone: 2,
			artifactsFailed: 1,
		});
		expect(finished.json.lastError).toContain("checksum mismatch");

		const rows = await ctx.db.query.evidenceArtifacts.findMany();
		const byId = new Map(rows.map((row) => [row.id, row]));
		expect(byId.get(moved.artifact.id)?.storageId).toBe(storageId);
		expect(byId.get(solo.artifact.id)?.storageId).toBe(storageId);
		expect(byId.get(corrupt.artifact.id)?.storageId).toBeNull();
		const team = ctx.s3.bucket("team-bucket");
		const fallback = ctx.s3.bucket("jittle-lamp-default");
		expect(team.has(moved.artifact.s3Key)).toBe(true);
		expect(team.has(solo.artifact.s3Key)).toBe(true);
		expect(fallback.has(moved.artifact.s3Key)).toBe(true);
		expect(fallback.has(solo.artifact.s3Key)).toBe(false);
		expect(fallback.has(corrupt.artifact.s3Key)).toBe(true);

		// Removal: blocked while it is the write target, then tombstoned.
		await ctx.call("PATCH", `/orgs/${ctx.org.id}/storage/settings`, {
			body: { defaultStorageId: storageId },
		});
		const blocked = await ctx.call(
			"POST",
			`/orgs/${ctx.org.id}/storages/${storageId}/delete`,
			{ body: { confirmName: "Team bucket" } },
		);
		expect(blocked.status).toBe(409);
		expect(blocked.json.error.code).toBe("STORAGE_IS_WRITE_TARGET");
		await ctx.call("PATCH", `/orgs/${ctx.org.id}/storage/settings`, {
			body: { defaultStorageId: null },
		});
		const impact = await ctx.call(
			"GET",
			`/orgs/${ctx.org.id}/storages/${storageId}/impact`,
		);
		expect(impact.json).toMatchObject({ artifactCount: 2, evidenceCount: 2 });
		const mismatch = await ctx.call(
			"POST",
			`/orgs/${ctx.org.id}/storages/${storageId}/delete`,
			{ body: { confirmName: "wrong" } },
		);
		expect(mismatch.status).toBe(400);
		const removed = await ctx.call(
			"POST",
			`/orgs/${ctx.org.id}/storages/${storageId}/delete`,
			{ body: { confirmName: "Team bucket" } },
		);
		expect(removed.status).toBe(200);
		const tombstone = await ctx.db.query.organizationStorages.findFirst();
		expect(tombstone).toMatchObject({
			status: "deleted",
			credentialsEnc: null,
		});

		const readUrl = await ctx.call(
			"GET",
			`/evidences/${solo.evidence.id}/artifacts/${solo.artifact.id}/read-url?orgId=${ctx.org.id}`,
		);
		expect(readUrl.status).toBe(410);
		expect(readUrl.json.error.code).toBe("ARTIFACT_STORAGE_REMOVED");

		// Adding the same bucket again is a new storage; old artifacts stay unavailable.
		const readded = await ctx.call("POST", `/orgs/${ctx.org.id}/storages`, {
			body: ctx.storageInput("team-bucket"),
		});
		expect(readded.status).toBe(201);
		expect(readded.json.id).not.toBe(storageId);
		const stillGone = await ctx.call(
			"GET",
			`/evidences/${solo.evidence.id}/artifacts/${solo.artifact.id}/read-url?orgId=${ctx.org.id}`,
		);
		expect(stillGone.status).toBe(410);

		const overview = await ctx.call("GET", `/orgs/${ctx.org.id}/storage`);
		const listed = overview.json.storages.map(
			(storage: { id: string; status: string }) => [storage.id, storage.status],
		);
		expect(listed).toContainEqual([storageId, "deleted"]);
		expect(listed).toContainEqual([readded.json.id, "active"]);
	});

	it("copies custom-storage artifacts into the target organization's storage", async () => {
		const ctx = await setup();
		const created = await ctx.call("POST", `/orgs/${ctx.org.id}/storages`, {
			body: ctx.storageInput("team-bucket"),
		});
		const storageId = created.json.id as string;
		const source = await ctx.seedArtifact({
			createdBy: ctx.admin.userId,
			bucket: "team-bucket",
			storageId,
			body: "private bytes",
		});
		const copy = await ctx.call(
			"POST",
			`/evidences/${source.evidence.id}/copy`,
			{ body: { targetOrgId: ctx.admin.organizationId } },
		);
		expect(copy.status).toBe(200);
		const copied = await ctx.db.query.evidenceArtifacts.findFirst({
			where: eq(evidenceArtifacts.evidenceId, copy.json.evidence.id),
		});
		expect(copied?.storageId).toBeNull();
		expect(copied?.s3Key).not.toBe(source.artifact.s3Key);
		expect(
			ctx.s3.bucket("jittle-lamp-default").get(copied?.s3Key ?? ""),
		).toEqual(new TextEncoder().encode("private bytes"));
	});
});
