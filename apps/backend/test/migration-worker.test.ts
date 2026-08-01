import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";

import { createDb } from "../src/db";
import {
	organizationMigrationLinks,
	organizationMigrationRuns,
	organizations,
	users,
} from "../src/db/schema";
import {
	createMigrationWorker,
	MigrationWorkerError,
} from "../src/services/migration-worker";
import { applyMigrations } from "./test-utils";

const createQueuedRun = async () => {
	const databaseUrl = `file:/tmp/jittle-lamp-migration-worker-${crypto.randomUUID()}.db`;
	await applyMigrations(databaseUrl);
	const db = createDb(databaseUrl);
	if (!db) throw new Error("test database unavailable");
	const [user] = await db
		.insert(users)
		.values({ clerkUserId: `clerk_${crypto.randomUUID()}` })
		.returning();
	if (!user) throw new Error("user not created");
	const [organization] = await db
		.insert(organizations)
		.values({ name: "Source", isPersonal: false, personalOwnerUserId: null })
		.returning();
	if (!organization) throw new Error("organization not created");
	const [link] = await db
		.insert(organizationMigrationLinks)
		.values({
			direction: "outbound",
			localOrganizationId: organization.id,
			remoteInstanceId: crypto.randomUUID(),
			remoteOrganizationId: crypto.randomUUID(),
			remoteApiOrigin: "https://target.example.test",
			remoteWebOrigin: "https://target.example.test",
			protocolVersion: "1.0",
		})
		.returning();
	if (!link) throw new Error("link not created");
	const [run] = await db
		.insert(organizationMigrationRuns)
		.values({
			linkId: link.id,
			organizationId: organization.id,
			sourceRunId: crypto.randomUUID(),
			kind: "full",
		})
		.returning();
	if (!run) throw new Error("run not created");
	return { db, run };
};

describe("durable migration worker", () => {
	it("reclaims an expired lease after backend restart", async () => {
		const { db, run } = await createQueuedRun();
		await db
			.update(organizationMigrationRuns)
			.set({
				status: "running",
				workerLeaseOwner: "dead-worker",
				workerLeaseExpiresAt: 999,
			})
			.where(eq(organizationMigrationRuns.id, run.id));

		const worker = createMigrationWorker({
			db,
			workerId: "replacement-worker",
			now: () => 1_000,
			handler: async (_claimed, controls) => {
				await controls.checkpoint("manifest");
				return "succeeded";
			},
		});
		expect(await worker.runOnce()).toBeTrue();
		const completed = await db.query.organizationMigrationRuns.findFirst({
			where: eq(organizationMigrationRuns.id, run.id),
		});
		expect(completed?.status).toBe("succeeded");
		expect(completed?.stage).toBe("manifest");
		expect(completed?.workerLeaseOwner).toBeNull();
	});

	it("honors pause at a durable stage boundary", async () => {
		const { db, run } = await createQueuedRun();
		const worker = createMigrationWorker({
			db,
			handler: async (claimed, controls) => {
				await db
					.update(organizationMigrationRuns)
					.set({ status: "pause_requested" })
					.where(eq(organizationMigrationRuns.id, claimed.id));
				await controls.checkpoint("records");
				return "succeeded";
			},
		});
		await worker.runOnce();
		const paused = await db.query.organizationMigrationRuns.findFirst({
			where: eq(organizationMigrationRuns.id, run.id),
		});
		expect(paused?.status).toBe("paused");
	});

	it("automatically requeues retryable failures without losing progress", async () => {
		const { db, run } = await createQueuedRun();
		const worker = createMigrationWorker({
			db,
			now: () => 10_000,
			handler: async () => {
				throw new MigrationWorkerError("PEER_TIMEOUT", "peer timed out", true);
			},
		});
		await worker.runOnce();
		const retry = await db.query.organizationMigrationRuns.findFirst({
			where: eq(organizationMigrationRuns.id, run.id),
		});
		expect(retry?.status).toBe("queued");
		expect(retry?.errorCode).toBe("PEER_TIMEOUT");
		expect(retry?.nextAttemptAt).toBeGreaterThan(10_000);
	});
});
