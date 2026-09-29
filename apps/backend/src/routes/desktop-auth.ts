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
	startDesktopAuthFlow,
} from "../services/desktop-auth";

const desktopAuthStartResponseSchema = t.Object({
	ok: t.Literal(true),
	deviceCode: t.String({ minLength: 1 }),
	userCode: t.String({ minLength: 1 }),
	verificationUri: t.String({ minLength: 1 }),
	verificationUriComplete: t.String({ minLength: 1 }),
	expiresAt: t.Number(),
	expiresInSeconds: t.Number(),
	intervalSeconds: t.Number(),
});

const desktopAuthPendingResponseSchema = t.Object({
	status: t.Union([
		t.Literal("pending"),
		t.Literal("expired"),
		t.Literal("denied"),
	]),
	expiresAt: t.Number(),
	intervalSeconds: t.Number(),
});

const desktopAuthApprovedResponseSchema = t.Object({
	status: t.Literal("approved"),
	tokenType: t.Literal("Bearer"),
	accessToken: t.String({ minLength: 1 }),
	expiresAt: t.Number(),
	expiresInSeconds: t.Number(),
	clerkUserId: t.String({ minLength: 1 }),
});

const desktopAuthCompleteResponseSchema = t.Object({
	ok: t.Literal(true),
	status: t.Literal("approved"),
	expiresAt: t.Number(),
});

export const createDesktopAuthRoutes = (auth: ClerkAuthPlugin) =>
	new Elysia({ name: "desktop-auth-routes" })
		.use(auth)
		.post(
			"/desktop-auth/flows",
			{
				detail: {
					tags: ["desktop-auth"],
					summary: "Starts a desktop browser authentication flow",
				},
				response: {
					200: desktopAuthStartResponseSchema,
					500: apiErrorSchema,
					503: apiErrorSchema,
				},
			},
			async ({ db, requestId, runtime, set }) => {
				if (!db) {
					set.status = 503;
					return createDbUnavailableError(
						requestId,
						"DATABASE_URL is not configured. Cannot start desktop authentication.",
					);
				}

				if (!runtime.secret) {
					set.status = 500;
					return createApiError(
						requestId,
						"DESKTOP_AUTH_MISCONFIGURED",
						"APP_SECRET is required for desktop authentication",
						500,
					);
				}

				return {
					ok: true,
					...(await startDesktopAuthFlow(db, runtime)),
				};
			},
		)
		.get(
			"/desktop-auth/flows/:deviceCode",
			{
				params: t.Object({
					deviceCode: t.String({ minLength: 1 }),
				}),
				detail: {
					tags: ["desktop-auth"],
					summary: "Polls a pending desktop authentication flow",
				},
				response: {
					200: t.Union([
						desktopAuthPendingResponseSchema,
						desktopAuthApprovedResponseSchema,
					]),
					500: apiErrorSchema,
					503: apiErrorSchema,
				},
			},
			async ({ db, params, requestId, runtime, set }) => {
				if (!db) {
					set.status = 503;
					return createDbUnavailableError(
						requestId,
						"DATABASE_URL is not configured. Cannot poll desktop authentication.",
					);
				}

				if (!runtime.secret) {
					set.status = 500;
					return createApiError(
						requestId,
						"DESKTOP_AUTH_MISCONFIGURED",
						"APP_SECRET is required for desktop authentication",
						500,
					);
				}

				return pollDesktopAuthFlow(db, runtime, params.deviceCode);
			},
		)
		.guard({ auth: true }, (app) =>
			app.post(
				"/desktop-auth/flows/complete",
				{
					body: t.Object({
						userCode: t.String({ minLength: 1 }),
					}),
					detail: {
						tags: ["desktop-auth"],
						summary:
							"Approves a pending desktop authentication flow for the signed-in Clerk user",
					},
					response: {
						200: desktopAuthCompleteResponseSchema,
						400: apiErrorSchema,
						401: apiErrorSchema,
						410: apiErrorSchema,
						500: apiErrorSchema,
						503: apiErrorSchema,
					},
				},
				async ({ authContext, body, db, requestId, runtime, set }) => {
					if (!db) {
						set.status = 503;
						return createDbUnavailableError(
							requestId,
							"DATABASE_URL is not configured. Cannot complete desktop authentication.",
						);
					}

					if (!runtime.secret) {
						set.status = 500;
						return createApiError(
							requestId,
							"DESKTOP_AUTH_MISCONFIGURED",
							"APP_SECRET is required for desktop authentication",
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
							"DESKTOP_AUTH_FLOW_UNAVAILABLE",
							result.reason === "expired"
								? "Desktop authentication request expired"
								: "Desktop authentication request is no longer available",
							Number(set.status),
						);
					}

					return {
						ok: true,
						status: "approved" as const,
						expiresAt: result.expiresAt,
					};
				},
			),
		);
