import { describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { runSecretsRewrap } from "../src/cli/secrets-rewrap";
import { createDb } from "../src/db";
import { organizationDataKeys, testCredentials } from "../src/db/schema";
import {
	createEnvKeyProvider,
	createTestSecrets,
} from "../src/services/test-config";
import { ensureUserAndPersonalOrganization } from "../src/services/user-provisioning";
import { applyMigrations } from "./test-utils";

// Master key rotation command (bun run --cwd apps/backend secrets:rewrap).

// Obviously fake values; never real credentials.
const FAKE_PASSWORD = "fake-Passw0rd-for-rewrap-tests";
const newMasterKey = () => randomBytes(32).toString("base64");
const keyId = (base64: string) =>
	`mk_${createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex").slice(0, 16)}`;

const seed = async (oldKey: string, organisations: number) => {
	const databaseUrl = `file:/tmp/jittle-lamp-rewrap-${crypto.randomUUID()}.db`;
	await applyMigrations(databaseUrl);
	const db = createDb(databaseUrl);
	if (!db) throw new Error("Expected database");
	const secrets = createTestSecrets({
		db,
		keyProvider: createEnvKeyProvider({ masterKey: oldKey }),
	});
	const sealed: Array<{ orgId: string; credentialId: string; enc: string }> =
		[];
	for (let index = 0; index < organisations; index += 1) {
		const owner = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: `user_rewrap_${crypto.randomUUID()}`,
			source: "clerk-callback",
			rawPayload: {},
		});
		const [credential] = await db
			.insert(testCredentials)
			.values({ orgId: owner.organizationId, profile: "PCF_HQ_ADMIN" })
			.returning({ id: testCredentials.id });
		if (!credential) throw new Error("Expected credential");
		const subject = { kind: "test_credential", id: credential.id };
		const { enc } = await secrets.encrypt(owner.organizationId, subject, {
			password: FAKE_PASSWORD,
		});
		sealed.push({
			orgId: owner.organizationId,
			credentialId: credential.id,
			enc,
		});
	}
	// One organisation also has a retired data key version.
	const first = sealed[0];
	if (first) {
		await secrets.rotateDataKey(first.orgId, null);
	}
	return { databaseUrl, db, sealed };
};

describe("secrets:rewrap", () => {
	it("re-wraps every data key under the new master key, idempotently, printing counts only", async () => {
		const oldKey = newMasterKey();
		const newKey = newMasterKey();
		const { databaseUrl, db, sealed } = await seed(oldKey, 3);
		const env = {
			DATABASE_URL: databaseUrl,
			JL_SECRETS_MASTER_KEY: newKey,
			JL_SECRETS_MASTER_KEY_PREVIOUS: oldKey,
		};

		const first = await runSecretsRewrap(env);
		expect(first.exitCode).toBe(0);
		// 3 active keys plus the retired version of the first organisation.
		expect(first.report).toEqual({
			total: 4,
			rewrapped: 4,
			alreadyCurrent: 0,
			unreadable: 0,
		});
		const output = first.lines.join("\n");
		expect(output).toBe(
			"data keys: 4 total, 4 re-wrapped, 0 already on the current master key, 0 unreadable",
		);
		for (const secret of [oldKey, newKey, keyId(oldKey), keyId(newKey)]) {
			expect(output).not.toContain(secret);
		}
		const rows = await db.query.organizationDataKeys.findMany();
		expect(new Set(rows.map((row) => row.masterKeyId))).toEqual(
			new Set([keyId(newKey)]),
		);

		const again = await runSecretsRewrap(env);
		expect(again.exitCode).toBe(0);
		expect(again.report).toMatchObject({ rewrapped: 0, alreadyCurrent: 4 });

		// Without the previous key the secrets stay readable.
		const after = createTestSecrets({
			db,
			keyProvider: createEnvKeyProvider({ masterKey: newKey }),
		});
		for (const entry of sealed.slice(1)) {
			expect(
				await after.decrypt(
					entry.orgId,
					{ kind: "test_credential", id: entry.credentialId },
					entry.enc,
					{ actorUserId: null, reason: "test" },
				),
			).toEqual({ password: FAKE_PASSWORD });
		}
	});

	it("counts data keys no configured key can unwrap and exits non-zero", async () => {
		const oldKey = newMasterKey();
		const { databaseUrl, db } = await seed(oldKey, 2);
		const result = await runSecretsRewrap({
			DATABASE_URL: databaseUrl,
			JL_SECRETS_MASTER_KEY: newMasterKey(),
		});
		expect(result.exitCode).toBe(1);
		expect(result.report).toMatchObject({ rewrapped: 0, unreadable: 3 });
		expect(result.lines.join("\n")).toContain(
			"Set JL_SECRETS_MASTER_KEY_PREVIOUS",
		);
		const rows = await db.query.organizationDataKeys.findMany({
			where: eq(organizationDataKeys.masterKeyId, keyId(oldKey)),
		});
		expect(rows).toHaveLength(3);
	});

	it("refuses to start without a database or a valid new key", async () => {
		expect((await runSecretsRewrap({})).exitCode).toBe(2);
		expect(
			(
				await runSecretsRewrap({
					DATABASE_URL: "file:/tmp/unused.db",
				})
			).lines,
		).toEqual(["JL_SECRETS_MASTER_KEY (the new master key) is required"]);
		const short = await runSecretsRewrap({
			DATABASE_URL: "file:/tmp/unused.db",
			JL_SECRETS_MASTER_KEY: "dG9vLXNob3J0",
		});
		expect(short.exitCode).toBe(2);
		expect(short.lines[0]).toContain("JL_SECRETS_MASTER_KEY must be base64");
	});

	it("runs as the secrets:rewrap package script", async () => {
		const oldKey = newMasterKey();
		const newKey = newMasterKey();
		const { databaseUrl } = await seed(oldKey, 1);
		const child = Bun.spawn(
			["bun", "run", "--cwd", join(import.meta.dir, ".."), "secrets:rewrap"],
			{
				env: {
					PATH: process.env.PATH ?? "",
					HOME: process.env.HOME ?? "",
					DATABASE_URL: databaseUrl,
					JL_SECRETS_MASTER_KEY: newKey,
					JL_SECRETS_MASTER_KEY_PREVIOUS: oldKey,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			child.exited,
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain(
			"data keys: 2 total, 2 re-wrapped, 0 already on the current master key, 0 unreadable",
		);
		expect(stdout).not.toContain(newKey);
		expect(stdout).not.toContain(oldKey);
	});
});
