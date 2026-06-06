import { createClerkClient, verifyToken } from "@clerk/backend";
import { Elysia, status } from "elysia";
import type { RuntimeConfig } from "../config/runtime";
import { apiErrorSchema, createApiError } from "../http/api-error";
import { resolveActiveOrganizationForClerkUser } from "../services/active-organization";
import { resolveClerkUserProfile } from "../services/clerk-user-profile";
import { verifyDesktopAuthSessionToken } from "../services/desktop-auth";
import {
	type BackendDb,
	ensureUserAndPersonalOrganization,
} from "../services/user-provisioning";
import type { CorePlugin } from "./core";

export type SessionTokenType = "clerk" | "desktop" | "extension";

type ClerkSessionClaims = Record<string, unknown> & {
	scope?: string;
	roles?: unknown;
	org_id?: unknown;
};

type ClerkAuthObject = {
	userId: string | null;
	orgId?: string | null | undefined;
	sessionClaims?: ClerkSessionClaims | undefined;
};

export type AuthContext = {
	userId: string;
	localUserId: string | null;
	orgId: string | null;
	activeOrgId: string | null;
	roles: string[];
	scopes: string[];
	tokenType: SessionTokenType;
};

/**
 * Clerk (human) sessions are fully privileged; device tokens (desktop /
 * extension) only carry the scopes their client was granted, so this is how we
 * keep the long-lived extension token away from sensitive operations.
 */
export const sessionHasScope = (auth: AuthContext, scope: string): boolean =>
	auth.tokenType === "clerk" || auth.scopes.includes(scope);

export const requireSessionScope = (
	auth: AuthContext,
	scope: string,
	requestId: string,
	set: { status?: number | string },
): ReturnType<typeof createApiError> | null => {
	if (sessionHasScope(auth, scope)) {
		return null;
	}

	set.status = 403;
	return createApiError(
		requestId,
		"AUTH_INSUFFICIENT_SCOPE",
		`This session is not permitted to perform this action (requires '${scope}')`,
		403,
	);
};

const isDevelopmentRuntime = (runtime: RuntimeConfig) =>
	runtime.nodeEnv === "local" || runtime.nodeEnv === "development";

const readSessionToken = (request: Request) => {
	const authHeader = request.headers.get("authorization");
	if (authHeader?.startsWith("Bearer ")) {
		return authHeader.slice("Bearer ".length).trim();
	}

	const cookieHeader = request.headers.get("cookie");
	return cookieHeader
		?.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith("__session="))
		?.slice("__session=".length);
};

const parseScopes = (claims: ClerkSessionClaims | undefined) =>
	(typeof claims?.scope === "string" ? claims.scope : "")
		.split(" ")
		.map((scope) => scope.trim())
		.filter(Boolean);

const parseRoles = (claims: ClerkSessionClaims | undefined) =>
	Array.isArray(claims?.roles)
		? claims.roles.filter((role): role is string => typeof role === "string")
		: [];

const toAuthContext = (
	auth: ClerkAuthObject,
	tokenType: SessionTokenType,
	localUserId: string | null = null,
	activeOrgId: string | null = null,
): AuthContext => {
	if (!auth.userId) {
		throw new Error("Authenticated Clerk request did not include a userId");
	}

	return {
		userId: auth.userId,
		localUserId,
		orgId:
			typeof auth.orgId === "string"
				? auth.orgId
				: typeof auth.sessionClaims?.org_id === "string"
					? auth.sessionClaims.org_id
					: null,
		activeOrgId,
		roles: parseRoles(auth.sessionClaims),
		scopes: parseScopes(auth.sessionClaims),
		tokenType,
	};
};

const createAuthOnlyRequest = (request: Request) => {
	const headers = new Headers(request.headers);
	headers.delete("content-length");
	headers.delete("content-type");

	return new Request(request.url, {
		method: request.method,
		headers,
	});
};

// Clerk clients are reusable; cache one per (publishableKey, secretKey) pair so
// each authenticated request does not allocate a fresh client.
const clerkClientCache = new Map<
	string,
	ReturnType<typeof createClerkClient>
>();

const getClerkClient = (publishableKey: string, secretKey?: string) => {
	const cacheKey = `${publishableKey}::${secretKey ?? ""}`;
	const existing = clerkClientCache.get(cacheKey);
	if (existing) {
		return existing;
	}

	const client = createClerkClient(
		secretKey ? { publishableKey, secretKey } : { publishableKey },
	);
	clerkClientCache.set(cacheKey, client);
	return client;
};

const authenticateWithRequestState = async (
	request: Request,
	runtime: RuntimeConfig,
) => {
	if (!runtime.clerkPublishableKey) {
		return null;
	}

	const secretKey =
		runtime.clerkSecretKey ??
		(isDevelopmentRuntime(runtime) && runtime.clerkJwtKey
			? "sk_test_local_placeholder"
			: undefined);

	const clerkClient = getClerkClient(runtime.clerkPublishableKey, secretKey);
	const authenticateOptions: {
		audience?: string | string[];
		authorizedParties?: string[];
		jwtKey?: string;
	} = {};
	if (runtime.clerkJwtKey && !runtime.clerkSecretKey) {
		authenticateOptions.jwtKey = runtime.clerkJwtKey;
	}
	if (runtime.clerkAuthorizedParties) {
		authenticateOptions.authorizedParties = runtime.clerkAuthorizedParties;
	}
	if (runtime.clerkAudience) {
		authenticateOptions.audience = runtime.clerkAudience;
	}

	const requestState = await clerkClient.authenticateRequest(
		createAuthOnlyRequest(request),
		authenticateOptions,
	);
	const auth = requestState.toAuth() as ClerkAuthObject | null;

	return auth?.userId
		? toAuthContext(
				{
					userId: auth.userId,
					orgId: auth.orgId,
					sessionClaims: auth.sessionClaims,
				},
				"clerk",
			)
		: null;
};

