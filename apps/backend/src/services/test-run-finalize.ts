import {
	addModelUsage,
	emptyModelUsage,
	type FinalizeTestRunRequest,
	priceRunReport,
	type RunReport,
} from "@jittle-lamp/shared";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod/v4";

import {
	evidences,
	testCaseEvidences,
	testCases,
	testRunSteps,
	testRuns,
	testStepScripts,
} from "../db/schema";
import { HttpError } from "../http/test-http";
import { recordRunModelAccounts } from "./model-accounts";
import { emitRunOutcome } from "./notifications";
import { parseJsonColumn } from "./test-cases";
import { releaseWorkerRun } from "./test-run-queue";
import {
	ACTIVE_RUN_STATUSES,
	queueRepairRun,
	queueRetryRun,
	refreshBatch,
	type TestRunRow,
	upsertRunSteps,
} from "./test-runs";
import { resolvePriceTable } from "./test-settings";
import type { BackendDb } from "./user-provisioning";

// Run finalisation (design.md §3.1, §5.3; handover 1a.6): the runner posts its RunReport after
// uploading evidence. Metrics and cost land on the run, each step on test_run_steps.

export const PROVIDER_PRICE_TABLE = "provider";

const hasProviderCost = (report: RunReport) =>
	report.steps.some(
		(step) => step.usage.modelCalls > 0 && step.usage.costUsd !== null,
	) ||
	report.totals.usage.costUsd !== null ||
	report.totals.judgeUsage.costUsd !== null;

// Provider-reported cost wins and stamps price_table_version "provider"; otherwise tokens are
// priced from test_model_prices (organisation rows override global defaults).
export const priceReport = async (
	db: BackendDb,
	orgId: string,
	report: RunReport,
): Promise<{ report: RunReport; priceTableVersion: string | null }> => {
	if (hasProviderCost(report)) {
		return { report, priceTableVersion: PROVIDER_PRICE_TABLE };
	}
	const table = await resolvePriceTable(db, orgId);
	const priced = priceRunReport(report, table.prices, table.version, {
		act: report.model.act,
		judge: report.model.judge,
	});
	return { report: priced, priceTableVersion: priced.priceTableVersion };
};

export const runMetricsFromReport = (
	report: RunReport,
	priceTableVersion: string | null,
) => {
	const total = addModelUsage(
		report.totals.usage,
		report.totals.judgeUsage ?? emptyModelUsage(),
	);
	return {
		modelId: report.model.act,
		judgeModelId: report.model.judge,
		provider: report.model.provider,
		modelCalls: total.modelCalls,
		inputTokens: total.inputTokens,
		cachedInputTokens: total.cachedInputTokens,
		outputTokens: total.outputTokens,
		reasoningTokens: total.reasoningTokens,
		costUsd:
			total.costUsd === null ? null : Math.round(total.costUsd * 1e6) / 1e6,
		priceTableVersion,
		durationMs: Math.round(report.durationMs),
		stepsTotal: report.totals.stepsTotal,
		stepsReplayed: report.totals.stepsReplayed,
		stepsAgent: report.totals.stepsAgent,
		stepsHandoff: report.totals.stepsHandoff,
	};
};

// Evidence uploaded by a runner for a run: sourceType "test-run", sourceExternalId = run id.
export const TEST_RUN_SOURCE_TYPE = "test-run";

export const linkRunEvidence = async (
	db: BackendDb,
	run: TestRunRow,
	evidenceId: string,
) => {
	// Only the evidence this run uploaded (POST /test-runs/:id/evidence) can be attached: any
	// other evidence of the organisation would be relabelled as this run's recording.
	const evidence = await db.query.evidences.findFirst({
		where: and(
			eq(evidences.id, evidenceId),
			eq(evidences.orgId, run.orgId),
			eq(evidences.sourceType, TEST_RUN_SOURCE_TYPE),
			eq(evidences.sourceExternalId, run.id),
			isNull(evidences.deletedAt),
		),
		columns: { id: true },
	});
	if (!evidence) {
		throw new HttpError(
			422,
			"TEST_RUN_EVIDENCE_INVALID",
			"The evidence was not uploaded for this run",
		);
	}
	await db
		.insert(testCaseEvidences)
		.values({
			testCaseId: run.testCaseId,
			evidenceId,
			runId: run.id,
			relation: "run",
			createdBy: run.createdBy,
		})
		.onConflictDoNothing();
	return evidence.id;
};

