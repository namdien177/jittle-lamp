import { createHmac, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";

import type { RuntimeConfig } from "../config/runtime";
import {
	createDesktopAuthFlowInputSchema,
	desktopAuthFlows,
} from "../db/schema";
import type { BackendDb } from "./user-provisioning";

export const desktopAuthIssuer = "jittle-lamp-api";
export const desktopAuthAudience = "jittle-lamp-desktop";
export const extensionAuthAudience = "jittle-lamp-extension";
export const desktopAuthPollIntervalSeconds = 5;
export const desktopAuthFlowTtlMs = 10 * 60 * 1000;
export const desktopAuthTokenTtlSeconds = 8 * 60 * 60;
export const extensionAuthTokenTtlSeconds = 30 * 24 * 60 * 60;

export type DeviceAuthClient = "desktop" | "extension";

const userCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type StartedDesktopAuthFlow = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresAt: number;
	expiresInSeconds: number;
	intervalSeconds: number;
};

export type DesktopAuthSessionClaims = {
	clerkUserId: string;
	sessionId: string;
	scope: string;
	client: DeviceAuthClient;
};

export type PolledDesktopAuthFlow =
	| {
			status: "pending" | "expired" | "denied";
			expiresAt: number;
			intervalSeconds: number;
	  }
	| {
			status: "approved";
			tokenType: "Bearer";
			accessToken: string;
			expiresAt: number;
			expiresInSeconds: number;
			clerkUserId: string;
	  };

const createBase64UrlSecret = (byteLength: number) =>
	randomBytes(byteLength).toString("base64url");

const createUserCode = () => {
	const random = randomBytes(8);
	return Array.from(random)
		.map((byte) => userCodeAlphabet[byte % userCodeAlphabet.length])
		.join("")
		.replace(/(.{4})/, "$1-");
};

const normalizeUserCode = (userCode: string) =>
	userCode
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");

const hashSecret = (runtime: RuntimeConfig, value: string) => {
	if (!runtime.secret) {
		throw new Error("APP_SECRET is required for desktop authentication");
	}

	return createHmac("sha256", runtime.secret).update(value).digest("hex");
};

const getTokenKey = (runtime: RuntimeConfig) => {
	if (!runtime.secret) {
		throw new Error("APP_SECRET is required for desktop authentication");
	}

	return new TextEncoder().encode(runtime.secret);
};

const getWebAppOrigin = (runtime: RuntimeConfig) =>
	(runtime.webAppOrigin ?? "http://127.0.0.1:4173").replace(/\/+$/, "");

const buildVerificationUris = (
	runtime: RuntimeConfig,
	userCode: string,
	client: DeviceAuthClient,
) => {
	const verificationUri = `${getWebAppOrigin(runtime)}/${client}-auth`;
	const verificationUrl = new URL(verificationUri);
	verificationUrl.searchParams.set("user_code", userCode);

	return {
		verificationUri,
		verificationUriComplete: verificationUrl.toString(),
	};
};

export const createDeviceAuthSessionToken = async (
	runtime: RuntimeConfig,
	input: {
		clerkUserId: string;
		sessionId: string;
		client: DeviceAuthClient;
	},
) =>
	new SignJWT({
		token_type: `${input.client}_session`,
		scope: input.client,
	})
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setIssuer(desktopAuthIssuer)
		.setAudience(
			input.client === "extension"
				? extensionAuthAudience
				: desktopAuthAudience,
		)
		.setSubject(input.clerkUserId)
		.setJti(input.sessionId)
		.setIssuedAt()
		.setExpirationTime(
			`${input.client === "extension" ? extensionAuthTokenTtlSeconds : desktopAuthTokenTtlSeconds}s`,
		)
		.sign(getTokenKey(runtime));

export const createDesktopAuthSessionToken = async (
	runtime: RuntimeConfig,
	input: {
		clerkUserId: string;
		sessionId: string;
	},
) =>
	createDeviceAuthSessionToken(runtime, {
		...input,
		client: "desktop",
	});

export const verifyDesktopAuthSessionToken = async (
	runtime: RuntimeConfig,
	token: string,
): Promise<DesktopAuthSessionClaims | null> => {
	if (!runtime.secret) {
		return null;
	}

	const verified = await jwtVerify(token, getTokenKey(runtime), {
		issuer: desktopAuthIssuer,
		audience: [desktopAuthAudience, extensionAuthAudience],
	});
	const clerkUserId = verified.payload.sub;
	const sessionId = verified.payload.jti;
	const client =
		verified.payload.token_type === "extension_session"
			? "extension"
			: verified.payload.token_type === "desktop_session"
				? "desktop"
				: null;

	if (
		typeof clerkUserId !== "string" ||
		typeof sessionId !== "string" ||
		!client
	) {
		return null;
	}

	return {
		clerkUserId,
		sessionId,
		client,
		scope:
			typeof verified.payload.scope === "string" ? verified.payload.scope : "",
	};
};

