import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { parseEnv } from "../src/config/env";
import { buildRuntimeConfig } from "../src/config/runtime";
import { createDb } from "../src/db";
import {
	evidenceArtifacts,
	evidences,
	organizationMembers,
	organizationMigrationStates,
	organizations,
	users,
} from "../src/db/schema";
import { createArtifactStorage } from "../src/services/artifact-storage";
import {
	InMemoryClerkDirectory,
	type MigrationDirectoryProfile,
} from "../src/services/clerk-directory";
import type { MigrationPeerClient } from "../src/services/migration-peer-client";
import { createInMemoryMigrationPeerClient } from "../src/services/migration-peer-client";
import { createMigrationWorker } from "../src/services/migration-worker";
import { createOrganizationMigration } from "../src/services/organization-migration";
import { applyMigrations, sha256Hex, TEST_APP_SECRET } from "./test-utils";

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

const runtime = (databaseUrl: string, apiOrigin: string, webOrigin: string) =>
	buildRuntimeConfig(
		parseEnv({
			NODE_ENV: "development",
			DATABASE_URL: databaseUrl,
			APP_SECRET: TEST_APP_SECRET,
			CLERK_SECRET_KEY: "sk_test_migration",
			JITTLE_LAMP_API_ORIGIN: apiOrigin,
			WEB_APP_ORIGIN: webOrigin,
		}),
	);

const unusedPeer = {} as MigrationPeerClient;

