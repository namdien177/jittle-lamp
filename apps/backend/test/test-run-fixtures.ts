import {
	type ClaimedRun,
	createSessionArchive,
	createSessionDraft,
	emptyModelUsage,
	type RunReport,
	recordingFileName,
	sessionArchiveFileName,
	type TestCaseDetail,
} from "@jittle-lamp/shared";
import { strToU8, zipSync } from "fflate";

import {
	loginTranscript,
	type Member,
	type TestCaseFixture,
} from "./test-case-fixtures";

export const runnerInfo = {
	runner: "jl-e2e-runner",
	runnerVersion: "1.8.2",
	engine: "e2e",
	engineVersion: "0.16.0",
	browser: "chromium",
	browserVersion: "140",
	headless: true,
	viewport: { width: 1440, height: 900 },
	cacheMode: "read-write" as const,
	host: "self-hosted" as const,
};

export const buildRunReport = (
	claimed: ClaimedRun,
	options: {
		outcome?: RunReport["outcome"];
		status?: RunReport["status"];
		providerCost?: number | null;
		modes?: Array<"agent" | "replayed" | "handoff" | null>;
	} = {},
): RunReport => {
	const started = new Date("2026-10-03T10:00:00.000Z");
	const steps = claimed.steps.map((step, index) => {
		const isAct = step.type === "act";
		const usage = isAct
			? {
					modelId: "anthropic/claude-opus-5-5",
					modelCalls: 2,
					inputTokens: 1000,
					cachedInputTokens: 500,
					outputTokens: 100,
					reasoningTokens: 50,
					costUsd: options.providerCost ?? null,
				}
			: step.type === "assert"
				? {
						modelId: "anthropic/claude-sonnet-5-5",
						modelCalls: 1,
						inputTokens: 400,
						cachedInputTokens: 0,
						outputTokens: 20,
						reasoningTokens: 0,
						costUsd: options.providerCost ?? null,
					}
				: emptyModelUsage();
		return {
			stepId: step.stepId,
			parentStepId: null,
			ordinal: step.ordinal,
			type: step.type,
			label: step.text,
			checkpointId: step.checkpointId,
			status: "passed" as const,
			mode: options.modes?.[index] ?? (isAct ? ("agent" as const) : null),
			cacheReason: isAct ? ("no-entry" as const) : null,
			startedAt: new Date(started.getTime() + index * 1000).toISOString(),
			finishedAt: new Date(
				started.getTime() + index * 1000 + 900,
			).toISOString(),
			durationMs: 900,
			videoOffsetMs: index * 1000,
			observed: isAct ? "done" : null,
			error: null,
			screenshot: null,
			actions: isAct ? 2 : 0,
			usage,
			visionInput: false,
		};
	});
	const act = steps.filter((step) => step.type === "act");
	const judge = steps.filter((step) => step.type === "assert");
	const sum = (list: typeof steps, modelId: string) =>
		list.reduce(
			(total, step) => ({
				modelId,
				modelCalls: total.modelCalls + step.usage.modelCalls,
				inputTokens: total.inputTokens + step.usage.inputTokens,
				cachedInputTokens:
					total.cachedInputTokens + step.usage.cachedInputTokens,
				outputTokens: total.outputTokens + step.usage.outputTokens,
				reasoningTokens: total.reasoningTokens + step.usage.reasoningTokens,
				costUsd:
					step.usage.costUsd === null
						? total.costUsd
						: (total.costUsd ?? 0) + step.usage.costUsd,
			}),
			emptyModelUsage(modelId),
		);
	return {
		schemaVersion: 1,
		runId: claimed.runId,
		testCase: {
			id: claimed.testCaseId,
			key: claimed.testCaseKey,
			title: "case",
			transcriptVersion: claimed.transcriptVersion,
			fingerprint: "sha256:test",
		},
		environment: { id: claimed.environmentId, name: "pcf-uat", baseUrl: null },
		params: claimed.params,
		runner: runnerInfo,
		model: {
			act: "anthropic/claude-opus-5-5",
			judge: "anthropic/claude-sonnet-5-5",
			provider: "anthropic",
		},
		status:
			options.status ?? (options.outcome === "failed" ? "failed" : "completed"),
		outcome: options.outcome ?? "passed",
		blockedReason: null,
		missing: [],
		startedAt: started.toISOString(),
		finishedAt: new Date(started.getTime() + 10_000).toISOString(),
		durationMs: 10_000,
		steps,
		totals: {
			stepsTotal: steps.length,
			stepsReplayed: steps.filter((step) => step.mode === "replayed").length,
			stepsAgent: steps.filter((step) => step.mode === "agent").length,
			stepsHandoff: steps.filter((step) => step.mode === "handoff").length,
			usage: sum(act, "anthropic/claude-opus-5-5"),
			judgeUsage: sum(judge, "anthropic/claude-sonnet-5-5"),
		},
		priceTableVersion: null,
		flaky: false,
		attempt: claimed.attempt,
		artifacts: [],
		errors: [],
	};
};

