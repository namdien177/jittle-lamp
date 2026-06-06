import { createHmac, randomBytes } from "node:crypto";
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";

import type { RuntimeConfig } from "../config/runtime";
import {
	createDesktopAuthFlowInputSchema,
	desktopAuthFlows,
	deviceSessions,
} from "../db/schema";
import type { BackendDb } from "./user-provisioning";

export const desktopAuthIssuer = "jittle-lamp-api";
export const desktopAuthAudience = "jittle-lamp-desktop";
export const extensionAuthAudience = "jittle-lamp-extension";
export const desktopAuthPollIntervalSeconds = 5;
export const desktopAuthFlowTtlMs = 10 * 60 * 1000;
export const desktopAuthTokenTtlSeconds = 8 * 60 * 60;
export const extensionAuthTokenTtlSeconds = 30 * 24 * 60 * 60;
export const extensionAuthRefreshTokenTtlMs = 180 * 24 * 60 * 60 * 1000;

export type DeviceAuthClient = "desktop" | "extension";

/**
 * Capabilities granted to each device client. Clerk (human) sessions are
 * treated as fully privileged elsewhere; device tokens only carry the scopes
 * their client legitimately needs so a leaked long-lived token cannot perform
 * sensitive organization or destructive operations.
 */
export const deviceScopesByClient: Record<DeviceAuthClient, string[]> = {
	desktop: [
		"evidence:read",
		"evidence:write",
		"evidence:manage",
		"share:read",
		"share:write",
		"org:read",
		"org:manage",
	],
	extension: ["evidence:read", "evidence:write"],
};

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
			refreshToken?: string;
			refreshExpiresAt?: number;
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

const tokenTtlSecondsForClient = (client: DeviceAuthClient) =>
	client === "extension"
		? extensionAuthTokenTtlSeconds
		: desktopAuthTokenTtlSeconds;

const audienceForClient = (client: DeviceAuthClient) =>
	client === "extension" ? extensionAuthAudience : desktopAuthAudience;

const issueAccessTokenForSession = async (
	runtime: RuntimeConfig,
	input: {
		clerkUserId: string;
		client: DeviceAuthClient;
		sessionId: string;
		scope: string;
		ttlSeconds: number;
	},
) =>
	new SignJWT({
		token_type: `${input.client}_session`,
		scope: input.scope,
	})
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setIssuer(desktopAuthIssuer)
		.setAudience(audienceForClient(input.client))
		.setSubject(input.clerkUserId)
		.setJti(input.sessionId)
		.setIssuedAt()
		.setExpirationTime(`${input.ttlSeconds}s`)
		.sign(getTokenKey(runtime));

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

/**
 * Persists a revocable device session and mints a JWT whose `jti` references
 * that session row. Verification re-checks the row, so sessions can be expired
 * or revoked server-side rather than living until the JWT's own expiry.
 */
const issueDeviceSessionToken = async (
	db: BackendDb,
	runtime: RuntimeConfig,
	input: {
		clerkUserId: string;
		client: DeviceAuthClient;
		flowId: string;
	},
): Promise<{
	accessToken: string;
	refreshToken?: string;
	refreshExpiresAt?: number;
	expiresAt: number;
	expiresInSeconds: number;
}> => {
	const ttlSeconds = tokenTtlSecondsForClient(input.client);
	const now = Date.now();
	const expiresAt = now + ttlSeconds * 1000;
	const scope = deviceScopesByClient[input.client].join(" ");
	const refreshToken =
		input.client === "extension" ? createBase64UrlSecret(48) : undefined;
	const refreshExpiresAt = refreshToken
		? now + extensionAuthRefreshTokenTtlMs
		: undefined;

	const [session] = await db
		.insert(deviceSessions)
		.values({
			clerkUserId: input.clerkUserId,
			client: input.client,
			flowId: input.flowId,
			scope,
			...(refreshToken
				? {
						refreshTokenHash: hashSecret(runtime, refreshToken),
						refreshExpiresAt,
					}
				: {}),
			expiresAt,
			updatedAt: now,
		})
		.returning({ id: deviceSessions.id });

	if (!session) {
		throw new Error("Failed to persist device session");
	}

	const accessToken = await issueAccessTokenForSession(runtime, {
		clerkUserId: input.clerkUserId,
		client: input.client,
		sessionId: session.id,
		scope,
		ttlSeconds,
	});

	return {
		accessToken,
		...(refreshToken && refreshExpiresAt
			? { refreshToken, refreshExpiresAt }
			: {}),
		expiresAt,
		expiresInSeconds: ttlSeconds,
	};
};

export const refreshExtensionAuthSession = async (
	db: BackendDb,
	runtime: RuntimeConfig,
	refreshToken: string,
): Promise<
	| {
			ok: true;
			tokenType: "Bearer";
			accessToken: string;
			refreshToken: string;
			expiresAt: number;
			expiresInSeconds: number;
			refreshExpiresAt: number;
			clerkUserId: string;
	  }
	| { ok: false; reason: "invalid" | "expired" }