describe("OrganizationMigration", () => {
	it("pairs two instances once, queues full sync, and keeps target hidden", async () => {
		const sourceUrl = `file:/tmp/jittle-lamp-migration-source-${crypto.randomUUID()}.db`;
		const targetUrl = `file:/tmp/jittle-lamp-migration-target-${crypto.randomUUID()}.db`;
		await applyMigrations(sourceUrl);
		await applyMigrations(targetUrl);
		const sourceDb = createDb(sourceUrl);
		const targetDb = createDb(targetUrl);
		if (!sourceDb || !targetDb) throw new Error("test databases unavailable");

		const sourceRuntime = runtime(
			sourceUrl,
			"https://source.example.test",
			"https://source-web.example.test",
		);
		const targetRuntime = runtime(
			targetUrl,
			"https://target.example.test",
			"https://target-web.example.test",
		);
		const sourceClerkId = "clerk_source_admin";
		const targetClerkId = "clerk_target_admin";
		const sharedEmail = "admin@example.test";
		const [sourceAdmin] = await sourceDb
			.insert(users)
			.values({ clerkUserId: sourceClerkId })
			.returning();
		const [targetAdmin] = await targetDb
			.insert(users)
			.values({ clerkUserId: targetClerkId })
			.returning();
		if (!sourceAdmin || !targetAdmin) throw new Error("admins unavailable");
		const [sourceOrg] = await sourceDb
			.insert(organizations)
			.values({
				name: "Migrating Team",
				isPersonal: false,
				personalOwnerUserId: null,
			})
			.returning();
		if (!sourceOrg) throw new Error("source org unavailable");
		await sourceDb.insert(organizationMembers).values({
			organizationId: sourceOrg.id,
			userId: sourceAdmin.id,
			role: "admin",
		});

		const targetStorage = createArtifactStorage(targetRuntime);
		const targetMigration = createOrganizationMigration({
			db: targetDb,
			runtime: targetRuntime,
			artifactStorage: targetStorage,
			peerClient: unusedPeer,
			clerkDirectory: new InMemoryClerkDirectory([
				profile(targetClerkId, sharedEmail),
			]),
		});
		const peer = createInMemoryMigrationPeerClient({
			discovery: async () => ({
				product: "jittle-lamp" as const,
				instanceId: await targetMigration.getInstanceId(),
				applicationVersion: "1.7.3",
				protocolVersion: "1.0",
				features: [
					"resumable-import",
					"delta-sync",
					"two-phase-finalization",
					"checksum-verification",
				],
				apiOrigin: targetRuntime.apiOrigin as string,
				webOrigin: targetRuntime.webAppOrigin as string,
				limits: { maxRecordsPerPage: 100, maxArtifactBytes: 1024 * 1024 },
			}),
			destination: targetMigration,
		});
		const sourceStorage = createArtifactStorage(sourceRuntime);
		const sourceMigration = createOrganizationMigration({
			db: sourceDb,
			runtime: sourceRuntime,
			artifactStorage: sourceStorage,
			peerClient: peer,
			clerkDirectory: new InMemoryClerkDirectory([
				profile(sourceClerkId, sharedEmail),
			]),
			validateTarget: async ({ origin }) => new URL(origin).origin,
		});

		const receiver = await targetMigration.createReceiverCode(targetAdmin.id);
		const link = await sourceMigration.pairOutbound({
			actorUserId: sourceAdmin.id,
			organizationId: sourceOrg.id,
			targetApiOrigin: receiver.apiOrigin,
			passphrase: receiver.passphrase,
		});
		expect(link.direction).toBe("outbound");
		const sourceStatus = await sourceMigration.getStatus(
			sourceAdmin.id,
			sourceOrg.id,
		);
		expect(sourceStatus.run?.kind).toBe("full");
		expect(sourceStatus.run?.status).toBe("queued");
		const inbound = await targetMigration.listInbound(targetAdmin.id);
		expect(inbound).toHaveLength(1);
		expect(inbound[0]?.accessState).toBe("importing");

		const sourceWorker = createMigrationWorker({
			db: sourceDb,
			handler: sourceMigration.processRun,
		});
		const targetWorker = createMigrationWorker({
			db: targetDb,
			handler: targetMigration.processRun,
		});
		expect(await sourceWorker.runOnce()).toBeTrue();
		expect(await targetWorker.runOnce()).toBeTrue();
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		expect(await sourceWorker.runOnce()).toBeTrue();
		const syncedSource = await sourceMigration.getStatus(
			sourceAdmin.id,
			sourceOrg.id,
		);
		expect(syncedSource.run?.status).toBe("succeeded");
		const syncedInbound = await targetMigration.listInbound(targetAdmin.id);
		expect(syncedInbound[0]?.accessState).toBe("synced_read_only");
		const destinationOrgId = syncedInbound[0]?.link?.localOrganizationId;
		expect(destinationOrgId).toBeString();
		const destinationOrg = await targetDb.query.organizations.findFirst({
			where: eq(organizations.id, destinationOrgId as string),
		});
		expect(destinationOrg?.name).toBe("Migrating Team");

		const artifactBody = new TextEncoder().encode("durable migration artifact");
		const checksum = await sha256Hex("durable migration artifact");
		const sourceObjectKey = `source-only/${crypto.randomUUID()}`;
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
				title: "Created after full sync",
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
		await sourceDb
			.update(organizations)
			.set({ name: "Migrating Team Updated", updatedAt: Date.now() })
			.where(eq(organizations.id, sourceOrg.id));

		const runDelta = async () => {
			await sourceMigration.startRun(sourceOrg.id, "delta");
			expect(await sourceWorker.runOnce()).toBeTrue();
			expect(await targetWorker.runOnce()).toBeTrue();
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			expect(await sourceWorker.runOnce()).toBeTrue();
			const status = await sourceMigration.getStatus(
				sourceAdmin.id,
				sourceOrg.id,
			);
			expect(status.run?.status).toBe("succeeded");
		};
		await runDelta();
		let destinationEvidence = await targetDb.query.evidences.findFirst({
			where: eq(evidences.orgId, destinationOrgId as string),
		});
		expect(destinationEvidence?.title).toBe("Created after full sync");
		const destinationArtifact =
			await targetDb.query.evidenceArtifacts.findFirst({
				where: eq(
					evidenceArtifacts.evidenceId,
					destinationEvidence?.id as string,
				),
			});
		expect(destinationArtifact?.s3Key).not.toBe(sourceObjectKey);
		expect(
			await targetStorage.getObject({
				key: destinationArtifact?.s3Key as string,
			}),
		).toEqual(artifactBody);

		await targetDb
			.update(organizationMigrationStates)
			.set({ accessState: "writable" })
			.where(
				eq(
					organizationMigrationStates.organizationId,
					destinationOrgId as string,
				),
			);
		await targetDb
			.update(evidences)
			.set({ title: "Unrelated target drift" })
			.where(eq(evidences.id, destinationEvidence?.id as string));
		await targetDb
			.update(organizationMigrationStates)
			.set({ accessState: "synced_read_only" })
			.where(
				eq(
					organizationMigrationStates.organizationId,
					destinationOrgId as string,
				),
			);
		await sourceDb
			.update(evidences)
			.set({ title: "Updated by delta", updatedAt: Date.now() })
			.where(eq(evidences.id, sourceEvidence.id));
		await sourceMigration.startRun(sourceOrg.id, "delta");
		expect(await sourceWorker.runOnce()).toBeTrue();
		expect(await targetWorker.runOnce()).toBeTrue();
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		expect(await sourceWorker.runOnce()).toBeTrue();
		const failedDrift = await sourceMigration.getStatus(
			sourceAdmin.id,
			sourceOrg.id,
		);
		expect(failedDrift.run?.status).toBe("failed");
		expect(failedDrift.run?.errorCode).toBe("TARGET_DRIFT");
		await sourceMigration.retryRun(failedDrift.run?.id as string, true);
		expect(await sourceWorker.runOnce()).toBeTrue();
		expect(await targetWorker.runOnce()).toBeTrue();
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		expect(await sourceWorker.runOnce()).toBeTrue();
		destinationEvidence = await targetDb.query.evidences.findFirst({
			where: eq(evidences.orgId, destinationOrgId as string),
		});
		expect(destinationEvidence?.title).toBe("Updated by delta");

		await sourceDb.delete(evidences).where(eq(evidences.id, sourceEvidence.id));
		await runDelta();
		expect(
			await targetDb.query.evidences.findFirst({
				where: eq(evidences.orgId, destinationOrgId as string),
			}),
		).toBeUndefined();

		await expect(
			sourceMigration.pairOutbound({
				actorUserId: sourceAdmin.id,
				organizationId: sourceOrg.id,
				targetApiOrigin: receiver.apiOrigin,
				passphrase: receiver.passphrase,
			}),
		).rejects.toMatchObject({ code: "MIGRATION_LINK_EXISTS" });

		const finalRun = await sourceMigration.startRun(sourceOrg.id, "final");
		expect(finalRun.kind).toBe("final");
		const locked = await sourceDb.query.organizationMigrationStates.findFirst({
			where: eq(organizationMigrationStates.organizationId, sourceOrg.id),
		});
		expect(locked?.accessState).toBe("finalizing_read_only");
		await sourceMigration.abortFinalization(sourceOrg.id);
		const unlocked = await sourceDb.query.organizationMigrationStates.findFirst(
			{
				where: eq(organizationMigrationStates.organizationId, sourceOrg.id),
			},
		);
		expect(unlocked?.accessState).toBe("writable");

		await sourceMigration.startRun(sourceOrg.id, "final");
		expect(await sourceWorker.runOnce()).toBeTrue();
		expect(await targetWorker.runOnce()).toBeTrue();
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		expect(await sourceWorker.runOnce()).toBeTrue();
		const completedSource = await sourceMigration.getStatus(
			sourceAdmin.id,
			sourceOrg.id,
		);
		expect(completedSource.run?.status).toBe("succeeded");
		expect(completedSource.accessState).toBe("completed_source_read_only");
		const completedTarget = await targetMigration.listInbound(targetAdmin.id);
		expect(completedTarget[0]?.accessState).toBe("writable");
		await expect(async () => {
			await sourceDb
				.update(organizations)
				.set({ name: "Must remain archived" })
				.where(eq(organizations.id, sourceOrg.id));
		}).toThrow();

		await sourceMigration.breakFinalizedLink(sourceOrg.id);
		const divergedTarget = await targetMigration.listInbound(targetAdmin.id);
		expect(divergedTarget[0]?.accessState).toBe("diverged");
		await sourceDb
			.update(organizations)
			.set({ name: "Diverged source" })
			.where(eq(organizations.id, sourceOrg.id));
		expect(
			(
				await sourceDb.query.organizations.findFirst({
					where: eq(organizations.id, sourceOrg.id),
				})
			)?.name,
		).toBe("Diverged source");
	}, 15_000);
});
