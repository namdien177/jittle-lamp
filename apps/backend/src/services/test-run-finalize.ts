import {
	addModelUsage,
	emptyModelUsage,
	type FinalizeTestRunRequest,
	priceRunReport,
	type RunReport,
} from "@jittle-lamp/shared";
import { and, eq, isNull } from "drizzle-orm";

import { evidences, testCaseEvidences, testRuns } from "../db/schema";
import { HttpError } from "../http/test-http";
import { releaseWorkerRun } from "./test-run-queue";
import {
	ACTIVE_RUN_STATUSES,
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

export const linkRunEvidence = async (
	db: BackendDb,
	run: TestRunRow,
	evidenceId: string,
) => {
	const evidence = await db.query.evidences.findFirst({
		where: and(
			eq(evidences.id, evidenceId),
			eq(evidences.orgId, run.orgId),
			isNull(evidences.deletedAt),
		),
		columns: { id: true },
	});
	if (!evidence) {
		throw new HttpError(
			422,
			"TEST_RUN_EVIDENCE_INVALID",
			"The evidence does not exist in this organisation",
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
		return { run, alreadyFinal: true };
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
			evidenceId: evidenceId ?? null,
			startedAt: run.startedAt ?? Date.parse(report.startedAt),
			finishedAt: now,
			currentStepId: null,
			workerLeaseOwner: null,
			workerLeaseExpiresAt: null,
			runTokenHash: null,
			runTokenExpiresAt: null,
			updatedAt: now,
		})
		.where(and(eq(testRuns.id, run.id), eq(testRuns.status, run.status)))
		.returning();
	if (!updated) {
		const current = await db.query.testRuns.findFirst({
			where: eq(testRuns.id, run.id),
		});
		if (!current) throw new Error("Run disappeared during finalisation");
		return { run: current, alreadyFinal: true };
	}
	await releaseWorkerRun(db, run.id, now);
	if (updated.batchId) await refreshBatch(db, updated.batchId, now);
	return { run: updated, alreadyFinal: false };
};
