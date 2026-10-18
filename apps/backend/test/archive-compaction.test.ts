import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { archiveCompactionVersion } from "@jittle-lamp/shared";
import { eq } from "drizzle-orm";

import { createApp } from "../src/app";
import { evidenceArtifacts, evidences } from "../src/db/schema";
import {
	decodeStoredBody,
	encodeStoredBody,
} from "../src/services/artifact-storage";
import { ensureUserAndPersonalOrganization } from "../src/services/user-provisioning";
import { applyMigrations, TEST_APP_SECRET } from "./test-utils";

const at = "2026-01-01T00:00:00.000Z";

const archiveJson = () =>
	`${JSON.stringify(
		{
			schemaVersion: 3,
			sessionId: "jl_compaction",
			name: "Compaction",
			createdAt: at,
			updatedAt: at,
			phase: "ready",
			page: { title: "Example", url: "https://app.example.com/" },
			recorder: {
				extension: {
					kind: "browser-extension",
					name: "jittle-lamp",
					version: "1.8.0",
				},
			},
			summary: { videoDurationMs: null, actionCount: 0, requestCount: 2 },
			artifacts: [],
			sections: {
				actions: [],
				console: [],
				network: [
					{
						id: "net-1",
						seq: 1,
						at,
						subtype: "fetch",
						payload: {
							kind: "network",
							method: "OPTIONS",
							url: "https://api.example.com/items",
							status: 204,
							request: { headers: [], cookies: [] },
						},
					},
					{
						id: "net-2",
						seq: 2,
						at,
						subtype: "fetch",
						payload: {
							kind: "network",
							method: "GET",
							url: "https://api.example.com/items",
							status: 200,
							request: {
								headers: [
									{
										name: "Authorization",
										value: "Bearer abcdefghijklmnopqrstuvwxyz",
									},
								],
								cookies: [],
							},
						},
					},
				],
			},
			annotations: [],
			notes: [],
		},
		null,
		2,
	)}\n`;

const sha256Hex = (body: Uint8Array) =>
	createHash("sha256").update(body).digest("hex");

describe("stored body encoding", () => {
	it("gzips JSON over 1 KB and restores the original bytes", () => {
		const body = new TextEncoder().encode(
			JSON.stringify({ rows: Array.from({ length: 1000 }, (_, i) => i) }),
		);
		const checksum = createHash("sha256").update(body).digest("base64");
		const stored = encodeStoredBody("application/json", body, checksum);

		expect(stored.contentEncoding).toBe("gzip");
		expect(stored.body.byteLength).toBeLessThan(body.byteLength);
		expect(stored.checksumSha256).toBe(
			createHash("sha256").update(stored.body).digest("base64"),
		);
		expect(decodeStoredBody(stored.body, "gzip")).toEqual(body);
	});

	it("leaves small bodies and other content types as they are", () => {
		const small = new TextEncoder().encode('{"ok":true}');
		expect(encodeStoredBody("application/json", small, "x")).toEqual({
			body: small,
			checksumSha256: "x",
		});
		const video = new Uint8Array(4096);
		expect(encodeStoredBody("video/webm", video, "y").contentEncoding).toBe(
			undefined,
		);
	});
});

describe("archive compaction", () => {
	it("rewrites an old archive smaller and updates every row that shares it", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);
		const { db, artifactStorage, archiveCompactor } = createApp({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_VERSION: "9.9.9",
			APP_SECRET: TEST_APP_SECRET,
		});
		if (!db || !archiveCompactor) throw new Error("Database was not created");
		const provisioned = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: "user_clerk_compaction",
			source: "clerk-callback",
			rawPayload: { userId: "user_clerk_compaction" },
		});

		const original = new TextEncoder().encode(archiveJson());
		const s3Key = `archives/${crypto.randomUUID()}.json`;
		await artifactStorage.putObject({
			key: s3Key,
			body: original,
			contentType: "application/json",
			checksumSha256: createHash("sha256").update(original).digest("base64"),
		});
		const artifactIds: string[] = [];
		for (const title of ["Original", "Copy"]) {
			const [evidence] = await db
				.insert(evidences)
				.values({
					orgId: provisioned.organizationId,
					createdBy: provisioned.userId,
					title,
					sourceType: "browser",
					scopeId: provisioned.organizationId,
				})
				.returning({ id: evidences.id });
			if (!evidence) throw new Error("Failed to create evidence");
			const [artifact] = await db
				.insert(evidenceArtifacts)
				.values({
					evidenceId: evidence.id,
					kind: "network-log",
					s3Key,
					mimeType: "application/json",
					bytes: original.byteLength,
					checksum: `sha256:${sha256Hex(original)}`,
					uploadStatus: "uploaded",
				})
				.returning({ id: evidenceArtifacts.id });
			if (!artifact) throw new Error("Failed to create artifact");
			artifactIds.push(artifact.id);
		}
		const [firstId] = artifactIds;
		if (!firstId) throw new Error("Missing artifact");

		const result = await archiveCompactor.compact(firstId);
		expect(result.status).toBe("compacted");

		const stored = await artifactStorage.getObject({ key: s3Key });
		expect(stored.byteLength).toBeLessThan(original.byteLength);
		const rewritten = JSON.parse(new TextDecoder().decode(stored));
		// Written back in the version it was stored with.
		expect(rewritten.schemaVersion).toBe(3);
		expect(
			rewritten.sections.network.map(
				(entry: { payload: { method: string } }) => entry.payload.method,
			),
		).toEqual(["GET"]);
		expect(rewritten.sections.network[0].payload.request.headers).toEqual([
			{ name: "Authorization", value: "Bearer abcd****wxyz" },
		]);

		const rows = await db
			.select({
				bytes: evidenceArtifacts.bytes,
				checksum: evidenceArtifacts.checksum,
				compactionVersion: evidenceArtifacts.compactionVersion,
			})
			.from(evidenceArtifacts)
			.where(eq(evidenceArtifacts.s3Key, s3Key));
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row).toEqual({
				bytes: stored.byteLength,
				checksum: `sha256:${sha256Hex(stored)}`,
				compactionVersion: archiveCompactionVersion,
			});
		}

		expect(await archiveCompactor.compact(firstId)).toEqual({
			status: "skipped",
			reason: "already current",
		});
	});
});