export const startDesktopAuthFlow = async (
	db: BackendDb,
	runtime: RuntimeConfig,
	client: DeviceAuthClient = "desktop",
): Promise<StartedDesktopAuthFlow> => {
	const deviceCode = createBase64UrlSecret(32);
	const userCode = createUserCode();
	const now = Date.now();
	const expiresAt = now + desktopAuthFlowTtlMs;
	const parsed = createDesktopAuthFlowInputSchema.parse({
		deviceCodeHash: hashSecret(runtime, deviceCode),
		userCodeHash: hashSecret(runtime, normalizeUserCode(userCode)),
		expiresAt,
	});

	await db.insert(desktopAuthFlows).values({
		deviceCodeHash: parsed.deviceCodeHash,
		userCodeHash: parsed.userCodeHash,
		expiresAt: parsed.expiresAt,
	});

	return {
		deviceCode,
		userCode,
		...buildVerificationUris(runtime, userCode, client),
		expiresAt,
		expiresInSeconds: Math.floor(desktopAuthFlowTtlMs / 1000),
		intervalSeconds: desktopAuthPollIntervalSeconds,
	};
};

export const approveDesktopAuthFlow = async (
	db: BackendDb,
	runtime: RuntimeConfig,
	input: {
		userCode: string;
		clerkUserId: string;
	},
) => {
	const userCodeHash = hashSecret(runtime, normalizeUserCode(input.userCode));
	const flow = await db.query.desktopAuthFlows.findFirst({
		where: eq(desktopAuthFlows.userCodeHash, userCodeHash),
		columns: {
			id: true,
			status: true,
			clerkUserId: true,
			expiresAt: true,
		},
	});

	if (!flow) {
		return { ok: false as const, reason: "not_found" as const };
	}

	const now = Date.now();
	if (flow.expiresAt <= now) {
		await db
			.update(desktopAuthFlows)
			.set({ status: "expired", updatedAt: now })
			.where(eq(desktopAuthFlows.id, flow.id));
		return { ok: false as const, reason: "expired" as const };
	}

	if (flow.status === "approved" && flow.clerkUserId === input.clerkUserId) {
		return { ok: true as const, flowId: flow.id, expiresAt: flow.expiresAt };
	}

	if (flow.status !== "pending") {
		return { ok: false as const, reason: flow.status };
	}

	await db
		.update(desktopAuthFlows)
		.set({
			status: "approved",
			clerkUserId: input.clerkUserId,
			approvedAt: now,
			updatedAt: now,
		})
		.where(eq(desktopAuthFlows.id, flow.id));

	return { ok: true as const, flowId: flow.id, expiresAt: flow.expiresAt };
};

export const pollDesktopAuthFlow = async (
	db: BackendDb,
	runtime: RuntimeConfig,
	deviceCode: string,
	client: DeviceAuthClient = "desktop",
): Promise<PolledDesktopAuthFlow> => {
	const deviceCodeHash = hashSecret(runtime, deviceCode);
	const flow = await db.query.desktopAuthFlows.findFirst({
		where: eq(desktopAuthFlows.deviceCodeHash, deviceCodeHash),
		columns: {
			id: true,
			status: true,
			clerkUserId: true,
			expiresAt: true,
		},
	});

	if (!flow) {
		return {
			status: "expired",
			expiresAt: Date.now(),
			intervalSeconds: desktopAuthPollIntervalSeconds,
		};
	}

	const now = Date.now();
	if (flow.expiresAt <= now) {
		if (flow.status !== "expired") {
			await db
				.update(desktopAuthFlows)
				.set({ status: "expired", updatedAt: now })
				.where(eq(desktopAuthFlows.id, flow.id));
		}

		return {
			status: "expired",
			expiresAt: flow.expiresAt,
			intervalSeconds: desktopAuthPollIntervalSeconds,
		};
	}

	if (flow.status !== "approved" || !flow.clerkUserId) {
		return {
			status: flow.status === "denied" ? "denied" : "pending",
			expiresAt: flow.expiresAt,
			intervalSeconds: desktopAuthPollIntervalSeconds,
		};
	}

	await db
		.update(desktopAuthFlows)
		.set({ completedAt: now, updatedAt: now })
		.where(eq(desktopAuthFlows.id, flow.id));

	return {
		status: "approved",
		tokenType: "Bearer",
		accessToken: await createDeviceAuthSessionToken(runtime, {
			clerkUserId: flow.clerkUserId,
			sessionId: flow.id,
			client,
		}),
		expiresAt:
			now +
			(client === "extension"
				? extensionAuthTokenTtlSeconds
				: desktopAuthTokenTtlSeconds) *
				1000,
		expiresInSeconds:
			client === "extension"
				? extensionAuthTokenTtlSeconds
				: desktopAuthTokenTtlSeconds,
		clerkUserId: flow.clerkUserId,
	};
};
