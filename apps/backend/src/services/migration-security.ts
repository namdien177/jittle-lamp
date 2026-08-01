import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { NodeEnv } from "../config/env";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64Url = (bytes: Uint8Array): string =>
	Buffer.from(bytes).toString("base64url");
const fromBase64Url = (value: string): Uint8Array =>
	Uint8Array.from(Buffer.from(value, "base64url"));

export type MigrationCryptography = {
	randomBytes(length: number): Uint8Array;
	sha256(value: string | Uint8Array): Promise<string>;
	hmac(key: string | Uint8Array, value: string): Promise<string>;
	encrypt(keyMaterial: string | Uint8Array, value: string): Promise<string>;
	decrypt(keyMaterial: string | Uint8Array, value: string): Promise<string>;
};

const bytes = (value: string | Uint8Array): Uint8Array =>
	typeof value === "string" ? encoder.encode(value) : value;
const bufferSource = (value: string | Uint8Array): ArrayBuffer =>
	Uint8Array.from(bytes(value)).buffer;

const deriveAesKey = async (
	material: string | Uint8Array,
): Promise<CryptoKey> => {
	const digest = await crypto.subtle.digest("SHA-256", bufferSource(material));
	return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
};

export const createMigrationCryptography = (): MigrationCryptography => ({
	randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
	sha256: async (value) => {
		const digest = await crypto.subtle.digest("SHA-256", bufferSource(value));
		return Array.from(new Uint8Array(digest), (part) =>
			part.toString(16).padStart(2, "0"),
		).join("");
	},
	hmac: async (key, value) => {
		const cryptoKey = await crypto.subtle.importKey(
			"raw",
			bufferSource(key),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		return toBase64Url(
			new Uint8Array(
				await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)),
			),
		);
	},
	encrypt: async (keyMaterial, value) => {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ciphertext = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			await deriveAesKey(keyMaterial),
			encoder.encode(value),
		);
		return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
	},
	decrypt: async (keyMaterial, value) => {
		const [version, encodedIv, encodedCiphertext, extra] = value.split(".");
		if (version !== "v1" || !encodedIv || !encodedCiphertext || extra) {
			throw new Error("Invalid encrypted migration credential");
		}
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: bufferSource(fromBase64Url(encodedIv)) },
			await deriveAesKey(keyMaterial),
			bufferSource(fromBase64Url(encodedCiphertext)),
		);
		return decoder.decode(plaintext);
	},
});

export const createMigrationPassphrase = (
	cryptography: MigrationCryptography,
	codeId = crypto.randomUUID(),
): string => `jl_mig_${codeId}.${toBase64Url(cryptography.randomBytes(32))}`;

export const normalizeMigrationEmail = (email: string): string =>
	email.trim().toLowerCase();

export const createMigrationEmailProof = (
	cryptography: MigrationCryptography,
	passphrase: string,
	email: string,
): Promise<string> =>
	cryptography.hmac(
		passphrase,
		`jittle-lamp-admin:${normalizeMigrationEmail(email)}`,
	);

const isIpv4InRange = (
	address: string,
	prefix: readonly number[],
	maskBits: number,
): boolean => {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
		return false;
	}
	const addressValue =
		parts.reduce((value, part) => (value << 8) + part, 0) >>> 0;
	const prefixValue =
		prefix.reduce((value, part) => (value << 8) + part, 0) >>> 0;
	const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
	return (addressValue & mask) === (prefixValue & mask);
};

export const isRestrictedMigrationAddress = (address: string): boolean => {
	const normalized = address.toLowerCase().split("%")[0] ?? address;
	if (isIP(normalized) === 4) {
		return (
			isIpv4InRange(normalized, [0, 0, 0, 0], 8) ||
			isIpv4InRange(normalized, [10, 0, 0, 0], 8) ||
			isIpv4InRange(normalized, [100, 64, 0, 0], 10) ||
			isIpv4InRange(normalized, [127, 0, 0, 0], 8) ||
			isIpv4InRange(normalized, [169, 254, 0, 0], 16) ||
			isIpv4InRange(normalized, [172, 16, 0, 0], 12) ||
			isIpv4InRange(normalized, [192, 0, 0, 0], 24) ||
			isIpv4InRange(normalized, [192, 168, 0, 0], 16) ||
			isIpv4InRange(normalized, [198, 18, 0, 0], 15) ||
			isIpv4InRange(normalized, [224, 0, 0, 0], 4)
		);
	}
	if (isIP(normalized) === 6) {
		return (
			normalized === "::" ||
			normalized === "::1" ||
			normalized.startsWith("fc") ||
			normalized.startsWith("fd") ||
			/^fe[89ab]/.test(normalized) ||
			normalized.startsWith("ff") ||
			normalized.startsWith("::ffff:")
		);
	}
	return true;
};

export const isPrivateMigrationAddress = (address: string): boolean => {
	const normalized = address.toLowerCase().split("%")[0] ?? address;
	if (isIP(normalized) === 4) {
		return (
			isIpv4InRange(normalized, [10, 0, 0, 0], 8) ||
			isIpv4InRange(normalized, [100, 64, 0, 0], 10) ||
			isIpv4InRange(normalized, [172, 16, 0, 0], 12) ||
			isIpv4InRange(normalized, [192, 168, 0, 0], 16)
		);
	}
	return (
		isIP(normalized) === 6 &&
		(normalized.startsWith("fc") || normalized.startsWith("fd"))
	);
};

export type MigrationDnsResolver = (
	hostname: string,
) => Promise<readonly string[]>;

const defaultResolver: MigrationDnsResolver = async (hostname) =>
	(await lookup(hostname, { all: true, verbatim: true })).map(
		(result) => result.address,
	);

export const validateMigrationTargetOrigin = async (input: {
	origin: string;
	nodeEnv: NodeEnv;
	allowPrivateNetworks?: boolean;
	resolve?: MigrationDnsResolver;
}): Promise<string> => {
	let url: URL;
	try {
		url = new URL(input.origin);
	} catch {
		throw new Error("Migration target must be a valid API origin");
	}
	if (
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"Migration target must be an origin without credentials, path, query, or fragment",
		);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Migration target must use HTTP or HTTPS");
	}
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const localRuntime =
		input.nodeEnv === "local" || input.nodeEnv === "development";
	const loopbackHost =
		hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
	if (!localRuntime && url.protocol !== "https:") {
		throw new Error(
			"Migration targets must use HTTPS outside local development",
		);
	}

	const addresses = isIP(hostname)
		? [hostname]
		: await (input.resolve ?? defaultResolver)(hostname);
	if (addresses.length === 0)
		throw new Error("Migration target host did not resolve");
	if (
		addresses.some(
			(address) =>
				isRestrictedMigrationAddress(address) &&
				!(input.allowPrivateNetworks && isPrivateMigrationAddress(address)),
		) &&
		!(localRuntime && loopbackHost)
	) {
		throw new Error(
			"Migration target resolves to a restricted network address",
		);
	}

	return url.origin;
};

const sensitiveKey =
	/passphrase|session.?token|email|payload|secret|credential/i;

export const redactMigrationLogValue = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(redactMigrationLogValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, child]) => [
			key,
			sensitiveKey.test(key) ? "[REDACTED]" : redactMigrationLogValue(child),
		]),
	);
};
