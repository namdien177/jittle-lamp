import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";

import { createDb } from "../src/db";
import {
	createEvidenceInputSchema,
	createOrganizationMembershipInputSchema,
	createShareLinkInputSchema,
	organizationMembers,
	organizations,
	users,
} from "../src/db/schema";
import {
	createEvidencePolicy,
	type EvidencePolicyDeps,
} from "../src/services/evidence-policy";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

const applyMigrations = async (databaseUrl: string) => {
	const db = createDb(databaseUrl);
	if (!db) {
		throw new Error("Database was not created");
	}

	await migrate(db, { migrationsFolder });
};

// @ts-expect-error partial team policy adapters must implement all team actions
const invalidTeamPolicyAdapter: NonNullable<
	EvidencePolicyDeps["teamPolicyAdapter"]
> = {
	canViewEvidence: async () => true,
};

void invalidTeamPolicyAdapter;

type TeamMovePolicyContext = {
	organizationId: string;
	teamId: string;
	userId: string;
	sourceOrganizationId: string;
	targetOrganizationId: string;
	isEvidenceCreator: boolean;
	isSourceOrganizationCreator: boolean;
};

const createTestDatabase = async () => {
	const databaseUrl = `file:/tmp/jittle-lamp-policy-${crypto.randomUUID()}.db`;
	await applyMigrations(databaseUrl);

	const db = createDb(databaseUrl);
	if (!db) {
		throw new Error("Database was not created");
	}

	return db;
};

const createUser = async (
	db: NonNullable<ReturnType<typeof createDb>>,
	clerkUserId = `user_${crypto.randomUUID()}`,
) => {
	const [user] = await db
		.insert(users)
		.values({ clerkUserId })
		.returning({ id: users.id });

	if (!user) {
		throw new Error("Failed to create user");
	}

	return user;
};

const createOrganization = async (
	db: NonNullable<ReturnType<typeof createDb>>,
	name = `Org ${crypto.randomUUID()}`,
) => {
	const [organization] = await db
		.insert(organizations)
		.values({ name, isPersonal: false })
		.returning({ id: organizations.id });

	if (!organization) {
		throw new Error("Failed to create organization");
	}

	return organization;
};

describe("schema extensibility", () => {
	it("accepts nullable team and scope identifiers in create schemas", () => {
		expect(() =>
			createOrganizationMembershipInputSchema.parse({
				organizationId: crypto.randomUUID(),
				userId: crypto.randomUUID(),
				teamId: null,
				role: "member",
			}),
		).not.toThrow();

		expect(() =>
			createEvidenceInputSchema.parse({
				orgId: crypto.randomUUID(),
				createdBy: crypto.randomUUID(),
				title: "Evidence",
				sourceType: "browser",
				teamId: null,
				scopeId: null,
			}),
		).not.toThrow();

		expect(() =>
			createShareLinkInputSchema.parse({
				tokenHash: "a".repeat(32),
				evidenceId: crypto.randomUUID(),
				orgId: crypto.randomUUID(),
				teamId: null,
				scopeId: null,
				expiresAt: Date.now() + 60_000,
				createdBy: crypto.randomUUID(),
			}),
		).not.toThrow();
	});

	it("allows multiple team memberships while preserving a single org-wide membership", async () => {
		const db = await createTestDatabase();
		const user = await createUser(db);
		const organization = await createOrganization(db);
		const teamA = crypto.randomUUID();
		const teamB = crypto.randomUUID();

		await db.insert(organizationMembers).values({
			organizationId: organization.id,
			userId: user.id,
			role: "member",
		});
		await db.insert(organizationMembers).values({
			organizationId: organization.id,
			userId: user.id,
			teamId: teamA,
			role: "member",
		});
		await db.insert(organizationMembers).values({
			organizationId: organization.id,
			userId: user.id,
			teamId: teamB,
			role: "member",
		});

		await expect(
			db
				.insert(organizationMembers)
				.values({
					organizationId: organization.id,
					userId: user.id,
					role: "member",
				})
				.execute(),
		).rejects.toThrow();
		await expect(
			db
				.insert(organizationMembers)
				.values({
					organizationId: organization.id,
					userId: user.id,
					teamId: teamA,
					role: "member",
				})
				.execute(),
		).rejects.toThrow();

		const memberships = await db.query.organizationMembers.findMany({
			where: and(
				eq(organizationMembers.organizationId, organization.id),
				eq(organizationMembers.userId, user.id),
			),
			columns: { teamId: true },
		});

		expect(memberships).toHaveLength(3);
		const membershipTeamIds = memberships
			.map((membership) => membership.teamId)
			.sort((left, right) => {
				if (left === null) {
					return -1;
				}
				if (right === null) {
					return 1;
				}
				return left.localeCompare(right);
			});

		const expectedTeamIds = [null, teamA, teamB].sort((left, right) => {
			if (left === null) {
				return -1;
			}
			if (right === null) {
				return 1;
			}
			return left.localeCompare(right);
		});

		expect(membershipTeamIds).toEqual(expectedTeamIds);
	});
});

