import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";

import {
	organizationStorageSettings,
	organizationStorages,
} from "../db/schema";
import {
	type ArtifactStorage,
	createS3ArtifactStorage,
	type S3StorageConfig,
} from "./artifact-storage";
import type { TestSecrets } from "./test-config";
import type { BackendDb } from "./user-provisioning";

// Resolves which bucket an artifact lives in. Every artifact row carries `storageId`
// (null = the JittleLamp default storage); every storage call goes through this registry so
// uploads, playback, deletes, copies and transfers always reach the right bucket.

export class StorageAccessError extends Error {
	constructor(
		public readonly code:
			| "ARTIFACT_STORAGE_REMOVED"
			| "STORAGE_WRITE_TARGET_UNAVAILABLE"
			| "STORAGE_CREDENTIALS_UNAVAILABLE",
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = "StorageAccessError";
	}
}

export type StorageRow = typeof organizationStorages.$inferSelect;

export type StorageCredentials = {
	accessKeyId: string;
	secretAccessKey: string;
};

export type StorageClientFactory = (config: S3StorageConfig) => ArtifactStorage;

export type ArtifactObjectRef = { storageId: string | null; s3Key: string };

export type StorageRegistry = {
	readonly defaultStorage: ArtifactStorage;
	forArtifact(artifact: { storageId: string | null }): Promise<ArtifactStorage>;
	forWrite(
		orgId: string,
	): Promise<{ storageId: string | null; storage: ArtifactStorage }>;
	// Builds a client for a storage that is not saved yet (connection test before saving).
	forConfig(config: S3StorageConfig): ArtifactStorage;
	// Best effort; failures are counted, not thrown.
	deleteObjects(refs: ArtifactObjectRef[]): Promise<{ failed: number }>;
	invalidate(storageId: string): void;
};

export const storageConfigFromRow = (
	row: Pick<
		StorageRow,
		| "bucket"
		| "keyPrefix"
		| "region"
		| "endpoint"
		| "forcePathStyle"
		| "serverSideEncryption"
	>,
	credentials: StorageCredentials,
): S3StorageConfig => ({
	bucket: row.bucket,
	keyPrefix: row.keyPrefix ?? undefined,
	region: row.region,
	endpoint: row.endpoint ?? undefined,
	accessKeyId: credentials.accessKeyId,
	secretAccessKey: credentials.secretAccessKey,
	forcePathStyle: row.forcePathStyle,
	serverSideEncryption: row.serverSideEncryption,
});

export const createStorageRegistry = (input: {
	db: BackendDb | null;
	defaultStorage: ArtifactStorage;
	secrets: Pick<TestSecrets, "decryptStorageCredentials"> | null;
	signedUrlTtlSeconds?: number;
	clientFactory?: StorageClientFactory;
}): StorageRegistry => {
	const factory = input.clientFactory ?? createS3ArtifactStorage;
	const cache = new Map<
		string,
		{ version: string; storage: ArtifactStorage }
	>();

	const build = (config: S3StorageConfig) =>
		factory({
			...config,
			signedUrlTtlSeconds:
				config.signedUrlTtlSeconds ?? input.signedUrlTtlSeconds,
		});

	const forStorageRow = async (row: StorageRow): Promise<ArtifactStorage> => {
		if (row.status !== "active" || !row.credentialsEnc) {
			throw new StorageAccessError(
				"ARTIFACT_STORAGE_REMOVED",
				"The storage holding this artifact was removed from the organization",
				410,
			);
		}
		const version = createHash("sha256")
			.update(`${row.updatedAt}:${row.credentialsEnc}`)
			.digest("hex");
		const cached = cache.get(row.id);
		if (cached?.version === version) return cached.storage;
		if (!input.secrets) {
			throw new StorageAccessError(
				"STORAGE_CREDENTIALS_UNAVAILABLE",
				"Storage credentials cannot be decrypted on this server",
				503,
			);
		}
		let credentials: Record<string, string>;
		try {
			credentials = await input.secrets.decryptStorageCredentials(
				row,
				row.credentialsEnc,
			);
		} catch (error) {
			throw new StorageAccessError(
				"STORAGE_CREDENTIALS_UNAVAILABLE",
				error instanceof Error
					? `Storage credentials cannot be decrypted: ${error.message}`
					: "Storage credentials cannot be decrypted",
				503,
			);
		}
		const storage = build(
			storageConfigFromRow(row, {
				accessKeyId: credentials.accessKeyId ?? "",
				secretAccessKey: credentials.secretAccessKey ?? "",
			}),
		);
		cache.set(row.id, { version, storage });
		return storage;
	};

	const loadRow = async (storageId: string): Promise<StorageRow> => {
		const row = input.db
			? await input.db.query.organizationStorages.findFirst({
					where: eq(organizationStorages.id, storageId),
				})
			: undefined;
		if (!row) {
			throw new StorageAccessError(
				"ARTIFACT_STORAGE_REMOVED",
				"The storage holding this artifact no longer exists",
				410,
			);
		}
		return row;
	};

	const forArtifact: StorageRegistry["forArtifact"] = async (artifact) =>
		artifact.storageId
			? forStorageRow(await loadRow(artifact.storageId))
			: input.defaultStorage;

	return {
		defaultStorage: input.defaultStorage,
		forArtifact,
		forWrite: async (orgId) => {
			const settings = input.db
				? await input.db.query.organizationStorageSettings.findFirst({
						where: eq(organizationStorageSettings.orgId, orgId),
					})
				: undefined;
			if (settings?.defaultStorageId) {
				const row = await loadRow(settings.defaultStorageId);
				if (row.status === "active") {
					return { storageId: row.id, storage: await forStorageRow(row) };
				}
			}
			if (settings?.defaultStorageDisabled) {
				throw new StorageAccessError(
					"STORAGE_WRITE_TARGET_UNAVAILABLE",
					"This organization stores evidence only in its own storage, and none is selected",
					409,
				);
			}
			// Future: the default storage quota check goes here.
			return { storageId: null, storage: input.defaultStorage };
		},
		forConfig: build,
		deleteObjects: async (refs) => {
			const results = await Promise.allSettled(
				refs.map(async (ref) =>
					(await forArtifact(ref)).deleteObject({ key: ref.s3Key }),
				),
			);
			return {
				failed: results.filter((result) => result.status === "rejected").length,
			};
		},
		invalidate: (storageId) => {
			cache.delete(storageId);
		},
	};
};

// Put, read back, compare and delete a canary object; proves the credentials can write, read
// and delete in the bucket before a storage is saved or used.
export const verifyStorageRoundTrip = async (
	storage: ArtifactStorage,
): Promise<void> => {
	const key = `storage-canary/${crypto.randomUUID()}`;
	const body = new TextEncoder().encode(`jittle-lamp-storage-canary:${key}`);
	const digest = (bytes: Uint8Array) =>
		createHash("sha256").update(bytes).digest("base64");
	try {
		await storage.putObject({
			key,
			body,
			contentType: "text/plain",
			checksumSha256: digest(body),
		});
		const read = await storage.getObject({ key });
		if (digest(read) !== digest(body)) {
			throw new Error("the object read back does not match what was written");
		}
	} catch (error) {
		await storage.deleteObject({ key }).catch(() => undefined);
		throw error;
	}
	await storage.deleteObject({ key });
};
