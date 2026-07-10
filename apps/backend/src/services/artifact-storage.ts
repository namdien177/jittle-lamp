import {
	DeleteObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { RuntimeConfig } from "../config/runtime";

export type ArtifactStorage = {
	mode: "s3" | "memory";
	putObject: (input: {
		key: string;
		body: Uint8Array;
		contentType: string;
		checksumSha256: string;
	}) => Promise<void>;
	getObject: (input: { key: string }) => Promise<Uint8Array>;
	createReadUrl: (input: {
		key: string;
		responseContentType: string;
		expiresInSeconds?: number;
	}) => Promise<{ url: string; expiresAt: number; ttlSeconds: number }>;
	deleteObject: (input: { key: string }) => Promise<void>;
};

const memoryObjects = new Map<
	string,
	{ body: Uint8Array; contentType: string; checksumSha256: string }
>();

export const createArtifactStorage = (
	runtime: RuntimeConfig,
): ArtifactStorage => {
	if (!runtime.s3) {
		return createMemoryArtifactStorage();
	}

	const client = new S3Client({
		region: runtime.s3.region,
		forcePathStyle: runtime.s3.forcePathStyle,
		credentials: {
			accessKeyId: runtime.s3.accessKeyId,
			secretAccessKey: runtime.s3.secretAccessKey,
		},
		...(runtime.s3.endpoint ? { endpoint: runtime.s3.endpoint } : {}),
	});

	return {
		mode: "s3",
		putObject: async (input) => {
			await client.send(
				new PutObjectCommand({
					Bucket: runtime.s3?.bucket,
					Key: input.key,
					Body: input.body,
					ContentType: input.contentType,
					ChecksumSHA256: input.checksumSha256,
					ServerSideEncryption: "AES256",
				}),
			);
		},
		getObject: async (input) => {
			const response = await client.send(
				new GetObjectCommand({
					Bucket: runtime.s3?.bucket,
					Key: input.key,
				}),
			);
			if (!response.Body) {
				throw new Error("Stored artifact body is empty");
			}
			return response.Body.transformToByteArray();
		},
		createReadUrl: async (input) => {
			const ttlSeconds =
				input.expiresInSeconds ?? runtime.s3?.signedUrlTtlSeconds ?? 900;
			const expiresAt = Date.now() + ttlSeconds * 1000;
			const url = await getSignedUrl(
				client,
				new GetObjectCommand({
					Bucket: runtime.s3?.bucket,
					Key: input.key,
					ResponseContentType: input.responseContentType,
				}),
				{ expiresIn: ttlSeconds },
			);

			return { url, expiresAt, ttlSeconds };
		},
		deleteObject: async (input) => {
			await client.send(
				new DeleteObjectCommand({
					Bucket: runtime.s3?.bucket,
					Key: input.key,
				}),
			);
		},
	};
};

const createMemoryArtifactStorage = (): ArtifactStorage => ({
	mode: "memory",
	putObject: async (input) => {
		memoryObjects.set(input.key, {
			body: input.body,
			contentType: input.contentType,
			checksumSha256: input.checksumSha256,
		});
	},
	getObject: async (input) => {
		const stored = memoryObjects.get(input.key);
		if (!stored) throw new Error("Stored artifact was not found");
		return Uint8Array.from(stored.body);
	},
	createReadUrl: async () => {
		throw new Error(
			"S3 storage is not configured; signed read URLs are unavailable.",
		);
	},
	deleteObject: async (input) => {
		memoryObjects.delete(input.key);
	},
});
