import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { createApp } from "../src/app";
import { createDb } from "../src/db";
import {
	migrationReceiverCodes,
	organizationMembers,
	organizations,
	users,
} from "../src/db/schema";
import { InMemoryClerkDirectory } from "../src/services/clerk-directory";
import type { MigrationPeerClient } from "../src/services/migration-peer-client";
import {
	createMigrationCryptography,
	createMigrationEmailProof,
} from "../src/services/migration-security";
import {
	applyMigrations,
	createTestEnv,
	expectApiError,
	getAuthFixture,
} from "./test-utils";

const peer = (instanceId: string): MigrationPeerClient => ({
	discover: async (apiOrigin) => ({
		product: "jittle-lamp",
		instanceId,
		applicationVersion: "2.4.0",
		protocolVersion: "1.3",
		features: [
			"resumable-import",
			"delta-sync",
			"two-phase-finalization",
			"checksum-verification",
		],
		apiOrigin,
		webOrigin: "https://destination.example.test",
		limits: { maxRecordsPerPage: 100, maxArtifactBytes: 10_000 },
	}),
	handshake: async () => {
		throw new Error("not used");
	},
	openRun: async () => {
		throw new Error("not used");
	},
	putManifestPage: async () => {
		throw new Error("not used");
	},
	putRecordPage: async () => {
		throw new Error("not used");
	},
	putArtifact: async () => {
		throw new Error("not used");
	},
	commit: async () => {
		throw new Error("not used");
	},
	getRun: async () => {
		throw new Error("not used");
	},
	finalizeAck: async () => {
		throw new Error("not used");
	},
	notifyDiverged: async () => {
		throw new Error("not used");
	},
});

describe("migration management routes", () => {
	it("lets only an organization admin ping an entered compatible origin", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-migration-routes-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);
		const db = createDb(databaseUrl);
		if (!db) throw new Error("test database unavailable");
		const [admin, member] = await db
			.insert(users)
			.values([
				{ clerkUserId: "clerk_route_admin" },
				{ clerkUserId: "clerk_route_member" },
			])
			.returning();
		const [organization] = await db
			.insert(organizations)
			.values({
				name: "Route Team",
				isPersonal: false,
				personalOwnerUserId: null,
			})
			.returning();
		if (!admin || !member || !organization)
			throw new Error("fixtures unavailable");
		await db.insert(organizationMembers).values([
			{ organizationId: organization.id, userId: admin.id, role: "admin" },
			{ organizationId: organization.id, userId: member.id, role: "developer" },
		]);

		const { privateKey, jwtKey } = await getAuthFixture();
		const token = (subject: string) =>
			new SignJWT({})
				.setProtectedHeader({ alg: "RS256" })
				.setSubject(subject)
				.setIssuedAt()
				.setExpirationTime("5m")
				.sign(privateKey);
		const directory = new InMemoryClerkDirectory([
			{
				clerkUserId: admin.clerkUserId,
				verifiedPrimaryEmail: "migration-admin@example.test",
				firstName: "Migration",
				lastName: "Admin",
				username: null,
				imageUrl: null,
				createdAt: Date.now(),
			},
		]);
		const { app, organizationMigration } = createApp(
			createTestEnv({
				DATABASE_URL: databaseUrl,
				CLERK_JWT_KEY: jwtKey,
				JITTLE_LAMP_API_ORIGIN: "http://localhost:3001",
				WEB_APP_ORIGIN: "http://localhost:5173",
			}),
			{
				migrationPeerClient: peer(crypto.randomUUID()),
				clerkDirectory: directory,
			},
		);
		const request = async (clerkUserId: string) =>
			app.handle(
				new Request(
					`http://localhost/orgs/${organization.id}/migrations/preflight`,
					{
						method: "POST",
						headers: {
							authorization: `Bearer ${await token(clerkUserId)}`,
							"content-type": "application/json",
						},
						body: JSON.stringify({ targetApiOrigin: "http://localhost:4001" }),
					},
				),
			);

		const compatible = await request(admin.clerkUserId);
		expect(compatible.status).toBe(200);
		expect(await compatible.json()).toMatchObject({
			compatibility: {
				compatible: true,
				protocolVersion: "1.3",
				targetApiOrigin: "http://localhost:4001",
			},
		});

		const forbidden = await request(member.clerkUserId);
		expect(forbidden.status).toBe(403);
		await expectApiError(forbidden, {
			code: "MIGRATION_ADMIN_REQUIRED",
			message: "Organization admin access is required",
			status: 403,
		});

		if (!organizationMigration)
			throw new Error("migration service unavailable");
		const cryptography = createMigrationCryptography();
		const handshake = async (passphrase: string) => {
			const sourceInstanceId = crypto.randomUUID();
			const sourceOrganizationId = crypto.randomUUID();
			const emailHint = await createMigrationEmailProof(
				cryptography,
				passphrase,
				"migration-admin@example.test",
			);
			return {
				passphrase,
				sourceInstanceId,
				sourceOrganizationId,
				sourceOrganizationName: "Incoming Team",
				sourceApiOrigin: "https://source-api.example.test",
				sourceWebOrigin: "https://source.example.test",
				protocolVersion: "1.0",
				operatorEmailHints: [emailHint],
				operatorProof: await cryptography.hmac(
					passphrase,
					`${sourceInstanceId}:${sourceOrganizationId}:${emailHint}`,
				),
				encryptedLinkKey: await cryptography.encrypt(
					passphrase,
					Buffer.from(cryptography.randomBytes(32)).toString("base64url"),
				),
			};
		};

		const receiver = await organizationMigration.createReceiverCode(admin.id);
		const wrongPassphrase = receiver.passphrase.replace(
			/\.[^.]+$/,
			`.${"A".repeat(43)}`,
		);
		await expect(
			organizationMigration.acceptHandshake(await handshake(wrongPassphrase)),
		).rejects.toMatchObject({ code: "MIGRATION_RECEIVER_CODE_INVALID" });
		expect(
			(
				await db.query.migrationReceiverCodes.findFirst({
					where: eq(migrationReceiverCodes.id, receiver.id),
				})
			)?.failedAttempts,
		).toBe(1);
		const validHandshake = await handshake(receiver.passphrase);
		await organizationMigration.acceptHandshake(validHandshake);
		await expect(
			organizationMigration.acceptHandshake(validHandshake),
		).rejects.toMatchObject({ code: "MIGRATION_RECEIVER_CODE_INVALID" });

		const expired = await organizationMigration.createReceiverCode(admin.id);
		await db
			.update(migrationReceiverCodes)
			.set({ expiresAt: Date.now() - 1 })
			.where(eq(migrationReceiverCodes.id, expired.id));
		await expect(
			organizationMigration.acceptHandshake(
				await handshake(expired.passphrase),
			),
		).rejects.toMatchObject({ code: "MIGRATION_RECEIVER_CODE_INVALID" });
	}, 15_000);
});
