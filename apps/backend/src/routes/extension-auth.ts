import { Elysia, t } from "elysia";

import {
	apiErrorSchema,
	createApiError,
	createDbUnavailableError,
} from "../http/api-error";
import type { ClerkAuthPlugin } from "../plugins/clerk-auth";
import {
	approveDesktopAuthFlow,
	pollDesktopAuthFlow,
	refreshExtensionAuthSession,
	startDesktopAuthFlow,
} from "../services/desktop-auth";

const extensionAuthStartResponseSchema = t.Object({
	ok: t.Literal(true),
	deviceCode: t.String({ minLength: 1 }),
	userCode: t.String({ minLength: 1 }),
	verificationUri: t.String({ minLength: 1 }),
	verificationUriComplete: t.String({ minLength: 1 }),
	expiresAt: t.Number(),
	expiresInSeconds: t.Number(),
	intervalSeconds: t.Number(),
});

const extensionAuthPendingResponseSchema = t.Object({
	status: t.Union([
		t.Literal("pending"),
		t.Literal("expired"),
		t.Literal("denied"),
	]),
	expiresAt: t.Number(),
	intervalSeconds: t.Number(),
});

const extensionAuthApprovedResponseSchema = t.Object({
	status: t.Literal("approved"),
	tokenType: t.Literal("Bearer"),
	accessToken: t.String({ minLength: 1 }),
	refreshToken: t.Optional(t.String({ minLength: 1 })),
	refreshExpiresAt: t.Optional(t.Number()),
	expiresAt: t.Number(),
	expiresInSeconds: t.Number(),
	clerkUserId: t.String({ minLength: 1 }),
});

const extensionAuthRefreshResponseSchema = t.Object({
	ok: t.Literal(true),
	tokenType: t.Literal("Bearer"),
	accessToken: t.String({ minLength: 1 }),
	refreshToken: t.String({ minLength: 1 }),
	expiresAt: t.Number(),
	expiresInSeconds: t.Number(),
	refreshExpiresAt: t.Number(),
	clerkUserId: t.String({ minLength: 1 }),
});

const extensionAuthCompleteResponseSchema = t.Object({
	ok: t.Literal(true),
	status: t.Literal("approved"),
	expiresAt: t.Number(),
});

export const createExtensionAuthRoutes = (auth: ClerkAuthPlugin) =>
	new Elysia({ name: "extension-auth-routes" })
		.use(auth)
		.post(
			"/extension-auth/flows",
			async ({ db, requestId, runtime, set }) => {
				if (!db) {
					set.status = 503;
					return createDbUnavailableError(
						requestId,
						"DATABASE_URL is not configured. Cannot start extension authentication.",
					);
				}

				if (!runtime.secret) {
					set.status = 500;
					return createApiError(
						requestId,
						"EXTENSION_AUTH_MISCONFIGURED",
						"APP_SECRET is required for extension authentication",
						500,
					);
				}

				return {
					ok: true,
					...(await startDesktopAuthFlow(db, runtime, "extension")),
				};
			},
			{
				detail: {
					tags: ["extension-auth"],
					summary: "Starts an extension browser authentication flow",
				},
				response: {
					200: extensionAuthStartResponseSchema,
					500: apiErrorSchema,
					503: apiErrorSchema,
				},
			},
		)
		.get(
			"/extension-auth/flows/:deviceCode",
			async ({ db, params, requestId, runtime, set }) => {
				if (!db) {
					set.status = 503;
					return createDbUnavailableError(
						requestId,
						"DATABASE_URL is not configured. Cannot poll extension authentication.",
					);
				}

				if (!runtime.secret) {
					set.status = 500;
					return createApiError(
						requestId,
						"EXTENSION_AUTH_MISCONFIGURED",
						"APP_SECRET is required for extension authentication",
						500,
					);
				}

				return pollDesktopAuthFlow(db, runtime, params.deviceCode);
			},
			{
				params: t.Object({
					deviceCode: t.String({ minLength: 1 }),
				}),
				detail: {
					tags: ["extension-auth"],
					summary: "Polls a pending extension authentication flow",
				},
				response: {
					200: t.Union([
						extensionAuthPendingResponseSchema,
						extensionAuthApprovedResponseSchema,
					]),
					500: apiErrorSchema,
					503: apiErrorSchema,
				},
			},
		)
		.post(
			"/extension-auth/sessions/refresh",
			async ({ body, db, requestId, runtime, set }) => {
				if (!db) {
					set.status = 503;
					return createDbUnavailableError(
						requestId,
						"DATABASE_URL is not configured. Cannot refresh extension authentication.",
					);
				}

				if (!runtime.secret) {
					set.status = 500;
					return createApiError(
						requestId,
						"EXTENSION_AUTH_MISCONFIGURED",
						"APP_SECRET is required for extension authentication",
						500,
					);
				}

				const result = await refreshExtensionAuthSession(
					db,
					runtime,
					body.refreshToken,
				);

				if (!result.ok) {
					set.status = 401;
					return createApiError(
						requestId,
						"EXTENSION_AUTH_REFRESH_INVALID",
						result.reason === "expired"
							? "Extension refresh token expired"
							: "Extension refresh token is invalid",
						401,
					);
				}

				return result;
			},
			{
				body: t.Object({
					refreshToken: t.String({ minLength: 1 }),
				}),
				detail: {
					tags: ["extension-auth"],
					summary: "Refreshes an extension access token",
				},
				response: {
					200: extensionAuthRefreshResponseSchema,
					401: apiErrorSchema,
					500: apiErrorSchema,
					503: apiErrorSchema,
				},
			},
		)
		.guard({ auth: true }, (app) =>
			app.post(
				"/extension-auth/flows/complete",
				async ({ authContext, body, db, requestId, runtime, set }) => {
					if (!db) {
						set.status = 503;
						return createDbUnavailableError(
							requestId,
							"DATABASE_URL is not configured. Cannot complete extension authentication.",
						);
					}

					if (!runtime.secret) {
						set.status = 500;
						return createApiError(
							requestId,
							"EXTENSION_AUTH_MISCONFIGURED",
							"APP_SECRET is required for extension authentication",
							500,
						);
					}

					const result = await approveDesktopAuthFlow(db, runtime, {
						userCode: body.userCode,
						clerkUserId: authContext.userId,
					});

					if (!result.ok) {
						set.status = result.reason === "expired" ? 410 : 400;
						return createApiError(
							requestId,
							"EXTENSION_AUTH_FLOW_UNAVAILABLE",
							result.reason === "expired"
								? "Extension authentication request expired"
								: "Extension authentication request is no longer available",
							Number(set.status),
						);
					}

					return {
						ok: true,
						status: "approved" as const,
						expiresAt: result.expiresAt,
					};
				},
				{
					body: t.Object({
						userCode: t.String({ minLength: 1 }),
					}),
					detail: {
						tags: ["extension-auth"],
						summary:
							"Approves a pending extension authentication flow for the signed-in Clerk user",
					},
					response: {
						200: extensionAuthCompleteResponseSchema,
						400: apiErrorSchema,
						401: apiErrorSchema,
						410: apiErrorSchema,
						500: apiErrorSchema,
						503: apiErrorSchema,
					},
				},
			),
		);