describe("team policy extensibility", () => {
	it("does not treat team-only memberships as organization membership", async () => {
		const db = await createTestDatabase();
		const user = await createUser(db);
		const organization = await createOrganization(db);
		const teamId = crypto.randomUUID();
		const evidencePolicy = createEvidencePolicy({
			teamPolicyAdapter: {
				canViewEvidence: async () => true,
				canShareEvidence: async () => true,
				canMoveEvidence: async () => true,
			},
		});

		await db.insert(organizationMembers).values({
			organizationId: organization.id,
			userId: user.id,
			teamId,
			role: "member",
		});

		const canView = await evidencePolicy.canViewEvidence(db, {
			organizationId: organization.id,
			teamId,
			userId: user.id,
		});

		expect(canView).toBeFalse();
	});

	it("passes full move context to the team move policy adapter", async () => {
		const db = await createTestDatabase();
		const user = await createUser(db);
		const sourceOrganization = await createOrganization(db, "Source");
		const targetOrganization = await createOrganization(db, "Target");
		const teamId = crypto.randomUUID();
		const seenContexts: TeamMovePolicyContext[] = [];

		await db.insert(organizationMembers).values([
			{
				organizationId: sourceOrganization.id,
				userId: user.id,
				role: "admin",
			},
			{
				organizationId: targetOrganization.id,
				userId: user.id,
				role: "qa_engineer",
			},
		]);

		const evidencePolicy = createEvidencePolicy({
			teamPolicyAdapter: {
				canViewEvidence: async () => true,
				canShareEvidence: async () => true,
				canMoveEvidence: async (context) => {
					seenContexts.push(context);
					return true;
				},
			},
		});

		const canMove = await evidencePolicy.canMoveEvidence(db, {
			organizationId: sourceOrganization.id,
			teamId,
			userId: user.id,
			sourceOrganizationId: sourceOrganization.id,
			targetOrganizationId: targetOrganization.id,
			isEvidenceCreator: false,
			isSourceOrganizationCreator: false,
		});

		expect(canMove).toBeTrue();
		const seenContext = seenContexts[0];
		expect(seenContext).toBeDefined();
		if (!seenContext) {
			throw new Error("Expected move policy adapter to receive a context");
		}

		expect(seenContext.organizationId).toBe(sourceOrganization.id);
		expect(seenContext.teamId).toBe(teamId);
		expect(seenContext.userId).toBe(user.id);
		expect(seenContext.sourceOrganizationId).toBe(sourceOrganization.id);
		expect(seenContext.targetOrganizationId).toBe(targetOrganization.id);
		expect(seenContext.isEvidenceCreator).toBeFalse();
		expect(seenContext.isSourceOrganizationCreator).toBeFalse();
	});
});
