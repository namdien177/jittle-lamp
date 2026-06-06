import { and, eq, sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import type * as appSchema from "../db/schema";
import {
	createOrganizationInputSchema,
	createOrganizationMembershipInputSchema,
	createProvisioningEventSchema,
	createUserInputSchema,
	organizationMembers,
	organizations,
	provisioningEvents,
	provisioningReplaySchema,
	users,
} from "../db/schema";
import {
	buildPersonalOrganizationName,
	type ClerkUserProfile,
} from "./clerk-user-profile";

export type BackendDb = LibSQLDatabase<typeof appSchema>;

type ProvisioningSource = "auth-middleware" | "clerk-callback";

type ProvisioningUserProfile = Pick<
	ClerkUserProfile,
	"firstName" | "username" | "email"
> | null;

type ProvisioningInput = {
	clerkUserId: string;
	source: ProvisioningSource;
	rawPayload: Record<string, unknown>;
	/**
	 * The Clerk profile, or a resolver invoked only when a new user is actually
	 * provisioned. Passing a resolver avoids a Clerk API round-trip on every
	 * request for already-provisioned users (the common hot path).
	 */
	userProfile?:
		| ProvisioningUserProfile
		| (() => Promise<ProvisioningUserProfile>);
};

const findAlreadyProvisioned = async (db: BackendDb, clerkUserId: string) =>
	db.query.users.findFirst({
		where: eq(users.clerkUserId, clerkUserId),
		with: {
			organizationMemberships: {
				with: {
					organization: {
						columns: { id: true, isPersonal: true },
					},
				},
				columns: { role: true, organizationId: true, teamId: true },
			},
		},
		columns: { id: true, clerkUserId: true, activeOrgId: true },
	});

const writeProvisioningEvent = async (
	db: BackendDb,
	input: ProvisioningInput,
	userProfile: ProvisioningUserProfile,
) => {
	const parsed = createProvisioningEventSchema.parse({
		clerkUserId: input.clerkUserId,
		source: input.source,
		rawPayload: JSON.stringify({
			...input.rawPayload,
			userProfile: userProfile ?? null,
		}),
	});

	const [created] = await db
		.insert(provisioningEvents)
		.values({
			clerkUserId: parsed.clerkUserId,
			source: parsed.source,
			rawPayload: parsed.rawPayload,
		})
		.returning({ id: provisioningEvents.id });

	if (!created) {
		throw new Error("Failed to persist provisioning event");
	}

	return created.id;
};

const parseProvisioningUserProfile = (
	rawPayload: string,
): Pick<ClerkUserProfile, "firstName" | "username" | "email"> | null => {
	const payload = JSON.parse(rawPayload) as { userProfile?: unknown };
	if (!payload.userProfile || typeof payload.userProfile !== "object") {
		return null;
	}

	const profile = payload.userProfile as Record<string, unknown>;
	return {
		firstName: typeof profile.firstName === "string" ? profile.firstName : null,
		username: typeof profile.username === "string" ? profile.username : null,
		email: typeof profile.email === "string" ? profile.email : null,
	};
};

export const processProvisioningEvent = async (
	db: BackendDb,
	eventId: string,
) => {
	const parsedReplay = provisioningReplaySchema.parse({ eventId });

	const event = await db.query.provisioningEvents.findFirst({
		where: eq(provisioningEvents.id, parsedReplay.eventId),
		columns: {
			id: true,
			clerkUserId: true,
			source: true,
			rawPayload: true,
			status: true,
			attemptCount: true,
			userId: true,
			normalizedPayload: true,
		},
	});
	if (!event) {
		throw new Error(`Provisioning event not found: ${parsedReplay.eventId}`);
	}

	if (event.status === "succeeded") {
		const normalized = event.normalizedPayload
			? (JSON.parse(event.normalizedPayload) as {
					organizationId?: string;
					activeOrgId?: string;
					membershipRole?: "owner";
				})
			: {};
		if (!event.userId || !normalized.organizationId) {
			throw new Error(
				`Provisioning event ${event.id} is succeeded but missing normalized data`,
			);
		}

		return {
			eventId: event.id,
			userId: event.userId,
			clerkUserId: event.clerkUserId,
			organizationId: normalized.organizationId,
			activeOrgId: normalized.activeOrgId ?? normalized.organizationId,
			membershipRole: normalized.membershipRole ?? "owner",
		};
	}

	await db
		.update(provisioningEvents)
		.set({
			status: "processing",
			attemptCount: event.attemptCount + 1,
			errorMessage: null,
			updatedAt: Date.now(),
		})
		.where(eq(provisioningEvents.id, event.id));

	try {
		const parsedUser = createUserInputSchema.parse({
			clerkUserId: event.clerkUserId,
		});

		const result = await db.transaction(async (tx) => {
			await tx
				.insert(users)
				.values({
					clerkUserId: parsedUser.clerkUserId,
				})
				.onConflictDoNothing({ target: users.clerkUserId });

			const localUser = await tx.query.users.findFirst({
				where: eq(users.clerkUserId, parsedUser.clerkUserId),
				columns: { id: true, clerkUserId: true },
			});

			if (!localUser) {
				throw new Error("Failed to load user after upsert");
			}

			const existingPersonalOrg = await tx.query.organizations.findFirst({
				where: eq(organizations.personalOwnerUserId, localUser.id),
				columns: { id: true },
			});

			let organizationId = existingPersonalOrg?.id ?? null;

			if (!organizationId) {
				const personalOrg = createOrganizationInputSchema.parse({
					name: buildPersonalOrganizationName(
						parseProvisioningUserProfile(event.rawPayload),
					),
					isPersonal: true,
					personalOwnerUserId: localUser.id,
				});

				const [createdOrganization] = await tx
					.insert(organizations)
					.values(personalOrg)
					.onConflictDoNothing()
					.returning({ id: organizations.id });

				organizationId = createdOrganization?.id ?? null;

				if (!organizationId) {
					const existingOrganization = await tx.query.organizations.findFirst({
						where: eq(organizations.personalOwnerUserId, localUser.id),
						columns: { id: true },
					});

					if (!existingOrganization) {
						throw new Error("Failed to create personal organization");
					}

					organizationId = existingOrganization.id;
				}
			}

			const membership = createOrganizationMembershipInputSchema.parse({
				organizationId,
				userId: localUser.id,
				role: "owner",
			});

			await tx
				.insert(organizationMembers)
				.values(membership)
				.onConflictDoNothing();

			const [updatedUser] = await tx
				.update(users)
				.set({
					activeOrgId: sql`coalesce(
                    ${users.activeOrgId},
                    ${organizationId}
                    )`,
					updatedAt: Date.now(),
				})
				.where(eq(users.id, localUser.id))
				.returning({ activeOrgId: users.activeOrgId });

			if (!updatedUser?.activeOrgId) {
				throw new Error(
					"Failed to resolve active organization after provisioning",
				);
			}

			return {
				userId: localUser.id,
				clerkUserId: localUser.clerkUserId,
				organizationId,
				activeOrgId: updatedUser.activeOrgId,
				membershipRole: "owner" as const,
			};
		});

		await db
			.update(provisioningEvents)
			.set({
				userId: result.userId,
				status: "succeeded",
				normalizedPayload: JSON.stringify({
					userId: result.userId,
					organizationId: result.organizationId,
					activeOrgId: result.activeOrgId,
					membershipRole: result.membershipRole,
				}),
				processedAt: Date.now(),
				updatedAt: Date.now(),
			})
			.where(eq(provisioningEvents.id, event.id));

		return { eventId: event.id, ...result };
	} catch (error) {
		await db
			.update(provisioningEvents)
			.set({
				status: "failed",
				errorMessage: error instanceof Error ? error.message : "Unknown error",
				updatedAt: Date.now(),
			})
			.where(eq(provisioningEvents.id, event.id));

		throw error;
	}
};

export const ensureUserAndPersonalOrganization = async (
	db: BackendDb,
	input: ProvisioningInput,
) => {
	const existing = await findAlreadyProvisioned(db, input.clerkUserId);
	if (existing) {
		const personalMembership = existing.organizationMemberships.find(
			(membership) =>
				membership.organization.isPersonal && membership.role === "owner",
		);

		if (personalMembership) {
			const persistedActiveOrgId = existing.activeOrgId;
			const hasPersistedOrgScopeMembership =
				persistedActiveOrgId !== null &&
				existing.organizationMemberships.some(
					(membership) =>
						membership.organizationId === persistedActiveOrgId &&
						membership.teamId === null,
				);
			return {
				eventId: null,
				userId: existing.id,
				clerkUserId: existing.clerkUserId,
				organizationId: personalMembership.organizationId,
				activeOrgId: hasPersistedOrgScopeMembership
					? persistedActiveOrgId
					: personalMembership.organizationId,
				membershipRole: "owner" as const,
			};
		}
	}

	const resolvedProfile =
		typeof input.userProfile === "function"
			? await input.userProfile()
			: (input.userProfile ?? null);
	const eventId = await writeProvisioningEvent(db, input, resolvedProfile);
	return processProvisioningEvent(db, eventId);
};

export const retryFailedProvisioning = async (
	db: BackendDb,
	eventId: string,
	clerkUserId: string,
) => {
	const result = await db
		.select({
			id: provisioningEvents.id,
			status: provisioningEvents.status,
		})
		.from(provisioningEvents)
		.where(
			and(
				eq(provisioningEvents.id, eventId),
				eq(provisioningEvents.status, "failed"),
				eq(provisioningEvents.clerkUserId, clerkUserId),
			),
		);

	if (result.length === 0) {
		throw new Error(`No failed provisioning event found for ${eventId}`);
	}

	return processProvisioningEvent(db, eventId);
};

export const listProvisioningEvents = (db: BackendDb, clerkUserId: string) =>
	db
		.select({
			id: provisioningEvents.id,
			status: provisioningEvents.status,
			attemptCount: provisioningEvents.attemptCount,
			source: provisioningEvents.source,
			createdAt: provisioningEvents.createdAt,
			processedAt: provisioningEvents.processedAt,
		})
		.from(provisioningEvents)
		.where(eq(provisioningEvents.clerkUserId, clerkUserId))
		.orderBy(sql`${provisioningEvents.id}
        desc`);
