import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
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

// DEV ONLY: with in-memory storage there is no S3 to sign read URLs, so local dev-auth setups
// get a signed URL to a backend route that streams the object (routes/dev-artifacts.ts). Never
// active with S3 configured, outside local/development, or without dev auth.
export const devArtifactReadEnabled = (runtime: RuntimeConfig): boolean =>
	!runtime.s3 &&
	runtime.devAuthEnabled &&
	(runtime.nodeEnv === "local" || runtime.nodeEnv === "development") &&
	Boolean(runtime.secret);

export const DEV_ARTIFACT_ROUTE = "/dev/artifacts";
const DEV_ARTIFACT_TTL_SECONDS = 900;

const devSignature = (secret: string, payload: string) =>
	createHmac("sha256", secret)
		.update(`dev-artifact:${payload}`)
		.digest("base64url");

export const signDevArtifactToken = (
	secret: string,
	input: { key: string; contentType: string; expiresAt: number },
): string => {
	const payload = Buffer.from(
		JSON.stringify({ k: input.key, t: input.contentType, e: input.expiresAt }),
	).toString("base64url");
	return `${payload}.${devSignature(secret, payload)}`;
};

export const verifyDevArtifactToken = (
	secret: string,
	token: string,
	now = Date.now(),
): { key: string; contentType: string } | null => {
	const [payload, signature, extra] = token.split(".");
	if (!payload || !signature || extra !== undefined) return null;
	const expected = Buffer.from(devSignature(secret, payload));
	const actual = Buffer.from(signature);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		return null;
	}
	try {
		const parsed = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		) as {
			k?: unknown;
			t?: unknown;
			e?: unknown;
		};
		if (
			typeof parsed.k !== "string" ||
			typeof parsed.t !== "string" ||
			typeof parsed.e !== "number" ||
			parsed.e < now
		) {
			return null;
		}
		return { key: parsed.k, contentType: parsed.t };
	} catch {
		return null;
	}
};

export const devArtifactBaseUrl = (runtime: RuntimeConfig): string =>
	runtime.apiOrigin ??
	`http://${runtime.host === "0.0.0.0" ? "127.0.0.1" : runtime.host}:${runtime.port}`;

export const createArtifactStorage = (
	runtime: RuntimeConfig,
): ArtifactStorage => {
	if (!runtime.s3) {
		const secret = runtime.secret;
		return createMemoryArtifactStorage(
			devArtifactReadEnabled(runtime) && secret
				? { baseUrl: devArtifactBaseUrl(runtime), secret }
				: undefined,
		);
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

const createMemoryArtifactStorage = (devRead?: {
	baseUrl: string;
	secret: string;
}): ArtifactStorage => ({
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
	createReadUrl: async (input) => {
		if (!devRead) {
			throw new Error(
				"S3 storage is not configured; signed read URLs are unavailable.",
			);
		}
		const ttlSeconds = input.expiresInSeconds ?? DEV_ARTIFACT_TTL_SECONDS;
		const expiresAt = Date.now() + ttlSeconds * 1000;
		const token = signDevArtifactToken(devRead.secret, {
			key: input.key,
			contentType: input.responseContentType,
			expiresAt,
		});
		return {
			url: `${devRead.baseUrl}${DEV_ARTIFACT_ROUTE}/${token}`,
			expiresAt,
			ttlSeconds,
		};
	},
	deleteObject: async (input) => {
		memoryObjects.delete(input.key);
	},
});