> => {
	const refreshTokenHash = hashSecret(runtime, refreshToken);
	const now = Date.now();
	const session = await db.query.deviceSessions.findFirst({
		where: eq(deviceSessions.refreshTokenHash, refreshTokenHash),
		columns: {
			id: true,
			clerkUserId: true,
			client: true,
			scope: true,
			refreshExpiresAt: true,
			revokedAt: true,
		},
	});

	if (
		!session ||
		session.client !== "extension" ||
		session.revokedAt !== null ||
		session.refreshExpiresAt === null
	) {
		return { ok: false, reason: "invalid" };
	}

	if (session.refreshExpiresAt <= now) {
		await db
			.update(deviceSessions)
			.set({ revokedAt: now, updatedAt: now })
			.where(eq(deviceSessions.id, session.id));
		return { ok: false, reason: "expired" };
	}

	const ttlSeconds = tokenTtlSecondsForClient("extension");
	const expiresAt = now + ttlSeconds * 1000;
	const nextRefreshToken = createBase64UrlSecret(48);
	const nextRefreshExpiresAt = now + extensionAuthRefreshTokenTtlMs;
	const [updated] = await db
		.update(deviceSessions)
		.set({
			refreshTokenHash: hashSecret(runtime, nextRefreshToken),
			refreshExpiresAt: nextRefreshExpiresAt,
			expiresAt,
			lastSeenAt: now,
			updatedAt: now,
		})
		.where(eq(deviceSessions.id, session.id))
		.returning({ id: deviceSessions.id });

	if (!updated) {
		return { ok: false, reason: "invalid" };
	}

	return {
		ok: true,
		tokenType: "Bearer",
		accessToken: await issueAccessTokenForSession(runtime, {
			clerkUserId: session.clerkUserId,
			client: "extension",
			sessionId: session.id,
			scope: session.scope,
			ttlSeconds,
		}),
		refreshToken: nextRefreshToken,
		expiresAt,
		expiresInSeconds: ttlSeconds,
		refreshExpiresAt: nextRefreshExpiresAt,
		clerkUserId: session.clerkUserId,
	};
};

export const verifyDesktopAuthSessionToken = async (
	runtime: RuntimeConfig,
	token: string,
	db: BackendDb | null,
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

	// When a database is available the session must still exist, belong to the
	// same user/client, and not be revoked or expired. This is what makes
	// device tokens revocable instead of valid until their JWT expiry.
	if (db) {
		const now = Date.now();
		const session = await db.query.deviceSessions.findFirst({
			where: eq(deviceSessions.id, sessionId),
			columns: {
				id: true,
				clerkUserId: true,
				client: true,
				scope: true,
				expiresAt: true,
				revokedAt: true,
			},
		});

		if (
			!session ||
			session.revokedAt !== null ||
			session.expiresAt <= now ||
			session.clerkUserId !== clerkUserId ||
			session.client !== client
		) {
			return null;
		}

		return {
			clerkUserId,
			sessionId,
			client,
			scope: session.scope,
		};
	}

	return {
		clerkUserId,
		sessionId,
		client,
		scope:
			typeof verified.payload.scope === "string" ? verified.payload.scope : "",
	};
};

/**
 * Removes device sessions that can no longer authenticate (expired or revoked)
 * and desktop auth flows past their short TTL, so neither table grows
 * unbounded. Verification already rejects these rows; this only reclaims space.
 */
export const cleanupExpiredDeviceAuthState = async (
	db: BackendDb,
	now = Date.now(),
): Promise<number> => {
	const removedSessions = await db
		.delete(deviceSessions)
		.where(
			or(
				lt(deviceSessions.expiresAt, now),
				isNotNull(deviceSessions.revokedAt),
			),
		)
		.returning({ id: deviceSessions.id });

	await db.delete(desktopAuthFlows).where(lt(desktopAuthFlows.expiresAt, now));

	return removedSessions.length;
};

export const revokeDeviceSession = async (
	db: BackendDb,
	sessionId: string,
): Promise<boolean> => {
	const now = Date.now();
	const [updated] = await db
		.update(deviceSessions)
		.set({ revokedAt: now, updatedAt: now })
		.where(
			and(eq(deviceSessions.id, sessionId), isNull(deviceSessions.revokedAt)),
		)
		.returning({ id: deviceSessions.id });
	return Boolean(updated);
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
		client,
		expiresAt,
	});

	await db.insert(desktopAuthFlows).values({
		deviceCodeHash: parsed.deviceCodeHash,
		userCodeHash: parsed.userCodeHash,
		client: parsed.client,
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
): Promise<PolledDesktopAuthFlow> => {
	const deviceCodeHash = hashSecret(runtime, deviceCode);
	const flow = await db.query.desktopAuthFlows.findFirst({
		where: eq(desktopAuthFlows.deviceCodeHash, deviceCodeHash),
		columns: {
			id: true,
			status: true,
			client: true,
			clerkUserId: true,
			expiresAt: true,
			completedAt: true,
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

	// The approved flow is single-use: once a token has been minted the device
	// code can no longer be exchanged, preventing minting multiple long-lived
	// tokens from one approval.
	if (flow.completedAt !== null) {
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

	// Consume the flow before issuing so a concurrent poll cannot also mint.
	const [consumed] = await db
		.update(desktopAuthFlows)
		.set({ completedAt: now, updatedAt: now })
		.where(
			and(
				eq(desktopAuthFlows.id, flow.id),
				isNull(desktopAuthFlows.completedAt),
			),
		)
		.returning({ id: desktopAuthFlows.id });

	if (!consumed) {
		return {
			status: "expired",
			expiresAt: flow.expiresAt,
			intervalSeconds: desktopAuthPollIntervalSeconds,
		};
	}

	const token = await issueDeviceSessionToken(db, runtime, {
		clerkUserId: flow.clerkUserId,
		client: flow.client,
		flowId: flow.id,
	});

	return {
		status: "approved",
		tokenType: "Bearer",
		accessToken: token.accessToken,
		...(token.refreshToken && token.refreshExpiresAt
			? {
					refreshToken: token.refreshToken,
					refreshExpiresAt: token.refreshExpiresAt,
				}
			: {}),
		expiresAt: token.expiresAt,
		expiresInSeconds: token.expiresInSeconds,
		clerkUserId: flow.clerkUserId,
	};
};
