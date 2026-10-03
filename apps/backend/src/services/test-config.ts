import { Buffer } from "node:buffer";
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

import {
	notificationChannels,
	organizationDataKeys,
	testCredentials,
	webhookEndpoints,
} from "../db/schema";
import { recordOrganizationActivity } from "./organization-activity";
import type { BackendDb } from "./user-provisioning";

// Envelope encryption for test configuration secrets (design.md §9.3, ADR 0002 decision 9):
// AES-256-GCM with a per-organisation data key; the data key is wrapped by a server master key
// supplied by a pluggable KeyProvider (JL_SECRETS_MASTER_KEY today, a KMS later). Decryption
// happens only here, and every decrypt writes an organisation activity log entry.

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const ENVELOPE_VERSION = "v1";

export class SecretsUnavailableError extends Error {
	readonly code = "SECRETS_MASTER_KEY_MISSING";
	constructor(message: string) {
		super(message);
		this.name = "SecretsUnavailableError";
	}
}

export class SecretDecryptionError extends Error {
	readonly code = "SECRET_DECRYPTION_FAILED";
	constructor(message: string) {
		super(message);
		this.name = "SecretDecryptionError";
	}
}

export type KeyProvider = {
	// Provider kind stored with each wrapped key ("env", later "aws-kms", ...).
	readonly id: string;
	// Identifies the master key that wraps new data keys.
	currentKeyId(): string;
	wrap(dataKey: Uint8Array, context: string): Promise<string>;
	unwrap(
		wrapped: string,
		masterKeyId: string,
		context: string,
	): Promise<Uint8Array>;
};

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const fromB64url = (value: string) =>
	new Uint8Array(Buffer.from(value, "base64url"));

const sealBytes = (
	key: Uint8Array,
	plaintext: Uint8Array,
	aad: string,
): string => {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGORITHM, key, iv, {
		authTagLength: TAG_BYTES,
	});
	cipher.setAAD(Buffer.from(aad, "utf8"));
	const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `${b64url(iv)}.${b64url(Buffer.concat([body, tag]))}`;
};

const openBytes = (
	key: Uint8Array,
	sealed: string,
	aad: string,
): Uint8Array => {
	const [ivPart, bodyPart, extra] = sealed.split(".");
	if (!ivPart || !bodyPart || extra !== undefined) {
		throw new SecretDecryptionError("Malformed secret envelope");
	}
	const iv = fromB64url(ivPart);
	const payload = fromB64url(bodyPart);
	if (iv.byteLength !== IV_BYTES || payload.byteLength < TAG_BYTES) {
		throw new SecretDecryptionError("Malformed secret envelope");
	}
	try {
		const decipher = createDecipheriv(ALGORITHM, key, iv, {
			authTagLength: TAG_BYTES,
		});
		decipher.setAAD(Buffer.from(aad, "utf8"));
		decipher.setAuthTag(payload.subarray(payload.byteLength - TAG_BYTES));
		return new Uint8Array(
			Buffer.concat([
				decipher.update(payload.subarray(0, payload.byteLength - TAG_BYTES)),
				decipher.final(),
			]),
		);
	} catch {
		throw new SecretDecryptionError(
			"Secret could not be decrypted (wrong key or tampered data)",
		);
	}
};

