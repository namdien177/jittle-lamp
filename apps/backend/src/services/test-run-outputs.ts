import type { RecentOutputsResponse } from "@jittle-lamp/shared";
import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import { z } from "zod/v4";

import { testRunSteps, testRuns } from "../db/schema";
import { parseJsonColumn } from "./test-cases";
import type { BackendDb } from "./user-provisioning";

// Run outputs (roadmap 2026-10-13 §2.6): the variables a run produced, merged over its steps in
// step order, and the reuse-window lookup a [Use] block makes before it runs.

const outputsSchema = z.record(z.string(), z.string());

export const runOutputs = async (
	db: BackendDb,
	runId: string,
): Promise<Record<string, string>> => {
	const rows = await db.query.testRunSteps.findMany({
		where: eq(testRunSteps.runId, runId),
		orderBy: asc(testRunSteps.ordinal),
		columns: { stepId: true, outputsJson: true },
	});
	const merged: Record<string, string> = {};
	// Steps sort by ordinal then id so a later step's value wins over an earlier one's.
	for (const row of rows.sort((a, b) =>
		a.stepId.localeCompare(b.stepId, undefined, { numeric: true }),
	)) {
		if (!row.outputsJson) continue;
		Object.assign(merged, parseJsonColumn(row.outputsJson, outputsSchema, {}));
	}
	return merged;
};

// The newest passed run of the case, same environment and params, finished inside the window.
// Blocked and failed runs never stand in: their data may not exist.
export const recentCaseOutputs = async (
	db: BackendDb,
	input: {
		orgId: string;
		testCaseId: string;
		environmentId: string | null;
		paramsHash: string;
		withinMs: number;
		now?: number;
	},
): Promise<RecentOutputsResponse> => {
	const now = input.now ?? Date.now();
	const run = await db.query.testRuns.findFirst({
		where: and(
			eq(testRuns.orgId, input.orgId),
			eq(testRuns.testCaseId, input.testCaseId),
			input.environmentId
				? eq(testRuns.environmentId, input.environmentId)
				: isNull(testRuns.environmentId),
			eq(testRuns.paramsHash, input.paramsHash),
			eq(testRuns.status, "completed"),
			eq(testRuns.outcome, "passed"),
			gte(testRuns.finishedAt, now - input.withinMs),
		),
		orderBy: desc(testRuns.finishedAt),
		columns: { id: true, finishedAt: true },
	});
	if (!run) return { runId: null, finishedAt: null, outputs: {} };
	return {
		runId: run.id,
		finishedAt: run.finishedAt,
		outputs: await runOutputs(db, run.id),
	};
};
