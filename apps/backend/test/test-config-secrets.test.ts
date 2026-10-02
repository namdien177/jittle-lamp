import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { createClient } from "@libsql/client";
import { and, eq } from "drizzle-orm";

import { parseEnv } from "../src/config/env";
import { createDb } from "../src/db";
import {
	organizationActivityLogs,
	organizationDataKeys,
	testCredentials,
} from "../src/db/schema";
import {
	createEnvKeyProvider,
	createTestSecrets,
	SecretDecryptionError,
	SecretsUnavailableError,
} from "../src/services/test-config";
import { ensureUserAndPersonalOrganization } from "../src/services/user-provisioning";
import { applyMigrations } from "./test-utils";

// Obviously fake values; never real credentials.
const FAKE_PASSWORD = "fake-Passw0rd-for-tests-only";
const newMasterKey = () => randomBytes(32).toString("base64");

const setup = async (masterKey = newMasterKey()) => {
	const databaseUrl = `file:/tmp/jittle-lamp-secrets-${crypto.randomUUID()}.db`;
	await applyMigrations(databaseUrl);
	const db = createDb(databaseUrl);
	if (!db) throw new Error("Expected database");
	const owner = await ensureUserAndPersonalOrganization(db, {
		clerkUserId: `user_secrets_${crypto.randomUUID()}`,
		source: "clerk-callback",
		rawPayload: {},
	});
	const secrets = createTestSecrets({
		db,
		keyProvider: createEnvKeyProvider({ masterKey }),
	});
	const [credential] = await db
		.insert(testCredentials)
		.values({
			orgId: owner.organizationId,
			profile: "PCF_HQ_ADMIN",
			fieldsJson: JSON.stringify({ username: "hq.admin@example.test" }),
		})
		.returning({ id: testCredentials.id });
	if (!credential) throw new Error("Expected credential");
	return {
		databaseUrl,
		db,
		masterKey,
		orgId: owner.organizationId,
		userId: owner.userId,
		secrets,
		credentialId: credential.id,
	};
};

const subject = (id: string) => ({ kind: "test_credential", id });