const masterKeyId = (key: Uint8Array) =>
	`mk_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;

const decodeMasterKey = (value: string, name: string): Uint8Array => {
	const bytes = new Uint8Array(Buffer.from(value.trim(), "base64"));
	if (bytes.byteLength !== KEY_BYTES) {
		throw new SecretsUnavailableError(
			`${name} must be base64 of exactly 32 bytes (generate with: openssl rand -base64 32)`,
		);
	}
	return bytes;
};

// Master key from the environment. The previous key, when set, only unwraps; re-wrapping with
// rewrapDataKeys moves every organisation to the current key.
export const createEnvKeyProvider = (input: {
	masterKey: string | undefined;
	previousMasterKey?: string | undefined;
}): KeyProvider => {
	const current = () => {
		if (!input.masterKey) {
			throw new SecretsUnavailableError(
				"JL_SECRETS_MASTER_KEY is not configured; test credential secrets cannot be read or written. Generate one with: openssl rand -base64 32",
			);
		}
		return decodeMasterKey(input.masterKey, "JL_SECRETS_MASTER_KEY");
	};
	const byId = (id: string): Uint8Array => {
		const candidates = [
			input.masterKey
				? decodeMasterKey(input.masterKey, "JL_SECRETS_MASTER_KEY")
				: null,
			input.previousMasterKey
				? decodeMasterKey(
						input.previousMasterKey,
						"JL_SECRETS_MASTER_KEY_PREVIOUS",
					)
				: null,
		].filter((key): key is Uint8Array => key !== null);
		if (candidates.length === 0) current();
		const match = candidates.find((key) => masterKeyId(key) === id);
		if (!match) {
			throw new SecretDecryptionError(
				"The master key that wrapped this organisation's data key is not configured",
			);
		}
		return match;
	};
	return {
		id: "env",
		currentKeyId: () => masterKeyId(current()),
		wrap: async (dataKey, context) => sealBytes(current(), dataKey, context),
		unwrap: async (wrapped, id, context) =>
			openBytes(byId(id), wrapped, context),
	};
};

export type RewrapReport = {
	total: number;
	rewrapped: number;
	alreadyCurrent: number;
	unreadable: number;
};

export type SecretReadAudit = {
	actorUserId: string | null;
	runId?: string | null;
	reason: string;
	ipAddress?: string | null;
};

const dataKeyContext = (orgId: string, version: number) =>
	`jl-data-key:${orgId}:v${version}`;
const secretContext = (orgId: string, kind: string, id: string) =>
	`jl-secret:${orgId}:${kind}:${id}`;

const parseEnvelope = (
	value: string,
): { keyVersion: number; sealed: string } => {
	const [version, keyVersion, ...rest] = value.split(":");
	const parsedVersion = Number(keyVersion);
	if (
		version !== ENVELOPE_VERSION ||
		!Number.isInteger(parsedVersion) ||
		rest.length !== 1 ||
		!rest[0]
	) {
		throw new SecretDecryptionError("Malformed secret envelope");
	}
	return { keyVersion: parsedVersion, sealed: rest[0] };
};

export const createTestSecrets = (input: {
	db: BackendDb;
	keyProvider: KeyProvider;
}) => {
	const { db, keyProvider } = input;

	const insertDataKey = async (orgId: string, keyVersion: number) => {
		const dataKey = randomBytes(KEY_BYTES);
		const wrappedKey = await keyProvider.wrap(
			dataKey,
			dataKeyContext(orgId, keyVersion),
		);
		await db
			.insert(organizationDataKeys)
			.values({
				orgId,
				keyVersion,
				provider: keyProvider.id,
				masterKeyId: keyProvider.currentKeyId(),
				wrappedKey,
				status: "active",
			})
			.onConflictDoNothing();
	};

	const activeDataKey = async (
		orgId: string,
	): Promise<{ keyVersion: number; key: Uint8Array }> => {
		// Fail early with the configuration error, before any row is written.
		keyProvider.currentKeyId();
		let row = await db.query.organizationDataKeys.findFirst({
			where: and(
				eq(organizationDataKeys.orgId, orgId),
				eq(organizationDataKeys.status, "active"),
			),
			orderBy: desc(organizationDataKeys.keyVersion),
		});
		if (!row) {
			await insertDataKey(orgId, 1);
			row = await db.query.organizationDataKeys.findFirst({
				where: and(
					eq(organizationDataKeys.orgId, orgId),
					eq(organizationDataKeys.status, "active"),
				),
				orderBy: desc(organizationDataKeys.keyVersion),
			});
		}
		if (!row) throw new Error("Failed to create organisation data key");
		return {
			keyVersion: row.keyVersion,
			key: await keyProvider.unwrap(
				row.wrappedKey,
				row.masterKeyId,
				dataKeyContext(orgId, row.keyVersion),
			),
		};
	};

	const dataKeyByVersion = async (orgId: string, keyVersion: number) => {
		const row = await db.query.organizationDataKeys.findFirst({
			where: and(
				eq(organizationDataKeys.orgId, orgId),
				eq(organizationDataKeys.keyVersion, keyVersion),
			),
		});
		if (!row) {
			throw new SecretDecryptionError(
				`Organisation data key v${keyVersion} does not exist`,
			);
		}
		return keyProvider.unwrap(
			row.wrappedKey,
			row.masterKeyId,
			dataKeyContext(orgId, keyVersion),
		);
	};

	const encrypt = async (
		orgId: string,
		subject: { kind: string; id: string },
		value: Record<string, string>,
	): Promise<{ enc: string; keyVersion: number }> => {
		const { keyVersion, key } = await activeDataKey(orgId);
		const sealed = sealBytes(
			key,
			Buffer.from(JSON.stringify(value), "utf8"),
			secretContext(orgId, subject.kind, subject.id),
		);
		return { enc: `${ENVELOPE_VERSION}:${keyVersion}:${sealed}`, keyVersion };
	};

	// Raw decrypt without an audit entry; only used inside this module.
	const decryptRaw = async (
		orgId: string,
		subject: { kind: string; id: string },
		enc: string,
	): Promise<Record<string, string>> => {
		const envelope = parseEnvelope(enc);
		const key = await dataKeyByVersion(orgId, envelope.keyVersion);
		const plaintext = openBytes(
			key,
			envelope.sealed,
			secretContext(orgId, subject.kind, subject.id),
		);
		const parsed = JSON.parse(
			Buffer.from(plaintext).toString("utf8"),
		) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new SecretDecryptionError("Decrypted secret is not an object");
		}
		return Object.fromEntries(
			Object.entries(parsed as Record<string, unknown>).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		);
	};

	const decrypt = async (
		orgId: string,
		subject: { kind: string; id: string; label?: string },
		enc: string,
		audit: SecretReadAudit,
	): Promise<Record<string, string>> => {
		const value = await decryptRaw(orgId, subject, enc);
		await recordOrganizationActivity(db, {
			organizationId: orgId,
			actorUserId: audit.actorUserId,
			action: "test_config.secret_read",
			entity: { type: subject.kind, id: subject.id },
			message: `Decrypted ${subject.kind === "test_credential" ? "credential" : subject.kind} ${subject.label ?? subject.id}`,
			metadata: {
				runId: audit.runId ?? null,
				reason: audit.reason,
				fields: Object.keys(value),
			},
			ipAddress: audit.ipAddress ?? null,
		});
		return value;
	};

	// Webhook signature checks run on unauthenticated requests: decrypting there must not let
	// anyone on the internet write audit rows. Used only for that check.
	const decryptForSignatureCheck = (
		orgId: string,
		subject: { kind: string; id: string },
		enc: string,
	) => decryptRaw(orgId, subject, enc);

	// Creates a new data key version, re-encrypts every secret of the organisation with it and
	// retires the old versions. Secrets never leave the process in plaintext.
	const rotateDataKey = async (
		orgId: string,
		actorUserId: string | null,
	): Promise<{ keyVersion: number; reencrypted: number }> => {
		keyProvider.currentKeyId();
		const latest = await db.query.organizationDataKeys.findFirst({
			where: eq(organizationDataKeys.orgId, orgId),
			orderBy: desc(organizationDataKeys.keyVersion),
		});
		const nextVersion = (latest?.keyVersion ?? 0) + 1;
		const credentials = await db.query.testCredentials.findMany({
			where: eq(testCredentials.orgId, orgId),
			columns: { id: true, secretFieldsEnc: true },
		});
		const endpoints = await db.query.webhookEndpoints.findMany({
			where: and(
				eq(webhookEndpoints.orgId, orgId),
				isNull(webhookEndpoints.deletedAt),
			),
			columns: { id: true, secretEnc: true },
		});
		const channels = await db.query.notificationChannels.findMany({
			where: and(
				eq(notificationChannels.orgId, orgId),
				isNotNull(notificationChannels.secretEnc),
			),
			columns: { id: true, secretEnc: true },
		});
		const plainChannels = await Promise.all(
			channels.map(async (row) => ({
				id: row.id,
				value: await decryptRaw(
					orgId,
					{ kind: "notification_channel", id: row.id },
					row.secretEnc ?? "",
				),
			})),
		);
		const plainCredentials = await Promise.all(
			credentials
				.filter((row) => row.secretFieldsEnc)
				.map(async (row) => ({
					id: row.id,
					value: await decryptRaw(
						orgId,
						{ kind: "test_credential", id: row.id },
						row.secretFieldsEnc ?? "",
					),
				})),
		);
		const plainEndpoints = await Promise.all(
			endpoints.map(async (row) => ({
				id: row.id,
				value: await decryptRaw(
					orgId,
					{ kind: "webhook_endpoint", id: row.id },
					row.secretEnc,
				),
			})),
		);

		await insertDataKey(orgId, nextVersion);
		await db
			.update(organizationDataKeys)
			.set({ status: "retired", retiredAt: Date.now() })
			.where(
				and(
					eq(organizationDataKeys.orgId, orgId),
					eq(organizationDataKeys.status, "active"),
				),
			);
		await db
			.update(organizationDataKeys)
			.set({ status: "active", retiredAt: null })
			.where(
				and(
					eq(organizationDataKeys.orgId, orgId),
					eq(organizationDataKeys.keyVersion, nextVersion),
				),
			);

		for (const credential of plainCredentials) {
			const sealed = await encrypt(
				orgId,
				{ kind: "test_credential", id: credential.id },
				credential.value,
			);
			await db
				.update(testCredentials)
				.set({
					secretFieldsEnc: sealed.enc,
					keyVersion: sealed.keyVersion,
					updatedAt: Date.now(),
				})
				.where(eq(testCredentials.id, credential.id));
		}
		for (const endpoint of plainEndpoints) {
			const sealed = await encrypt(
				orgId,
				{ kind: "webhook_endpoint", id: endpoint.id },
				endpoint.value,
			);
			await db
				.update(webhookEndpoints)
				.set({
					secretEnc: sealed.enc,
					keyVersion: sealed.keyVersion,
					updatedAt: Date.now(),
				})
				.where(eq(webhookEndpoints.id, endpoint.id));
		}

		for (const channel of plainChannels) {
			const sealed = await encrypt(
				orgId,
				{ kind: "notification_channel", id: channel.id },
				channel.value,
			);
			await db
				.update(notificationChannels)
				.set({
					secretEnc: sealed.enc,
					keyVersion: sealed.keyVersion,
					updatedAt: Date.now(),
				})
				.where(eq(notificationChannels.id, channel.id));
		}
		await recordOrganizationActivity(db, {
			organizationId: orgId,
			actorUserId,
			action: "test_config.data_key_rotated",
			entity: { type: "organization_data_key", id: String(nextVersion) },
			message: `Rotated the test secrets data key to v${nextVersion}`,
			metadata: {
				reencrypted:
					plainCredentials.length +
					plainEndpoints.length +
					plainChannels.length,
			},
		});
		return {
			keyVersion: nextVersion,
			reencrypted:
				plainCredentials.length + plainEndpoints.length + plainChannels.length,
		};
	};

	// After a master key rotation: unwrap with whichever master key wrapped each data key and
	// wrap again with the current one.
	// Master key rotation: re-wraps every data key (active and retired) that another master key
	// wrapped, so JL_SECRETS_MASTER_KEY_PREVIOUS can be removed afterwards. Idempotent: rows
	// already under the current key are left alone, and the guarded update never overwrites a row
	// another process re-wrapped meanwhile. A row no configured key can unwrap is counted, not
	// fatal, so one stale row does not stop the others.
	const rewrapAllDataKeys = async (): Promise<RewrapReport> => {
		const currentId = keyProvider.currentKeyId();
		const rows = await db.query.organizationDataKeys.findMany();
		const report: RewrapReport = {
			total: rows.length,
			rewrapped: 0,
			alreadyCurrent: 0,
			unreadable: 0,
		};
		for (const row of rows) {
			if (row.masterKeyId === currentId) {
				report.alreadyCurrent += 1;
				continue;
			}
			const context = dataKeyContext(row.orgId, row.keyVersion);
			let key: Uint8Array;
			try {
				key = await keyProvider.unwrap(
					row.wrappedKey,
					row.masterKeyId,
					context,
				);
			} catch {
				report.unreadable += 1;
				continue;
			}
			const updated = await db
				.update(organizationDataKeys)
				.set({
					wrappedKey: await keyProvider.wrap(key, context),
					masterKeyId: currentId,
					provider: keyProvider.id,
				})
				.where(
					and(
						eq(organizationDataKeys.id, row.id),
						eq(organizationDataKeys.masterKeyId, row.masterKeyId),
					),
				)
				.returning({ id: organizationDataKeys.id });
			if (updated.length > 0) report.rewrapped += 1;
			else report.alreadyCurrent += 1;
		}
		return report;
	};

	const rewrapDataKeys = async (): Promise<number> => {
		const report = await rewrapAllDataKeys();
		if (report.unreadable > 0) {
			throw new SecretDecryptionError(
				`${report.unreadable} data key(s) were wrapped by a master key that is not configured`,
			);
		}
		return report.rewrapped;
	};

	// Throws SecretsUnavailableError before any row is written when no master key is set.
	const assertAvailable = () => {
		keyProvider.currentKeyId();
	};

	return {
		encrypt,
		decrypt,
		decryptForSignatureCheck,
		rotateDataKey,
		rewrapDataKeys,
		rewrapAllDataKeys,
		assertAvailable,
	};
};

export type TestSecrets = ReturnType<typeof createTestSecrets>;