export const buildEvidenceZip = (
	report: RunReport,
	screenshots: Record<string, Uint8Array> = {},
) => {
	const now = new Date("2026-10-03T10:00:00.000Z");
	const draft = createSessionDraft({
		page: { title: "Run", url: "https://uat.example.test/login" },
		now,
	});
	const archive = createSessionArchive({
		...draft,
		sessionId: `jl_run_${(report.runId ?? "x").replace(/-/g, "")}`,
		name: "Run",
		phase: "ready",
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		events: [],
	});
	return zipSync({
		[sessionArchiveFileName]: strToU8(JSON.stringify(archive)),
		[recordingFileName]: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]),
		"run-report.json": strToU8(JSON.stringify(report)),
		...Object.fromEntries(
			Object.entries(screenshots).map(([stepId, bytes]) => [
				`screenshots/${stepId}.png`,
				bytes,
			]),
		),
	});
};

// Environment bound to a self-hosted pool, a credential, the BYOK model key and a case.
export const seedRunnableCase = async (
	fixture: TestCaseFixture,
	options: {
		password: string;
		modelKey?: string;
		pool?: string;
		creator?: Member;
	},
) => {
	const environment = await fixture.call<{ id: string }>("/test-environments", {
		token: fixture.admin.token,
		body: {
			name: "pcf-uat",
			baseUrl: "https://uat.example.test",
			variables: { SCHOOL_CODE: "HQ" },
			runnerPool: options.pool ?? "self-hosted:devbox",
			agentInstructions: "Never delete records.",
		},
	});
	if (environment.status !== 201)
		throw new Error(JSON.stringify(environment.body));
	const credential = await fixture.call<{ id: string }>("/test-credentials", {
		token: fixture.admin.token,
		body: {
			profile: "PCF_HQ_ADMIN",
			environmentId: environment.body.id,
			fields: { username: "hq.admin@example.test" },
			secretFields: { password: options.password },
		},
	});
	if (credential.status !== 201)
		throw new Error(JSON.stringify(credential.body));
	await fixture.call("/test-credentials", {
		token: fixture.admin.token,
		body: {
			profile: "UNUSED_PROFILE",
			fields: { username: "other@example.test" },
			secretFields: { password: "fake-unused-secret" },
		},
	});
	if (options.modelKey) {
		await fixture.call("/test-model-settings", {
			method: "PUT",
			token: fixture.admin.token,
			body: {
				actModel: "anthropic/claude-opus-5-5",
				judgeModel: "anthropic/claude-sonnet-5-5",
				apiKey: options.modelKey,
			},
		});
	}
	const testCase = await fixture.call<TestCaseDetail>("/test-cases", {
		token: (options.creator ?? fixture.qa).token,
		body: { transcript: loginTranscript(), environmentId: environment.body.id },
	});
	if (testCase.status !== 201) throw new Error(JSON.stringify(testCase.body));
	return {
		environmentId: environment.body.id,
		credentialId: credential.body.id,
		testCase: testCase.body,
	};
};

export const registerRunner = async (
	fixture: TestCaseFixture,
	poolName = "devbox",
	maxConcurrentRuns = 1,
) => {
	const pool = await fixture.call<{
		pool: { id: string };
		registrationToken: string;
	}>("/runner-pools", {
		token: fixture.admin.token,
		body: { name: poolName, maxConcurrentRuns },
	});
	if (pool.status !== 201) throw new Error(JSON.stringify(pool.body));
	const registration = await fixture.call<{
		workerId: string;
		workerToken: string;
		heartbeatMs: number;
		leaseMs: number;
	}>("/runner-pools/register", {
		token: pool.body.registrationToken,
		body: { hostname: "devbox-1", version: "1.8.2", capabilities: {} },
	});
	if (registration.status !== 201)
		throw new Error(JSON.stringify(registration.body));
	return {
		poolId: pool.body.pool.id,
		registrationToken: pool.body.registrationToken,
		...registration.body,
	};
};
