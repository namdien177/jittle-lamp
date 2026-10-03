import { and, eq, gte, sql } from "drizzle-orm";

import { testRunSettings, testRuns } from "../db/schema";
import { withBusyRetry } from "./db-busy";
import type { BackendDb } from "./user-provisioning";

// Daily model budget (design.md §10.3): once the cost of an organisation's runs that finished
// today reaches its dailyBudgetUsd, newly requested runs are queued with blocked_reason
// BUDGET_EXCEEDED and no runner can claim them. They become claimable (blocked_reason null) when
// the budget day changes, or when an admin raises or removes the budget.
//
// Organisations have no time zone setting, so the budget day is the UTC calendar day.

export const BUDGET_EXCEEDED = "BUDGET_EXCEEDED";

export const budgetDayStart = (now: number): number => {
	const date = new Date(now);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

// Cost of the organisation's runs that finished since the start of the budget day.
export const modelSpendToday = async (
	db: BackendDb,
	orgId: string,
	now = Date.now(),
): Promise<number> => {
	const [row] = await db
		.select({ value: sql<number | null>`sum(${testRuns.costUsd})` })
		.from(testRuns)
		.where(
			and(
				eq(testRuns.orgId, orgId),
				gte(testRuns.finishedAt, budgetDayStart(now)),
			),
		);
	return Number(row?.value ?? 0);
};

export type DailyBudgetState = {
	budgetUsd: number | null;
	spentUsd: number;
	exceeded: boolean;
};

export const dailyBudgetState = async (
	db: BackendDb,
	orgId: string,
	budgetUsd: number | null,
	now = Date.now(),
): Promise<DailyBudgetState> => {
	if (budgetUsd === null) return { budgetUsd, spentUsd: 0, exceeded: false };
	const spentUsd = await modelSpendToday(db, orgId, now);
	return { budgetUsd, spentUsd, exceeded: spentUsd >= budgetUsd };
};

const storedBudget = async (
	db: BackendDb,
	orgId: string,
): Promise<number | null> =>
	(
		await db.query.testRunSettings.findFirst({
			where: eq(testRunSettings.orgId, orgId),
			columns: { dailyBudgetUsd: true },
		})
	)?.dailyBudgetUsd ?? null;

// Clears BUDGET_EXCEEDED from queued runs of organisations that are back under budget (a new
// day, a raised or removed budget). Returns the ids of the released runs.
export const releaseBudgetBlockedRuns = async (
	db: BackendDb,
	input: { now?: number; orgId?: string } = {},
): Promise<string[]> => {
	const now = input.now ?? Date.now();
	const blocked = and(
		eq(testRuns.status, "queued"),
		eq(testRuns.blockedReason, BUDGET_EXCEEDED),
	);
	const orgs = await db
		.selectDistinct({ orgId: testRuns.orgId })
		.from(testRuns)
		.where(
			input.orgId ? and(blocked, eq(testRuns.orgId, input.orgId)) : blocked,
		);
	const released: string[] = [];
	for (const { orgId } of orgs) {
		const state = await dailyBudgetState(
			db,
			orgId,
			await storedBudget(db, orgId),
			now,
		);
		if (state.exceeded) continue;
		const rows = await withBusyRetry(() =>
			db
				.update(testRuns)
				.set({ blockedReason: null, updatedAt: now })
				.where(and(blocked, eq(testRuns.orgId, orgId)))
				.returning({ id: testRuns.id }),
		);
		released.push(...rows.map((row) => row.id));
	}
	return released;
};
