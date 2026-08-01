import { describe, expect, it } from "bun:test";
import { SignJWT } from "jose";

import { createApp } from "../src/app";
import { createDb } from "../src/db";
import {
	evidenceArtifacts,
	evidences,
	organizationMembers,
	organizations,
	users,
} from "../src/db/schema";
import type { ArtifactStorage } from "../src/services/artifact-storage";
import {
	InMemoryClerkDirectory,
	type MigrationDirectoryProfile,
} from "../src/services/clerk-directory";
import { createMigrationWorker } from "../src/services/migration-worker";
import {
	applyMigrations,
	createTestEnv,
	getAuthFixture,
	sha256Hex,
} from "./test-utils";

const profile = (
	clerkUserId: string,
	email: string,
): MigrationDirectoryProfile => ({
	clerkUserId,
	verifiedPrimaryEmail: email,
	firstName: "Migration",
	lastName: "Admin",
	username: null,
	imageUrl: null,
	createdAt: 1_700_000_000_000,
});

const isolatedArtifactStorage = (): ArtifactStorage => {
	const objects = new Map<
		string,
		{ body: Uint8Array; contentType: string; checksumSha256: string }
	>();
	return {
		mode: "s3",
		putObject: async (input) => {
			objects.set(input.key, {
				body: Uint8Array.from(input.body),
				contentType: input.contentType,
				checksumSha256: input.checksumSha256,
			});
		},
		getObject: async ({ key }) => {
			const object = objects.get(key);
			if (!object) throw new Error(`Missing test artifact: ${key}`);
			return Uint8Array.from(object.body);
		},
		createReadUrl: async ({ key }) => {
			const object = objects.get(key);
			if (!object) throw new Error(`Missing test artifact: ${key}`);
			return {
				url: `data:${object.contentType};base64,${Buffer.from(object.body).toString("base64")}`,
				expiresAt: Date.now() + 60_000,
				ttlSeconds: 60,
			};
		},
		deleteObject: async ({ key }) => {
			objects.delete(key);
		},
	};
};

const json = async <T>(response: Response): Promise<T> => {
	const body = (await response.json()) as T;
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
	}
	return body;
};

const waitFor = async <T>(
	read: () => Promise<T>,
	accept: (value: T) => boolean,
): Promise<T> => {
	const deadline = Date.now() + 12_000;
	let latest: T;
	do {
		latest = await read();
		if (accept(latest)) return latest;
		await Bun.sleep(50);
	} while (Date.now() < deadline);
	throw new Error(
		`Timed out waiting for migration state: ${JSON.stringify(latest)}`,
	);
};

