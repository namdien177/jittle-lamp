import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { and, eq } from "drizzle-orm";

import { createDb } from "../src/db";
import {
	organizationMembers,
	organizationRoles,
	organizations,
} from "../src/db/schema";
import {
	allOrganizationPermissions,
	defaultRolePermissions,
	ensureDefaultOrganizationRoles,
	getOrganizationRolePermissions,
	parsePermissions,
} from "../src/services/organization-permissions";
import { createTestCasePolicy } from "../src/services/test-case-policy";
import { ensureUserAndPersonalOrganization } from "../src/services/user-provisioning";
import { applyMigrations } from "./test-utils";

const setup = async () => {
	const databaseUrl = `file:/tmp/jittle-lamp-tc-policy-${crypto.randomUUID()}.db`;
	await applyMigrations(databaseUrl);
	const db = createDb(databaseUrl);
	if (!db) throw new Error("Expected database");
	const [org] = await db
		.insert(organizations)
		.values({ name: "QA Org", isPersonal: false })
		.returning({ id: organizations.id });
	if (!org) throw new Error("Expected organization");
	await ensureDefaultOrganizationRoles(db, org.id);
	const member = async (role: string) => {
		const user = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: `user_policy_${role}_${crypto.randomUUID()}`,
			source: "clerk-callback",
			rawPayload: {},
		});
		await db
			.insert(organizationMembers)
			.values({ organizationId: org.id, userId: user.userId, role });
		return user.userId;
	};
	return { databaseUrl, db, orgId: org.id, member };
};

describe("test case permissions", () => {
	it("grants the design defaults per role", async () => {
		const { db, orgId, member } = await setup();
		const policy = createTestCasePolicy();
		const qa = await member("qa_engineer");
		const developer = await member("developer");
		const moderator = await member("moderator");
		const admin = await member("admin");
		const outsider = (
			await ensureUserAndPersonalOrganization(db, {
				clerkUserId: `user_policy_outsider_${crypto.randomUUID()}`,
				source: "clerk-callback",
				rawPayload: {},
			})
		).userId;
		const testPermissions = allOrganizationPermissions.filter((permission) =>
			/^test_/.test(permission),
		);
		const granted = async (userId: string): Promise<string[]> =>
			[...(await policy.permissions(db, { organizationId: orgId, userId }))]
				.filter((permission) => permission.startsWith("test_"))
				.sort();

		expect(await granted(qa)).toEqual(
			testPermissions
				.filter((permission) => permission !== "test_config.manage")
				.sort(),
		);
		expect(await granted(developer)).toEqual(
			[
				"test_case.view",
				"test_config.use",
				"test_run.create",
				"test_run.view",
			].sort(),
		);
		expect(await granted(moderator)).toEqual([...testPermissions].sort());
		expect(await granted(admin)).toEqual([...testPermissions].sort());
		expect(await granted(outsider)).toEqual([]);

		const ctx = (userId: string) => ({ organizationId: orgId, userId });
		expect(await policy.canCreateRuns(db, ctx(developer))).toBe(true);
		expect(await policy.canUpdateTestCases(db, ctx(developer))).toBe(false);
		expect(await policy.canApproveTestCases(db, ctx(qa))).toBe(true);
		expect(await policy.canManageConfig(db, ctx(qa))).toBe(false);
		expect(await policy.canManageConfig(db, ctx(moderator))).toBe(true);
		expect(await policy.canViewTestCases(db, ctx(outsider))).toBe(false);
	});

	it("lets the requester cancel and requires cancel_any for other runs", async () => {
		const { db, orgId, member } = await setup();
		const policy = createTestCasePolicy();
		const developer = await member("developer");
		const qa = await member("qa_engineer");
		const otherQa = await member("qa_engineer");
		const ctx = (userId: string) => ({ organizationId: orgId, userId });

		expect(await policy.canCancelRun(db, ctx(qa), { createdBy: qa })).toBe(
			true,
		);
		expect(await policy.canCancelRun(db, ctx(qa), { createdBy: otherQa })).toBe(
			true,
		);
		// Developers have neither cancel permission, even for their own run.
		expect(
			await policy.canCancelRun(db, ctx(developer), { createdBy: developer }),
		).toBe(false);

		await db
			.update(organizationRoles)
			.set({
				permissionsJson: JSON.stringify([
					...defaultRolePermissions.developer,
					"test_run.cancel",
				]),
			})
			.where(
				and(
					eq(organizationRoles.organizationId, orgId),
					eq(organizationRoles.key, "developer"),
				),
			);
		expect(
			await policy.canCancelRun(db, ctx(developer), { createdBy: developer }),
		).toBe(true);
		expect(
			await policy.canCancelRun(db, ctx(developer), { createdBy: qa }),
		).toBe(false);
	});

	it("backfills stored default roles of existing organisations", async () => {
		const { databaseUrl, db, orgId } = await setup();
		const legacy = {
			developer: [
				"evidence.view",
				"evidence.download",
				"evidence.comment",
				"evidence.create",
			],
			qa_engineer: ["evidence.view", "evidence.create", "evidence.update.own"],
			moderator: ["evidence.view", "activity.view"],
		};
		for (const [key, permissions] of Object.entries(legacy)) {
			await db
				.update(organizationRoles)
				.set({ permissionsJson: JSON.stringify(permissions) })
				.where(
					and(
						eq(organizationRoles.organizationId, orgId),
						eq(organizationRoles.key, key as "developer"),
					),
				);
		}

		const backfill = readFileSync(
			fileURLToPath(
				new URL(
					"../drizzle/0024_test_permissions_backfill.sql",
					import.meta.url,
				),
			),
			"utf8",
		);
		const client = createClient({ url: databaseUrl });
		for (const statement of backfill.split("--> statement-breakpoint")) {
			await client.execute(statement);
		}
		client.close();

		const developer = await getOrganizationRolePermissions(db, {
			organizationId: orgId,
			role: "developer",
		});
		expect([...developer].sort() as string[]).toEqual(
			[...legacy.developer, ...defaultRolePermissions.developer.slice(4)]
				.filter((value, index, all) => all.indexOf(value) === index)
				.sort(),
		);
		const qa = await getOrganizationRolePermissions(db, {
			organizationId: orgId,
			role: "qa_engineer",
		});
		// The customised evidence permissions stay; the test grants are added.
		expect(qa.has("evidence.delete.own")).toBe(false);
		expect(qa.has("evidence.update.own")).toBe(true);
		expect(qa.has("test_case.approve")).toBe(true);
		expect(qa.has("test_config.manage")).toBe(false);
		const moderator = await getOrganizationRolePermissions(db, {
			organizationId: orgId,
			role: "moderator",
		});
		expect(moderator.has("test_config.manage")).toBe(true);
	});

	it("tolerates unknown permissions in stored role JSON", () => {
		expect(
			parsePermissions(
				JSON.stringify(["evidence.view", "future.permission", "test_run.view"]),
			),
		).toEqual(["evidence.view", "test_run.view"]);
	});
});
