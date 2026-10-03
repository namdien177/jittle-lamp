import type { OrganizationPermission } from "../db/schema";
import {
	getOrganizationMembershipRole,
	getOrganizationRolePermissions,
} from "./organization-permissions";
import type { BackendDb } from "./user-provisioning";

// Organisation-level access for test cases, runs and test configuration (design.md §6, §9.3;
// ADR 0002 decision 15: no team scopes). Follows evidence-policy.ts.

export type TestAccessContext = {
	organizationId: string;
	userId: string;
};

export type TestPermission = Extract<
	OrganizationPermission,
	`test_case.${string}` | `test_run.${string}` | `test_config.${string}`
>;

export type TestRunOwnership = {
	createdBy: string | null;
};

const loadPermissions = async (
	db: BackendDb,
	context: TestAccessContext,
): Promise<Set<OrganizationPermission>> => {
	const role = await getOrganizationMembershipRole(db, {
		organizationId: context.organizationId,
		localUserId: context.userId,
	});
	if (!role) return new Set();
	return getOrganizationRolePermissions(db, {
		organizationId: context.organizationId,
		role,
	});
};

export const createTestCasePolicy = () => {
	const permissions = loadPermissions;

	const can = async (
		db: BackendDb,
		context: TestAccessContext,
		permission: TestPermission,
	): Promise<boolean> => (await permissions(db, context)).has(permission);

	return {
		permissions,
		can,
		canViewTestCases: (db: BackendDb, context: TestAccessContext) =>
			can(db, context, "test_case.view"),
		canCreateTestCases: (db: BackendDb, context: TestAccessContext) =>
			can(db, context, "test_case.create"),
		canUpdateTestCases: (db: BackendDb, context: TestAccessContext) =>
			can(db, context, "test_case.update"),
		canApproveTestCases: (db: BackendDb, context: TestAccessContext) =>
			can(db, context, "test_case.approve"),
		canDeleteTestCases: (db: BackendDb, context: TestAccessContext) =>
			can(db, context, "test_case.delete"),
		canViewRuns: (db: BackendDb, context: TestAccessContext) =>
			can(db, context, "test_run.view"),
		// Running a case uses the organisation's environments and credentials.
		canCreateRuns: async (db: BackendDb, context: TestAccessContext) => {
			const granted = await permissions(db, context);
			return granted.has("test_run.create") && granted.has("test_config.use");
		},
		// The requester may cancel with test_run.cancel; anyone else needs test_run.cancel_any.
		// Subscribers without either only unsubscribe (design.md §10.2).
		canCancelRun: async (
			db: BackendDb,
			context: TestAccessContext,
			run: TestRunOwnership,
		): Promise<boolean> => {
			const granted = await permissions(db, context);
			if (granted.has("test_run.cancel_any")) return true;
			return run.createdBy === context.userId && granted.has("test_run.cancel");
		},
		canManageConfig: (db: BackendDb, context: TestAccessContext) =>
			can(db, context, "test_config.manage"),
		canUseConfig: (db: BackendDb, context: TestAccessContext) =>
			can(db, context, "test_config.use"),
	};
};

export type TestCasePolicy = ReturnType<typeof createTestCasePolicy>;

export const testCasePolicy = createTestCasePolicy();
