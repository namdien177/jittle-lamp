import { Elysia, t } from "elysia";

import {
	apiErrorSchema,
	createApiError,
	createDbUnavailableError,
} from "../http/api-error";
import type { ClerkAuthPlugin } from "../plugins/clerk-auth";
import { resolveClerkUserProfile } from "../services/clerk-user-profile";
import {
	ensureUserAndPersonalOrganization,
	retryFailedProvisioning,
} from "../services/user-provisioning";

const provisioningResultSchema = t.Object({
	eventId: t.Union([t.String({ minLength: 1 }), t.Null()]),
	userId: t.String({ minLength: 1 }),
	clerkUserId: t.String({ minLength: 1 }),
	organizationId: t.String({ minLength: 1 }),
	activeOrgId: t.String({ minLength: 1 }),
	membershipRole: t.Literal("owner"),
});

const provisioningResponseSchema = t.Object({
	ok: t.Literal(true),
	provisioned: provisioningResultSchema,
});

export const createClerkRoutes = (auth: ClerkAuthPlugin) =>
	new Elysia({ name: "clerk-routes" }).use(auth).guard({ auth: true }, (app) =>
		app
			.post(
				"/clerk/callback",
				async ({ authContext, db, requestId, requestLogger, runtime, set }) => {
					if (!db) {
						set.status = 503;
						return createApiError(
							requestId,
							"DB_NOT_CONFIGURED",
							"DATABASE_URL is not configured. Cannot provision user workspace.",
							503,
						);
					}

					const provisioned = await ensureUserAndPersonalOrganization(db, {
						clerkUserId: authContext.userId,
						source: "clerk-callback",
						userProfile: () =>
							resolveClerkUserProfile(runtime, authContext.userId).catch(
								(error) => {
									requestLogger.warn(
										{ err: error, clerkUserId: authContext.userId },
										"failed to resolve Clerk user profile during callback provisioning",
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

					return {
						ok: true,
						provisioned,
					};
				},
				{
					detail: {
						tags: ["clerk"],
						summary:
							"Ensures the authenticated Clerk user has a local user and personal organization",
					},
					response: {
						200: provisioningResponseSchema,
						401: apiErrorSchema,
						500: apiErrorSchema,
						503: apiErrorSchema,
					},
				},
			)
			.post(
				"/clerk/callback/retry/:eventId",
				async ({ authContext, db, params, requestId, set }) => {
					if (!db) {
						set.status = 503;
						return createDbUnavailableError(
							requestId,
							"DATABASE_URL is not configured. Cannot retry provisioning.",
						);
					}

					try {
						const provisioned = await retryFailedProvisioning(
							db,
							params.eventId,
							authContext.userId,
						);

						return { ok: true, provisioned };
					} catch (error) {
						set.status = 400;
						return createApiError(
							requestId,
							"PROVISIONING_RETRY_FAILED",
							error instanceof Error ? error.message : "Retry failed",
							400,
						);
					}
				},
				{
					params: t.Object({
						eventId: t.String({ minLength: 1 }),
					}),
					detail: {
						tags: ["clerk"],
						summary:
							"Replays a failed provisioning event for the authenticated Clerk user",
					},
					response: {
						200: provisioningResponseSchema,
						400: apiErrorSchema,
						401: apiErrorSchema,
						500: apiErrorSchema,
						503: apiErrorSchema,
					},
				},
			),
	);
