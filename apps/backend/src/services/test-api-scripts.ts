import {
	type ApiRequestScript,
	type ApiReviewFlag,
	type ApiScriptFix,
	apiRequestScriptSchema,
	apiReviewFlagSchema,
	applyApiScriptFixes,
} from "@jittle-lamp/shared";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod/v4";

import { testStepScripts } from "../db/schema";
import { HttpError } from "../http/test-http";
import { parseJsonColumn } from "./test-cases";
import type { TestRunRow } from "./test-runs";
import type { BackendDb } from "./user-provisioning";

// API scripts (roadmap 2026-10-13 §2.3 step 5): `test_step_scripts` rows of kind `api-requests`,
// one active row per step and environment, keyed `api:<stepId>` so they never collide with the
// e2e key hashes of UI scripts. Same stale and version rules as UI scripts.

export const API_SCRIPT_KIND = "api-requests" as const;

export const apiScriptKeyHash = (stepId: string) => `api:${stepId}`;

// A script belongs to the environment it was recorded in; scripts without one apply everywhere.
const environmentScope = (environmentId: string | null) =>
	environmentId
		? or(
				eq(testStepScripts.environmentId, environmentId),
				isNull(testStepScripts.environmentId),
			)
		: isNull(testStepScripts.environmentId);

export const parseApiScript = (
	row: Pick<typeof testStepScripts.$inferSelect, "requestsJson">,
): ApiRequestScript | null =>
	parseJsonColumn(row.requestsJson, apiRequestScriptSchema.nullable(), null);

export const parseReviewFlags = (
	row: Pick<typeof testStepScripts.$inferSelect, "reviewFlagsJson">,
): ApiReviewFlag[] =>
	parseJsonColumn(row.reviewFlagsJson, z.array(apiReviewFlagSchema), []);

export const findActiveApiScript = async (
	db: BackendDb,
	input: { testCaseId: string; stepId: string; environmentId: string | null },
) => {
	const rows = await db.query.testStepScripts.findMany({
		where: and(
			eq(testStepScripts.testCaseId, input.testCaseId),
			eq(testStepScripts.kind, API_SCRIPT_KIND),
			eq(testStepScripts.stepId, input.stepId),
			eq(testStepScripts.status, "active"),
			environmentScope(input.environmentId),
		),
		orderBy: desc(testStepScripts.version),
	});
	return (
		rows.find((row) => row.environmentId === input.environmentId) ??
		rows.find((row) => row.environmentId === null) ??
		null
	);
};

// Records a script for the run's step: the previous active one goes stale, the new row takes
// the next version.
export const writeApiScript = async (
	db: BackendDb,
	run: TestRunRow,
	script: ApiRequestScript,
	now = Date.now(),
) => {
	const keyHash = apiScriptKeyHash(script.stepId);
	const previous = await db.query.testStepScripts.findFirst({
		where: and(
			eq(testStepScripts.testCaseId, run.testCaseId),
			eq(testStepScripts.keyHash, keyHash),
		),
		orderBy: desc(testStepScripts.version),
		columns: { version: true },
	});
	await db
		.update(testStepScripts)
		.set({
			status: "stale",
			staleReason: `re-recorded on run ${run.id}`,
			updatedAt: now,
		})
		.where(
			and(
				eq(testStepScripts.testCaseId, run.testCaseId),
				eq(testStepScripts.keyHash, keyHash),
				eq(testStepScripts.status, "active"),
				environmentScope(run.environmentId),
			),
		);
	const [inserted] = await db
		.insert(testStepScripts)
		.values({
			orgId: run.orgId,
			testCaseId: run.testCaseId,
			stepId: script.stepId,
			stepIdsJson: JSON.stringify([script.stepId]),
			instructionKey: script.instructionKey,
			environmentId: run.environmentId,
			keyHash,
			entryJson: "null",
			version: (previous?.version ?? 0) + 1,
			kind: API_SCRIPT_KIND,
			requestsJson: JSON.stringify(script),
			reviewFlagsJson: JSON.stringify(script.reviewFlags),
			renderedCode: renderApiScript(script),
			recordedFromRunId: run.id,
			status: "active",
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: testStepScripts.id, version: testStepScripts.version });
	return inserted ?? null;
};

// A hand-off marks the step's active script stale unless this run recorded it (a fresh
// recording keeps its status, as updateStepScripts does for UI scripts).
export const staleApiScript = async (
	db: BackendDb,
	run: TestRunRow,
	stepId: string,
	reason: string,
	now = Date.now(),
) => {
	const script = await findActiveApiScript(db, {
		testCaseId: run.testCaseId,
		stepId,
		environmentId: run.environmentId,
	});
	if (!script || script.recordedFromRunId === run.id) return false;
	await db
		.update(testStepScripts)
		.set({ status: "stale", staleReason: reason, updatedAt: now })
		.where(eq(testStepScripts.id, script.id));
	return true;
};

// Reviewer fixes (roadmap §3.4): a flagged literal becomes a capture; the flag goes.
export const fixApiScript = async (
	db: BackendDb,
	input: {
		scriptId: string;
		testCaseId: string;
		fixes: readonly ApiScriptFix[];
	},
	now = Date.now(),
) => {
	const row = await db.query.testStepScripts.findFirst({
		where: and(
			eq(testStepScripts.id, input.scriptId),
			eq(testStepScripts.testCaseId, input.testCaseId),
		),
	});
	if (!row)
		throw new HttpError(404, "STEP_SCRIPT_NOT_FOUND", "Script not found");
	if (row.kind !== API_SCRIPT_KIND) {
		throw new HttpError(
			409,
			"STEP_SCRIPT_NOT_API",
			"Only API scripts carry review flags",
		);
	}
	const script = parseApiScript(row);
	if (!script) {
		throw new HttpError(
			409,
			"STEP_SCRIPT_INVALID",
			"The script could not be read",
		);
	}
	let fixed: ApiRequestScript;
	try {
		fixed = applyApiScriptFixes(script, input.fixes);
	} catch (error) {
		throw new HttpError(
			422,
			"STEP_SCRIPT_FIX_INVALID",
			error instanceof Error ? error.message : "Invalid fix",
		);
	}
	const [updated] = await db
		.update(testStepScripts)
		.set({
			requestsJson: JSON.stringify(fixed),
			reviewFlagsJson: JSON.stringify(fixed.reviewFlags),
			renderedCode: renderApiScript(fixed),
			updatedAt: now,
		})
		.where(eq(testStepScripts.id, row.id))
		.returning();
	if (!updated) throw new Error("Script disappeared during the fix");
	return updated;
};

// One line per request, for the Scripts drawer and exports.
export const renderApiScript = (script: ApiRequestScript): string =>
	script.requests
		.map((request) => {
			const query = Object.entries(request.query)
				.map(([name, value]) => `${name}=${value}`)
				.join("&");
			const flag = request.mutation ? "" : " (read)";
			return `${request.method} ${request.pathTemplate}${query ? `?${query}` : ""}${flag}`;
		})
		.join("\n");