export type FinalizeResult = {
	run: TestRunRow;
	alreadyFinal: boolean;
	// Set when a failed attempt was queued again under the case's retries.
	retry: TestRunRow | null;
	// Set when a strict run stopped on REPLAY_STALE and a read-write repair run was queued.
	repair: TestRunRow | null;
};

// Replayed steps verify their scripts; a hand-off means the cached script no longer matched, so
// scripts this run did not record are marked stale with the reason (design.md §5.2).
export const updateStepScripts = async (
	db: BackendDb,
	run: TestRunRow,
	report: RunReport,
	now = Date.now(),
) => {
	const scripts = await db.query.testStepScripts.findMany({
		where: and(
			eq(testStepScripts.testCaseId, run.testCaseId),
			eq(testStepScripts.status, "active"),
			or(
				isNull(testStepScripts.environmentId),
				run.environmentId
					? eq(testStepScripts.environmentId, run.environmentId)
					: isNull(testStepScripts.environmentId),
			),
		),
	});
	const forStep = (stepId: string) =>
		scripts.filter(
			(script) =>
				script.stepId === stepId ||
				parseJsonColumn(script.stepIdsJson, z.array(z.string()), []).includes(
					stepId,
				),
		);
	for (const step of report.steps) {
		// API scripts verify and stale on their own modes (roadmap §2.4); the UI rules below
		// never touch them.
		const apiScripts = forStep(step.stepId).filter(
			(script) => script.kind === "api-requests",
		);
		if (step.mode === "api-replayed" && step.status === "passed") {
			for (const script of apiScripts) {
				await db
					.update(testStepScripts)
					.set({
						verifiedCount: script.verifiedCount + 1,
						lastReplayedAt: now,
						updatedAt: now,
					})
					.where(eq(testStepScripts.id, script.id));
			}
		} else if (step.mode === "api-handoff") {
			await markStale(
				db,
				apiScripts,
				run,
				`API replay stopped (${step.cacheDetail ?? "hand-off"}); re-recorded on run ${run.id}`,
				now,
			);
		}
		const matching = forStep(step.stepId).filter(
			(script) => script.kind !== "api-requests",
		);
		if (matching.length === 0) continue;
		// `deterministic` covers an Assert replayed from its check (kind assert-check).
		if (
			(step.mode === "replayed" || step.mode === "deterministic") &&
			step.status === "passed"
		) {
			for (const script of matching) {
				await db
					.update(testStepScripts)
					.set({
						verifiedCount: script.verifiedCount + 1,
						lastReplayedAt: now,
						updatedAt: now,
					})
					.where(eq(testStepScripts.id, script.id));
			}
			const version = Math.max(...matching.map((script) => script.version));
			await db
				.update(testRunSteps)
				.set({ scriptVersion: version })
				.where(
					and(
						eq(testRunSteps.runId, run.id),
						eq(testRunSteps.stepId, step.stepId),
					),
				);
		} else if (step.mode === "handoff") {
			await markStale(
				db,
				matching,
				run,
				`replay stopped (${step.cacheReason ?? "hand-off"}); re-generated on run ${run.id}`,
				now,
			);
		} else if (step.mode === "agent" && rekeyedReasons.has(step.cacheReason)) {
			// The run looked the step up and found nothing under its key, yet an active script
			// exists for the step: e2e 0.17 re-keyed the cache (and 0.19 dropped the engine version
			// from the key), so the old entry is unreachable and re-records once.
			if (run.cacheMode === "off") continue;
			await markStale(
				db,
				matching,
				run,
				`re-keyed by e2e upgrade (${step.cacheReason}); re-generated on run ${run.id}`,
				now,
			);
		}
	}
};

const rekeyedReasons = new Set<RunReport["steps"][number]["cacheReason"]>([
	"invalid-entry",
	"no-entry",
]);

// Scripts this run did not record itself go stale with the reason; the run's own fresh
// recording keeps its status.
const markStale = async (
	db: BackendDb,
	matching: { id: string; recordedFromRunId: string | null }[],
	run: TestRunRow,
	staleReason: string,
	now: number,
) => {
	const stale = matching.filter(
		(script) => script.recordedFromRunId !== run.id,
	);
	if (stale.length === 0) return;
	await db
		.update(testStepScripts)
		.set({ status: "stale", staleReason, updatedAt: now })
		.where(
			inArray(
				testStepScripts.id,
				stale.map((script) => script.id),
			),
		);
};