describe("test config secrets", () => {
	it("round-trips secret fields and logs every decrypt", async () => {
		const { db, orgId, userId, secrets, credentialId } = await setup();
		const sealed = await secrets.encrypt(orgId, subject(credentialId), {
			password: FAKE_PASSWORD,
		});
		expect(sealed.keyVersion).toBe(1);
		expect(sealed.enc).not.toContain(FAKE_PASSWORD);

		const value = await secrets.decrypt(
			orgId,
			subject(credentialId),
			sealed.enc,
			{
				actorUserId: userId,
				runId: "run-123",
				reason: "run.config",
			},
		);
		expect(value).toEqual({ password: FAKE_PASSWORD });

		const logs = await db.query.organizationActivityLogs.findMany({
			where: and(
				eq(organizationActivityLogs.organizationId, orgId),
				eq(organizationActivityLogs.action, "test_config.secret_read"),
			),
		});
		expect(logs).toHaveLength(1);
		expect(logs[0]?.actorUserId).toBe(userId);
		expect(JSON.parse(logs[0]?.metadataJson ?? "{}")).toMatchObject({
			runId: "run-123",
			reason: "run.config",
			fields: ["password"],
		});
		expect(logs[0]?.metadataJson).not.toContain(FAKE_PASSWORD);
	});

	it("detects tampering and binds ciphertext to its row", async () => {
		const { orgId, userId, secrets, credentialId } = await setup();
		const sealed = await secrets.encrypt(orgId, subject(credentialId), {
			password: FAKE_PASSWORD,
		});
		const audit = { actorUserId: userId, reason: "test" };
		const [prefix, version, body] = sealed.enc.split(":");
		const [iv, payload] = (body ?? "").split(".");
		const bytes = Buffer.from(payload ?? "", "base64url");
		bytes[0] = (bytes[0] ?? 0) ^ 0xff;
		const tampered = `${prefix}:${version}:${iv}.${bytes.toString("base64url")}`;

		await expect(
			secrets.decrypt(orgId, subject(credentialId), tampered, audit),
		).rejects.toBeInstanceOf(SecretDecryptionError);
		// Same ciphertext presented for another credential fails authentication.
		await expect(
			secrets.decrypt(orgId, subject(crypto.randomUUID()), sealed.enc, audit),
		).rejects.toBeInstanceOf(SecretDecryptionError);
		await expect(
			secrets.decrypt(orgId, subject(credentialId), "v1:1:garbage", audit),
		).rejects.toBeInstanceOf(SecretDecryptionError);
	});

	it("rejects a wrong or missing master key with a clear error", async () => {
		const { db, orgId, userId, secrets, credentialId } = await setup();
		const sealed = await secrets.encrypt(orgId, subject(credentialId), {
			password: FAKE_PASSWORD,
		});
		const wrong = createTestSecrets({
			db,
			keyProvider: createEnvKeyProvider({ masterKey: newMasterKey() }),
		});
		await expect(
			wrong.decrypt(orgId, subject(credentialId), sealed.enc, {
				actorUserId: userId,
				reason: "test",
			}),
		).rejects.toBeInstanceOf(SecretDecryptionError);

		const missing = createTestSecrets({
			db,
			keyProvider: createEnvKeyProvider({ masterKey: undefined }),
		});
		await expect(
			missing.encrypt(orgId, subject(credentialId), { password: "x" }),
		).rejects.toBeInstanceOf(SecretsUnavailableError);
		await expect(
			missing.encrypt(orgId, subject(credentialId), { password: "x" }),
		).rejects.toThrow(/JL_SECRETS_MASTER_KEY is not configured/);

		expect(() => parseEnv({ JL_SECRETS_MASTER_KEY: "dG9vLXNob3J0" })).toThrow(
			/32 bytes/,
		);
		expect(
			parseEnv({ JL_SECRETS_MASTER_KEY: newMasterKey() }).JL_SECRETS_MASTER_KEY,
		).toBeString();
	});

	it("rotates the organisation data key and the master key", async () => {
		const { db, orgId, userId, secrets, credentialId, masterKey } =
			await setup();
		const sealed = await secrets.encrypt(orgId, subject(credentialId), {
			password: FAKE_PASSWORD,
		});
		await db
			.update(testCredentials)
			.set({ secretFieldsEnc: sealed.enc, keyVersion: sealed.keyVersion })
			.where(eq(testCredentials.id, credentialId));

		const rotated = await secrets.rotateDataKey(orgId, userId);
		expect(rotated).toEqual({ keyVersion: 2, reencrypted: 1 });
		const keys = await db.query.organizationDataKeys.findMany({
			where: eq(organizationDataKeys.orgId, orgId),
		});
		expect(keys.map((key) => [key.keyVersion, key.status]).sort()).toEqual([
			[1, "retired"],
			[2, "active"],
		]);
		const row = await db.query.testCredentials.findFirst({
			where: eq(testCredentials.id, credentialId),
		});
		expect(row?.keyVersion).toBe(2);
		expect(row?.secretFieldsEnc?.startsWith("v1:2:")).toBe(true);
		const audit = { actorUserId: userId, reason: "test" };
		expect(
			await secrets.decrypt(
				orgId,
				subject(credentialId),
				row?.secretFieldsEnc ?? "",
				audit,
			),
		).toEqual({ password: FAKE_PASSWORD });

		// Master key rotation: the old key only unwraps until every data key is re-wrapped.
		const nextMaster = newMasterKey();
		const transitional = createTestSecrets({
			db,
			keyProvider: createEnvKeyProvider({
				masterKey: nextMaster,
				previousMasterKey: masterKey,
			}),
		});
		expect(await transitional.rewrapDataKeys()).toBe(2);
		const afterRotation = createTestSecrets({
			db,
			keyProvider: createEnvKeyProvider({ masterKey: nextMaster }),
		});
		expect(
			await afterRotation.decrypt(
				orgId,
				subject(credentialId),
				row?.secretFieldsEnc ?? "",
				audit,
			),
		).toEqual({ password: FAKE_PASSWORD });
	});

	it("never stores plaintext secrets or data keys", async () => {
		const { databaseUrl, db, orgId, secrets, credentialId, masterKey } =
			await setup();
		const sealed = await secrets.encrypt(orgId, subject(credentialId), {
			password: FAKE_PASSWORD,
		});
		await db
			.update(testCredentials)
			.set({ secretFieldsEnc: sealed.enc })
			.where(eq(testCredentials.id, credentialId));
		const client = createClient({ url: databaseUrl });
		const tables = await client.execute(
			"select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '%_fts%'",
		);
		for (const table of tables.rows.map((entry) => String(entry.name))) {
			const rows = await client.execute(`select * from "${table}"`);
			const dump = JSON.stringify(rows.rows);
			expect(dump.includes(FAKE_PASSWORD)).toBe(false);
			expect(dump.includes(masterKey)).toBe(false);
		}
		client.close();
	});
});