describe("organization migration HTTP integration", () => {
	it("moves an artifact over HTTP and completes the write-authority handoff", async () => {
		const sourceUrl = `file:/tmp/jittle-lamp-http-source-${crypto.randomUUID()}.db`;
		const targetUrl = `file:/tmp/jittle-lamp-http-target-${crypto.randomUUID()}.db`;
		await applyMigrations(sourceUrl);
		await applyMigrations(targetUrl);
		const sourceDb = createDb(sourceUrl);
		const targetDb = createDb(targetUrl);
		if (!sourceDb || !targetDb) throw new Error("test databases unavailable");

		const sourceClerkId = `clerk_source_${crypto.randomUUID()}`;
		const targetClerkId = `clerk_target_${crypto.randomUUID()}`;
		const sharedEmail = "http-migration-admin@example.test";
		const [sourceAdmin] = await sourceDb
			.insert(users)
			.values({ clerkUserId: sourceClerkId })
			.returning();
		const [targetAdmin] = await targetDb
			.insert(users)
			.values({ clerkUserId: targetClerkId })
			.returning();
		const [sourceOrg] = await sourceDb
			.insert(organizations)
			.values({
				name: "HTTP Migrating Team",
				isPersonal: false,
				personalOwnerUserId: null,
			})
			.returning();
		if (!sourceAdmin || !targetAdmin || !sourceOrg)
			throw new Error("test fixtures unavailable");
		await sourceDb.insert(organizationMembers).values({
			organizationId: sourceOrg.id,
			userId: sourceAdmin.id,
			role: "admin",
		});

		const artifactBody = new TextEncoder().encode(
			"cross-instance HTTP artifact",
		);
		const checksum = await sha256Hex("cross-instance HTTP artifact");
		const sourceObjectKey = `source/${crypto.randomUUID()}`;
		const sourceStorage = isolatedArtifactStorage();
		const targetStorage = isolatedArtifactStorage();
		await sourceStorage.putObject({
			key: sourceObjectKey,
			body: artifactBody,
			contentType: "text/plain",
			checksumSha256: checksum,
		});
		const [sourceEvidence] = await sourceDb
			.insert(evidences)
			.values({
				orgId: sourceOrg.id,
				createdBy: sourceAdmin.id,
				title: "Transferred over HTTP",
				sourceType: "manual",
				scopeType: "organization",
			})
			.returning();
		if (!sourceEvidence) throw new Error("source evidence unavailable");
		await sourceDb.insert(evidenceArtifacts).values({
			evidenceId: sourceEvidence.id,
			kind: "attachment",
			s3Key: sourceObjectKey,
			mimeType: "text/plain",
			bytes: artifactBody.byteLength,
			checksum,
			uploadStatus: "uploaded",
		});

		let targetHandler = (_request: Request): Response | Promise<Response> =>
			new Response("target is starting", { status: 503 });
		const targetServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) => targetHandler(request),
		});
		const targetOrigin = `http://127.0.0.1:${targetServer.port}`;
		const { privateKey, jwtKey } = await getAuthFixture();
		const token = (subject: string) =>
			new SignJWT({ scope: "read write org:read" })
				.setProtectedHeader({ alg: "RS256" })
				.setSubject(subject)
				.setIssuedAt()
				.setExpirationTime("5m")
				.sign(privateKey);
		const sourceToken = await token(sourceClerkId);
		const targetToken = await token(targetClerkId);
		const targetSystem = createApp(
			createTestEnv({
				DATABASE_URL: targetUrl,
				CLERK_JWT_KEY: jwtKey,
				JITTLE_LAMP_API_ORIGIN: targetOrigin,
				LOG_LEVEL: "silent",
				WEB_APP_ORIGIN: "http://target-web.example.test",
			}),
			{
				artifactStorage: targetStorage,
				clerkDirectory: new InMemoryClerkDirectory([
					profile(targetClerkId, sharedEmail),
				]),
			},
		);
		targetHandler = (request) => targetSystem.app.handle(request);
		const sourceSystem = createApp(
			createTestEnv({
				DATABASE_URL: sourceUrl,
				CLERK_JWT_KEY: jwtKey,
				JITTLE_LAMP_API_ORIGIN: "http://127.0.0.1:1",
				LOG_LEVEL: "silent",
				WEB_APP_ORIGIN: "http://source-web.example.test",
			}),
			{
				artifactStorage: sourceStorage,
				clerkDirectory: new InMemoryClerkDirectory([
					profile(sourceClerkId, sharedEmail),
				]),
			},
		);
		if (
			!sourceSystem.organizationMigration ||
			!targetSystem.organizationMigration
		)
			throw new Error("migration services unavailable");

		const sourceRequest = (path: string, init: RequestInit = {}) =>
			sourceSystem.app.handle(
				new Request(`http://source.test${path}`, {
					...init,
					headers: {
						authorization: `Bearer ${sourceToken}`,
						...(init.body ? { "content-type": "application/json" } : {}),
						...init.headers,
					},
				}),
			);
		const targetRequest = (path: string, init: RequestInit = {}) =>
			Bun.fetch(`${targetOrigin}${path}`, {
				...init,
				headers: {
					authorization: `Bearer ${targetToken}`,
					...(init.body ? { "content-type": "application/json" } : {}),
					...init.headers,
				},
			});

		const sourceWorker = createMigrationWorker({
			db: sourceDb,
			handler: sourceSystem.organizationMigration.processRun,
			pollMs: 10,
		});
		const targetWorker = createMigrationWorker({
			db: targetDb,
			handler: targetSystem.organizationMigration.processRun,
			pollMs: 10,
		});
		let stopSourceWorker: (() => void) | undefined;
		let stopTargetWorker: (() => void) | undefined;
		try {
			const receiver = await json<{
				receiverCode: { passphrase: string; apiOrigin: string };
			}>(await targetRequest("/migrations/receiver-codes", { method: "POST" }));
			expect(receiver.receiverCode.apiOrigin).toBe(targetOrigin);

			const compatibility = await json<{
				compatibility: { compatible: boolean; targetApiOrigin: string };
			}>(
				await sourceRequest(`/orgs/${sourceOrg.id}/migrations/preflight`, {
					method: "POST",
					body: JSON.stringify({ targetApiOrigin: targetOrigin }),
				}),
			);
			expect(compatibility.compatibility).toEqual(
				expect.objectContaining({
					compatible: true,
					targetApiOrigin: targetOrigin,
				}),
			);

			await json(
				await sourceRequest(`/orgs/${sourceOrg.id}/migrations/pair`, {
					method: "POST",
					body: JSON.stringify({
						targetApiOrigin: targetOrigin,
						passphrase: receiver.receiverCode.passphrase,
					}),
				}),
			);
			const importing = await json<{
				migrations: Array<{
					accessState: string;
					link: { localOrganizationId: string } | null;
				}>;
			}>(await targetRequest("/migrations/inbound"));
			const destinationOrgId =
				importing.migrations[0]?.link?.localOrganizationId;
			expect(importing.migrations[0]?.accessState).toBe("importing");
			expect(destinationOrgId).toBeString();
			const hiddenOrganizations = await json<{
				organizations: Array<{ id: string }>;
			}>(await targetRequest("/orgs"));
			expect(
				hiddenOrganizations.organizations.some(
					(organization) => organization.id === destinationOrgId,
				),
			).toBeFalse();

			stopSourceWorker = sourceWorker.start();
			stopTargetWorker = targetWorker.start();
			await waitFor(
				async () =>
					json<{ run: { status: string } | null }>(
						await sourceRequest(`/orgs/${sourceOrg.id}/migration`),
					),
				(status) => status.run?.status === "succeeded",
			);
			await waitFor(
				async () =>
					json<{
						migrations: Array<{ accessState: string }>;
					}>(await targetRequest("/migrations/inbound")),
				(status) => status.migrations[0]?.accessState === "synced_read_only",
			);

			const evidenceList = await json<{
				evidences: Array<{ id: string; title: string }>;
			}>(
				await targetRequest(
					`/evidences?orgId=${encodeURIComponent(destinationOrgId as string)}`,
				),
			);
			expect(evidenceList.evidences).toHaveLength(1);
			expect(evidenceList.evidences[0]?.title).toBe("Transferred over HTTP");
			const destinationEvidenceId = evidenceList.evidences[0]?.id as string;
			const artifacts = await json<{
				artifacts: Array<{ id: string; checksum: string }>;
			}>(
				await targetRequest(
					`/evidences/${destinationEvidenceId}/artifacts?orgId=${encodeURIComponent(destinationOrgId as string)}`,
				),
			);
			expect(artifacts.artifacts[0]?.checksum).toBe(checksum);
			const readUrl = await json<{ url: string }>(
				await targetRequest(
					`/evidences/${destinationEvidenceId}/artifacts/${artifacts.artifacts[0]?.id}/read-url?orgId=${encodeURIComponent(destinationOrgId as string)}`,
				),
			);
			expect(await (await Bun.fetch(readUrl.url)).text()).toBe(
				"cross-instance HTTP artifact",
			);

			await json(
				await sourceRequest(`/orgs/${sourceOrg.id}/migration/finalize`, {
					method: "POST",
				}),
			);
			await waitFor(
				async () =>
					json<{
						accessState: string | null;
						run: { kind: string; status: string } | null;
					}>(await sourceRequest(`/orgs/${sourceOrg.id}/migration`)),
				(status) =>
					status.accessState === "completed_source_read_only" &&
					status.run?.kind === "final" &&
					status.run.status === "succeeded",
			);
			await waitFor(
				async () =>
					json<{
						migrations: Array<{ accessState: string }>;
					}>(await targetRequest("/migrations/inbound")),
				(status) => status.migrations[0]?.accessState === "writable",
			);

			const sourceMutation = await sourceRequest(`/orgs/${sourceOrg.id}`, {
				method: "PATCH",
				body: JSON.stringify({ name: "Source must remain locked" }),
			});
			expect(sourceMutation.status).toBe(423);
			expect(await sourceMutation.json()).toMatchObject({
				error: { code: "ORG_MIGRATION_READ_ONLY" },
			});
			const targetMutation = await targetRequest(`/orgs/${destinationOrgId}`, {
				method: "PATCH",
				body: JSON.stringify({ name: "Destination is authoritative" }),
			});
			expect(targetMutation.status).toBe(200);
			expect(await targetMutation.json()).toMatchObject({
				organizationId: destinationOrgId,
				name: "Destination is authoritative",
			});
		} finally {
			stopSourceWorker?.();
			stopTargetWorker?.();
			targetServer.stop(true);
		}
	}, 30_000);
});