export const finalizeRun = async (
	db: BackendDb,
	input: {
		run: TestRunRow;
		request: FinalizeTestRunRequest;
		now?: number;
	},
): Promise<FinalizeResult> => {
	const now = input.now ?? Date.now();
	const { run, request } = input;
	if (!(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) {
		return { run, alreadyFinal: true, retry: null, repair: null };
	}
	if (request.report.runId && request.report.runId !== run.id) {
		throw new HttpError(
			422,
			"TEST_RUN_REPORT_MISMATCH",
			"The report belongs to another run",
		);
	}
	const evidenceId = request.evidenceId
		? await linkRunEvidence(db, run, request.evidenceId)
		: run.evidenceId;
	const { report, priceTableVersion } = await priceReport(
		db,
		run.orgId,
		request.report,
	);
	await upsertRunSteps(db, run.id, report.steps, now);
	await recordRunModelAccounts(db, {
		orgId: run.orgId,
		runId: run.id,
		report: report.modelAccounts,
		finishedAt: now,
	});
	const cancelled = report.status === "cancelled";
	const [updated] = await db
		.update(testRuns)
		.set({
			...runMetricsFromReport(report, priceTableVersion),
			status: report.status,
			outcome: cancelled && run.cancelRequestedAt ? null : report.outcome,
			blockedReason: report.blockedReason,
			error:
				report.errors.length > 0
					? report.errors
							.map((error) => `${error.code}: ${error.message}`)
							.join("\n")
							.slice(0, 4000)
					: null,
			runnerInfoJson: JSON.stringify(report.runner),
			runner: report.runner.host,
			// Runs whose outputs stood in for [Use] blocks (roadmap §2.6).
			reusedFromRunIdsJson:
				report.reusedFromRunIds && report.reusedFromRunIds.length > 0
					? JSON.stringify(report.reusedFromRunIds)
					: null,
			evidenceId: evidenceId ?? null,
			startedAt: run.startedAt ?? Date.parse(report.startedAt),
			finishedAt: now,
			currentStepId: null,
			workerLeaseOwner: null,
			workerLeaseExpiresAt: null,
			runTokenHash: null,
			runTokenExpiresAt: null,
			// A finished run has no live view; any take-over ends with it.
			liveTakeoverBy: null,
			livePaused: false,
			takeoverRequestedAt: null,
			updatedAt: now,
		})
		.where(and(eq(testRuns.id, run.id), eq(testRuns.status, run.status)))
		.returning();
	if (!updated) {
		const current = await db.query.testRuns.findFirst({
			where: eq(testRuns.id, run.id),
		});
		if (!current) throw new Error("Run disappeared during finalisation");
		return { run: current, alreadyFinal: true, retry: null, repair: null };
	}
	await releaseWorkerRun(db, run.id, now);
	await updateStepScripts(db, updated, report, now);

	// Retries per case (design.md §14): a failed attempt is queued again while retries remain;
	// a later pass is outcome passed and flaky.
	let retry: TestRunRow | null = null;
	let final = updated;
	if (updated.status !== "cancelled" && updated.outcome === "failed") {
		const testCase = await db.query.testCases.findFirst({
			where: eq(testCases.id, run.testCaseId),
			columns: { retries: true, status: true, deletedAt: true },
		});
		if (
			testCase &&
			testCase.deletedAt === null &&
			testCase.status !== "archived" &&
			run.retryAttempt <= testCase.retries
		) {
			retry = await queueRetryRun(db, updated, now);
		}
	} else if (updated.outcome === "passed" && run.retryAttempt > 1) {
		const [flaky] = await db
			.update(testRuns)
			.set({ flaky: true, updatedAt: now })
			.where(eq(testRuns.id, run.id))
			.returning();
		if (flaky) final = flaky;
	}
	// Strict regression (roadmap 2026-10-13 §4.3): a stale script blocks the run with no model
	// call; one read-write repair run re-records it off the critical path.
	let repair: TestRunRow | null = null;
	if (
		updated.status !== "cancelled" &&
		updated.outcome === "blocked" &&
		updated.blockedReason === "REPLAY_STALE" &&
		run.cacheMode === "strict"
	) {
		repair = await queueRepairRun(db, updated, now);
	}
	// A retried attempt is not the verdict; subscribers hear about the final attempt.
	if (!retry) await emitRunOutcome(db, final);
	if (final.batchId) await refreshBatch(db, final.batchId, now);
	return { run: final, alreadyFinal: false, retry, repair };
};
