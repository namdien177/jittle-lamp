import { createDb } from "../db";
import {
	createEnvKeyProvider,
	createTestSecrets,
	type RewrapReport,
} from "../services/test-config";

// Master key rotation (docs/e2e-test-cases/deployment.md, "Secrets master key"):
//
//   JL_SECRETS_MASTER_KEY=<new> JL_SECRETS_MASTER_KEY_PREVIOUS=<old> DATABASE_URL=<url> \
//     bun run --cwd apps/backend secrets:rewrap
//
// Re-wraps every organisation data key under JL_SECRETS_MASTER_KEY. The credential secrets
// themselves stay encrypted with the unchanged data keys. Safe to run again: keys already under
// the current master key are skipped. Prints counts only, never key material.

type Env = Record<string, string | undefined>;

export type SecretsRewrapResult = {
	exitCode: number;
	lines: string[];
	report: RewrapReport | null;
};

const value = (env: Env, name: string) => {
	const raw = env[name]?.trim();
	return raw ? raw : undefined;
};

const fail = (message: string): SecretsRewrapResult => ({
	exitCode: 2,
	lines: [message],
	report: null,
});

const keyIsValid = (key: string) => {
	try {
		createEnvKeyProvider({ masterKey: key }).currentKeyId();
		return true;
	} catch {
		return false;
	}
};

export const runSecretsRewrap = async (
	env: Env,
): Promise<SecretsRewrapResult> => {
	const databaseUrl = value(env, "DATABASE_URL");
	const authToken = value(env, "TURSO_AUTH_TOKEN");
	const masterKey = value(env, "JL_SECRETS_MASTER_KEY");
	const previousMasterKey = value(env, "JL_SECRETS_MASTER_KEY_PREVIOUS");
	if (!databaseUrl) return fail("DATABASE_URL is required");
	if (databaseUrl.startsWith("libsql://") && !authToken) {
		return fail("TURSO_AUTH_TOKEN is required for remote libSQL/Turso URLs");
	}
	if (!masterKey) {
		return fail("JL_SECRETS_MASTER_KEY (the new master key) is required");
	}
	for (const [name, key] of [
		["JL_SECRETS_MASTER_KEY", masterKey],
		["JL_SECRETS_MASTER_KEY_PREVIOUS", previousMasterKey],
	] as const) {
		if (key !== undefined && !keyIsValid(key)) {
			return fail(
				`${name} must be base64 of exactly 32 bytes (generate with: openssl rand -base64 32)`,
			);
		}
	}
	const db = createDb(databaseUrl, authToken);
	if (!db) return fail("DATABASE_URL is required");
	try {
		const secrets = createTestSecrets({
			db,
			keyProvider: createEnvKeyProvider({ masterKey, previousMasterKey }),
		});
		const report = await secrets.rewrapAllDataKeys();
		const lines = [
			`data keys: ${report.total} total, ${report.rewrapped} re-wrapped, ${report.alreadyCurrent} already on the current master key, ${report.unreadable} unreadable`,
		];
		if (report.unreadable > 0) {
			lines.push(
				previousMasterKey
					? "Some data keys were wrapped by a master key that is neither JL_SECRETS_MASTER_KEY nor JL_SECRETS_MASTER_KEY_PREVIOUS. Keep the previous key configured and find the right key before removing it."
					: "Some data keys were wrapped by another master key. Set JL_SECRETS_MASTER_KEY_PREVIOUS to the old key and run again.",
			);
			return { exitCode: 1, lines, report };
		}
		return { exitCode: 0, lines, report };
	} finally {
		db.$client.close();
	}
};

if (import.meta.main) {
	const result = await runSecretsRewrap(process.env);
	for (const line of result.lines) {
		if (result.exitCode === 0) console.log(line);
		else console.error(line);
	}
	process.exit(result.exitCode);
}