const authenticateWithVerifyToken = async (
	request: Request,
	runtime: RuntimeConfig,
) => {
	const token = readSessionToken(request);

	if (!token) {
		return null;
	}

	const verifyOptions: {
		audience?: string | string[];
		authorizedParties?: string[];
		jwtKey?: string;
		secretKey?: string;
	} = {};
	if (runtime.clerkSecretKey) {
		verifyOptions.secretKey = runtime.clerkSecretKey;
	}
	if (runtime.clerkJwtKey && !runtime.clerkSecretKey) {
		verifyOptions.jwtKey = runtime.clerkJwtKey;
	}
	if (runtime.clerkAuthorizedParties) {
		verifyOptions.authorizedParties = runtime.clerkAuthorizedParties;
	}
	if (runtime.clerkAudience) {
		verifyOptions.audience = runtime.clerkAudience;
	}

	const claims = (await verifyToken(
		decodeURIComponent(token),
		verifyOptions,
	)) as ClerkSessionClaims;

	return toAuthContext(
		{
			userId: typeof claims.sub === "string" ? claims.sub : null,
			orgId: typeof claims.org_id === "string" ? claims.org_id : null,
			sessionClaims: claims,
		},
		"clerk",
	);
};

const authenticateWithDesktopSessionToken = async (
	request: Request,
	runtime: RuntimeConfig,
	db: BackendDb | null,
) => {
	const token = readSessionToken(request);
	if (!token) {
		return null;
	}

	const claims = await verifyDesktopAuthSessionToken(
		runtime,
		decodeURIComponent(token),
		db,
	);
	if (!claims) {
		return null;
	}

	return toAuthContext(
		{
			userId: claims.clerkUserId,
			sessionClaims: { scope: claims.scope },
		},
		claims.client,
	);
};

const authenticateRequest = async (
	request: Request,
	runtime: RuntimeConfig,
	db: BackendDb | null,
) => {
	try {
		const desktopAuth = await authenticateWithDesktopSessionToken(
			request,
			runtime,
			db,
		);
		if (desktopAuth) {
			return desktopAuth;
		}
	} catch {
		// Not a desktop session token; continue with Clerk verification.
	}

	if (runtime.clerkPublishableKey) {
		return authenticateWithRequestState(request, runtime);
	}

	return authenticateWithVerifyToken(request, runtime);
};

export const createClerkAuthPlugin = (core: CorePlugin) =>
	new Elysia({ name: "clerk-auth" }).use(core).macro({
		auth: {
			detail: {
				security: [{ clerkSession: [] }],
			},
			response: {
				401: apiErrorSchema,
				500: apiErrorSchema,
			},
			async resolve({ db, request, requestId, requestLogger, runtime }) {
				if (!readSessionToken(request)) {
					return status(
						401,
						createApiError(
							requestId,
							"AUTH_UNAUTHENTICATED",
							"Authentication required",
							401,
						),
					);
				}

				if (
					!runtime.clerkSecretKey &&
					!runtime.clerkJwtKey &&
					!runtime.secret
				) {
					return status(
						500,
						createApiError(
							requestId,
							"AUTH_MISCONFIGURED",
							"Backend auth configuration is missing",
							500,
						),
					);
				}

				let authContext: AuthContext | null;
				try {
					authContext = await authenticateRequest(request, runtime, db);
				} catch (error) {
					requestLogger.warn({ err: error }, "failed to authenticate request");
					return status(
						401,
						createApiError(
							requestId,
							"AUTH_INVALID_TOKEN",
							"Invalid or expired auth token",
							401,
						),
					);
				}

				if (!authContext) {
					return status(
						401,
						createApiError(
							requestId,
							"AUTH_UNAUTHENTICATED",
							"Authentication required",
							401,
						),
					);
				}

				try {
					if (!db) {
						return { authContext };
					}

					const provisioned = await ensureUserAndPersonalOrganization(db, {
						clerkUserId: authContext.userId,
						source: "auth-middleware",
						// Resolved lazily: only a brand-new user triggers the Clerk
						// profile lookup, so existing users avoid a per-request Clerk
						// API round-trip.
						userProfile: () =>
							resolveClerkUserProfile(runtime, authContext.userId).catch(
								(error) => {
									requestLogger.warn(
										{ err: error, clerkUserId: authContext.userId },
										"failed to resolve Clerk user profile during provisioning",
									);
									return null;
								},
							),
						rawPayload: {
							userId: authContext.userId,
							orgId: authContext.orgId,
							roles: authContext.roles,
							scopes: authContext.scopes,
						},
					});
					const activeOrganization =
						await resolveActiveOrganizationForClerkUser(db, authContext.userId);

					return {
						authContext: {
							...authContext,
							localUserId: provisioned.userId,
							activeOrgId:
								activeOrganization?.organizationId ??
								provisioned.organizationId,
						},
					};
				} catch (error) {
					requestLogger.error(
						{ err: error },
						"failed to provision authenticated Clerk user",
					);

					return status(
						500,
						createApiError(
							requestId,
							"AUTH_PROVISIONING_FAILED",
							"Failed to provision local user workspace",
							500,
						),
					);
				}
			},
		},
	});

export type ClerkAuthPlugin = ReturnType<typeof createClerkAuthPlugin>;
