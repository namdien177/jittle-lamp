import { Buffer } from "node:buffer";
import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import {
	createTestRunRequestSchema,
	type TestRunBatch,
	type UpsertWebhookEndpointRequest,
	type WebhookDelivery,
	type WebhookEndpoint,
	type WebhookRule,
	webhookRuleSchema,
} from "@jittle-lamp/shared";
import {
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	or,
} from "drizzle-orm";
import { z } from "zod/v4";

import {
	testCases,
	testCredentials,
	testEnvironments,
	testRunBatches,
	testRuns,
	testSuites,
	webhookBatches,
	webhookDeliveries,
	webhookEndpoints,
} from "../db/schema";
import { createUuidV7 } from "../db/uuid";
import { HttpError, notFound } from "../http/test-http";
import { guardedFetch, type OutboundPolicy } from "./outbound-http";
import { parseJsonColumn, suiteMembers } from "./test-cases";
import type { TestSecrets } from "./test-config";
import { requestRuns, toBatch } from "./test-runs";
import { credentialSubject } from "./test-settings";
import type { BackendDb } from "./user-provisioning";

// CI triggers from GitLab and GitHub (design.md §10c, ADR 0002 decision 17, phase 2 unit 2.1).
//
// Inbound: POST /hooks/:endpointId is signed (X-Gitlab-Token compared in constant time, or
// X-Hub-Signature-256 = HMAC-SHA256 of the raw body). The event is normalised (push, merge
// request, pipeline success, deployment success), the endpoint's rules are evaluated and each
// matching rule creates a CI batch with one run per suite member. A batch is keyed on
// (endpoint, rule, commit SHA): a retriggered pipeline for the same commit attaches to it.
//
// Outbound: a pending commit status when the batch is created, and once it finishes the final
// commit status, an optional MR note / PR comment and an optional callback POST. Reports are
// rows in webhook_batches retried by a worker; provider HTTP goes through an injectable fetch.

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;
export type WebhookBatchRow = typeof webhookBatches.$inferSelect;
export type WebhookProvider = WebhookEndpointRow["provider"];

export const WEBHOOK_SECRET_PREFIX = "whsec_";
export const WEBHOOK_MAX_BODY_BYTES = 2 * 1024 * 1024;
const REPLAY_WINDOW_MS = 7 * 86_400_000;
export const WEBHOOK_REPORT_MAX_ATTEMPTS = 5;
export const STATUS_CONTEXT = "jittle-lamp/e2e";

const webhookSubject = (id: string) => ({
	kind: "webhook_endpoint",
	id,
	label: `webhook ${id}`,
});

export const createWebhookSecret = () =>
	`${WEBHOOK_SECRET_PREFIX}${Buffer.from(randomBytes(32)).toString("base64url")}`;

const sha256Hex = (value: Uint8Array | string) =>
	createHash("sha256").update(value).digest("hex");

const stableStringify = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
};

// Identifies a rule by content, so reordering rules keeps attaching to existing batches.
export const webhookRuleKey = (rule: WebhookRule) =>
	`sha256:${sha256Hex(stableStringify(rule))}`;

export const parseRules = (json: string): WebhookRule[] =>
	parseJsonColumn(json, z.array(webhookRuleSchema), []);

// ---------------------------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------------------------

// Compares digests so neither the length nor the content of the secret leaks through timing.
const constantTimeEqual = (a: string, b: string) =>
	timingSafeEqual(
		createHash("sha256").update(a, "utf8").digest(),
		createHash("sha256").update(b, "utf8").digest(),
	);

export const signBody = (secret: string, body: Uint8Array | string) =>
	`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

// GitLab sends the secret token verbatim; GitHub and generic senders sign the raw body.
export const verifyWebhookSignature = (
	provider: WebhookProvider,
	secret: string,
	headers: Headers,
	raw: Uint8Array,
): boolean => {
	if (!secret) return false;
	if (provider === "gitlab") {
		const token = headers.get("x-gitlab-token");
		return token !== null && constantTimeEqual(token, secret);
	}
	const signature = headers.get("x-hub-signature-256");
	if (!signature?.startsWith("sha256=")) return false;
	return constantTimeEqual(signature.toLowerCase(), signBody(secret, raw));
};

// ---------------------------------------------------------------------------------------------
// Normalising provider events
// ---------------------------------------------------------------------------------------------

export type WebhookEventKind = WebhookRule["when"]["events"][number];

export type WebhookEvent = {
	kind: WebhookEventKind;
	sha: string;
	branch: string | null;
	labels: string[];
	// MR iid (GitLab) or PR number (GitHub).
	mrId: string | null;
	title: string | null;
	reviewAppUrl: string | null;
	deploymentUrl: string | null;
	github: { owner: string; repo: string } | null;
	gitlab: { projectId: string; webUrl: string | null } | null;
};

export type NormalizedEvent =
	| { ok: true; eventType: string; event: WebhookEvent }
	| { ok: false; eventType: string; reason: string; ping?: boolean };

const shaPattern = /^[0-9a-f]{7,64}$/i;
const zeroSha = /^0+$/;
const httpUrl = z
	.string()
	.url()
	.refine((value) => /^https?:\/\//i.test(value));
const optionalUrl = (value: unknown): string | null => {
	const parsed = httpUrl.safeParse(value);
	return parsed.success ? parsed.data : null;
};
const branchOf = (ref: string | null | undefined) =>
	ref ? ref.replace(/^refs\/heads\//, "") : null;

const gitlabProject = z.object({
	id: z.union([z.number(), z.string()]),
	web_url: z.string().optional(),
});
const gitlabPush = z.object({
	ref: z.string(),
	after: z.string(),
	checkout_sha: z.string().nullable().optional(),
	project: gitlabProject,
});
const gitlabMergeRequest = z.object({
	object_attributes: z.object({
		iid: z.union([z.number(), z.string()]),
		action: z.string().optional(),
		title: z.string().optional(),
		source_branch: z.string(),
		last_commit: z.object({ id: z.string() }),
	}),
	labels: z.array(z.object({ title: z.string() })).optional(),
	project: gitlabProject,
});
const gitlabPipeline = z.object({
	object_attributes: z.object({
		status: z.string(),
		sha: z.string(),
		ref: z.string().nullable().optional(),
	}),
	merge_request: z
		.object({
			iid: z.union([z.number(), z.string()]),
			title: z.string().optional(),
		})
		.nullable()
		.optional(),
	project: gitlabProject,
});
const gitlabDeployment = z.object({
	status: z.string(),
	ref: z.string().nullable().optional(),
	short_sha: z.string().optional(),
	commit_url: z.string().optional(),
	environment_external_url: z.string().nullable().optional(),
	project: gitlabProject,
});

const githubRepository = z.object({ full_name: z.string() });
const githubPush = z.object({
	ref: z.string(),
	after: z.string(),
	deleted: z.boolean().optional(),
	repository: githubRepository,
});
const githubPullRequest = z.object({
	action: z.string(),
	number: z.number(),
	pull_request: z.object({
		title: z.string().optional(),
		head: z.object({ sha: z.string(), ref: z.string() }),
		labels: z.array(z.object({ name: z.string() })).optional(),
	}),
	repository: githubRepository,
});
const githubWorkflowRun = z.object({
	action: z.string(),
	workflow_run: z.object({
		conclusion: z.string().nullable(),
		head_sha: z.string(),
		head_branch: z.string().nullable().optional(),
		pull_requests: z.array(z.object({ number: z.number() })).optional(),
	}),
	repository: githubRepository,
});
const githubDeploymentStatus = z.object({
	deployment_status: z.object({
		state: z.string(),
		environment_url: z.string().nullable().optional(),
		target_url: z.string().nullable().optional(),
	}),
	deployment: z.object({
		sha: z.string(),
		ref: z.string().nullable().optional(),
	}),
	repository: githubRepository,
});

const genericEvent = z.object({
	event: z.enum(["push", "merge_request", "pipeline", "deployment"]),
	sha: z.string().regex(shaPattern),
	branch: z.string().nullable().optional(),
	labels: z.array(z.string()).optional(),
	mrId: z.union([z.string(), z.number()]).nullable().optional(),
	title: z.string().nullable().optional(),
	reviewAppUrl: z.string().nullable().optional(),
	deploymentUrl: z.string().nullable().optional(),
});

const githubRepo = (fullName: string) => {
	const [owner, repo] = fullName.split("/");
	return owner && repo ? { owner, repo } : null;
};
const gitlabRepo = (project: z.infer<typeof gitlabProject>) => ({
	projectId: String(project.id),
	webUrl: project.web_url ?? null,
});

const eventOf = (
	partial: Partial<WebhookEvent> & Pick<WebhookEvent, "kind" | "sha">,
): WebhookEvent => ({
	branch: null,
	labels: [],
	mrId: null,
	title: null,
	reviewAppUrl: null,
	deploymentUrl: null,
	github: null,
	gitlab: null,
	...partial,
});

const ignored = (eventType: string, reason: string): NormalizedEvent => ({
	ok: false,
	eventType,
	reason,
});

const normalizeGitlab = (
	headers: Headers,
	payload: unknown,
): NormalizedEvent => {
	const eventType = headers.get("x-gitlab-event") ?? "unknown";
	switch (eventType) {
		case "Push Hook": {
			const parsed = gitlabPush.safeParse(payload);
			if (!parsed.success) return ignored(eventType, "unreadable push payload");
			const sha = parsed.data.checkout_sha ?? parsed.data.after;
			if (zeroSha.test(sha)) return ignored(eventType, "branch deleted");
			return {
				ok: true,
				eventType,
				event: eventOf({
					kind: "push",
					sha,
					branch: branchOf(parsed.data.ref),
					gitlab: gitlabRepo(parsed.data.project),
				}),
			};
		}
		case "Merge Request Hook": {
			const parsed = gitlabMergeRequest.safeParse(payload);
			if (!parsed.success) {
				return ignored(eventType, "unreadable merge request payload");
			}
			const attributes = parsed.data.object_attributes;
			if (!["open", "reopen", "update"].includes(attributes.action ?? "")) {
				return ignored(
					eventType,
					`merge request action ${attributes.action ?? "none"}`,
				);
			}
			return {
				ok: true,
				eventType,
				event: eventOf({
					kind: "merge_request",
					sha: attributes.last_commit.id,
					branch: attributes.source_branch,
					labels: (parsed.data.labels ?? []).map((label) => label.title),
					mrId: String(attributes.iid),
					title: attributes.title ?? null,
					gitlab: gitlabRepo(parsed.data.project),
				}),
			};
		}
		case "Pipeline Hook": {
			const parsed = gitlabPipeline.safeParse(payload);
			if (!parsed.success) {
				return ignored(eventType, "unreadable pipeline payload");
			}
			const attributes = parsed.data.object_attributes;
			if (attributes.status !== "success") {
				return ignored(eventType, `pipeline ${attributes.status}`);
			}
			return {
				ok: true,
				eventType,
				event: eventOf({
					kind: "pipeline",
					sha: attributes.sha,
					branch: branchOf(attributes.ref),
					mrId: parsed.data.merge_request
						? String(parsed.data.merge_request.iid)
						: null,
					title: parsed.data.merge_request?.title ?? null,
					gitlab: gitlabRepo(parsed.data.project),
				}),
			};
		}
		case "Deployment Hook": {
			const parsed = gitlabDeployment.safeParse(payload);
			if (!parsed.success) {
				return ignored(eventType, "unreadable deployment payload");
			}
			if (parsed.data.status !== "success") {
				return ignored(eventType, `deployment ${parsed.data.status}`);
			}
			const sha =
				parsed.data.commit_url?.split("/").pop() ?? parsed.data.short_sha ?? "";
			const url = optionalUrl(parsed.data.environment_external_url);
			return {
				ok: true,
				eventType,
				event: eventOf({
					kind: "deployment",
					sha,
					branch: branchOf(parsed.data.ref),
					reviewAppUrl: url,
					deploymentUrl: url,
					gitlab: gitlabRepo(parsed.data.project),
				}),
			};
		}
		default:
			return ignored(eventType, `unsupported GitLab event ${eventType}`);
	}
};

const normalizeGithub = (
	headers: Headers,
	payload: unknown,
): NormalizedEvent => {
	const eventType = headers.get("x-github-event") ?? "unknown";
	switch (eventType) {
		case "ping":
			return { ok: false, eventType, reason: "ping", ping: true };
		case "push": {
			const parsed = githubPush.safeParse(payload);
			if (!parsed.success) return ignored(eventType, "unreadable push payload");
			if (parsed.data.deleted || zeroSha.test(parsed.data.after)) {
				return ignored(eventType, "branch deleted");
			}
			if (!parsed.data.ref.startsWith("refs/heads/")) {
				return ignored(eventType, "not a branch push");
			}
			return {
				ok: true,
				eventType,
				event: eventOf({
					kind: "push",
					sha: parsed.data.after,
					branch: branchOf(parsed.data.ref),
					github: githubRepo(parsed.data.repository.full_name),
				}),
			};
		}
		case "pull_request": {
			const parsed = githubPullRequest.safeParse(payload);
			if (!parsed.success) {
				return ignored(eventType, "unreadable pull request payload");
			}
			if (!["opened", "synchronize", "reopened"].includes(parsed.data.action)) {
				return ignored(eventType, `pull request ${parsed.data.action}`);
			}
			const pr = parsed.data.pull_request;
			return {
				ok: true,
				eventType,
				event: eventOf({
					kind: "merge_request",
					sha: pr.head.sha,
					branch: pr.head.ref,
					labels: (pr.labels ?? []).map((label) => label.name),
					mrId: String(parsed.data.number),
					title: pr.title ?? null,
					github: githubRepo(parsed.data.repository.full_name),
				}),
			};
		}
		case "workflow_run": {
			const parsed = githubWorkflowRun.safeParse(payload);
			if (!parsed.success) {
				return ignored(eventType, "unreadable workflow run payload");
			}
			const run = parsed.data.workflow_run;
			if (parsed.data.action !== "completed" || run.conclusion !== "success") {
				return ignored(
					eventType,
					`workflow run ${parsed.data.action} ${run.conclusion ?? ""}`.trim(),
				);
			}
			const pr = run.pull_requests?.[0];
			return {
				ok: true,
				eventType,
				event: eventOf({
					kind: "pipeline",
					sha: run.head_sha,
					branch: run.head_branch ?? null,
					mrId: pr ? String(pr.number) : null,
					github: githubRepo(parsed.data.repository.full_name),
				}),
			};
		}
		case "deployment_status": {
			const parsed = githubDeploymentStatus.safeParse(payload);
			if (!parsed.success) {
				return ignored(eventType, "unreadable deployment status payload");
			}
			const status = parsed.data.deployment_status;
			if (status.state !== "success") {
				return ignored(eventType, `deployment ${status.state}`);
			}
			const url =
				optionalUrl(status.environment_url) ?? optionalUrl(status.target_url);
			return {
				ok: true,
				eventType,
				event: eventOf({
					kind: "deployment",
					sha: parsed.data.deployment.sha,
					branch: branchOf(parsed.data.deployment.ref),
					reviewAppUrl: url,
					deploymentUrl: url,
					github: githubRepo(parsed.data.repository.full_name),
				}),
			};
		}
		default:
			return ignored(eventType, `unsupported GitHub event ${eventType}`);
	}
};

export const normalizeWebhookEvent = (
	provider: WebhookProvider,
	headers: Headers,
	payload: unknown,
): NormalizedEvent => {
	if (provider === "gitlab") return normalizeGitlab(headers, payload);
	if (provider === "github") return normalizeGithub(headers, payload);
	const parsed = genericEvent.safeParse(payload);
	if (!parsed.success) return ignored("generic", "payload needs event and sha");
	const mrId = parsed.data.mrId;
	return {
		ok: true,
		eventType: parsed.data.event,
		event: eventOf({
			kind: parsed.data.event,
			sha: parsed.data.sha,
			branch: parsed.data.branch ?? null,
			labels: parsed.data.labels ?? [],
			mrId: mrId === null || mrId === undefined ? null : String(mrId),
			title: parsed.data.title ?? null,
			reviewAppUrl: optionalUrl(parsed.data.reviewAppUrl),
			deploymentUrl: optionalUrl(parsed.data.deploymentUrl),
		}),
	};
};

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

// `*` matches within one path segment, `**` across segments, `?` one character.
export const globToRegExp = (glob: string): RegExp => {
	let pattern = "";
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index] ?? "";
		if (char === "*") {
			if (glob[index + 1] === "*") {
				pattern += ".*";
				index += 1;
			} else {
				pattern += "[^/]*";
			}
		} else if (char === "?") {
			pattern += "[^/]";
		} else {
			pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${pattern}$`);
};

// Host globs for review apps: `*` is one DNS label, `**` any number of labels.
export const hostGlobToRegExp = (glob: string): RegExp => {
	let pattern = "";
	const lower = glob.toLowerCase();
	for (let index = 0; index < lower.length; index += 1) {
		const char = lower[index] ?? "";
		if (char === "*") {
			if (lower[index + 1] === "*") {
				pattern += "[a-z0-9.-]+";
				index += 1;
			} else {
				pattern += "[a-z0-9-]+";
			}
		} else {
			pattern += char.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
		}
	}
	return new RegExp(`^${pattern}$`);
};

// The base environment's credentials go to the payload's URL, so its host must be allowed: the
// rule's allowedHosts globs, or the base environment's own host when the list is empty.
export const payloadHostAllowed = (
	url: string,
	allowedHosts: readonly string[],
	baseHost: string | null,
): { allowed: true } | { allowed: false; host: string } => {
	let host: string;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			return { allowed: false, host: parsed.protocol };
		}
		host = parsed.hostname.toLowerCase();
	} catch {
		return { allowed: false, host: "(invalid URL)" };
	}
	const patterns =
		allowedHosts.length > 0 ? allowedHosts : baseHost ? [baseHost] : [];
	return patterns.some((glob) => hostGlobToRegExp(glob).test(host))
		? { allowed: true }
		: { allowed: false, host };
};

// Events must be listed; branches (globs) and labels each match when empty or when any entry
// matches. An environment taken from the payload needs that URL in the event, on an allowed host.
export const matchRule = (
	rule: WebhookRule,
	event: WebhookEvent,
	baseHosts: ReadonlyMap<string, string | null> = new Map(),
): { matched: true } | { matched: false; reason: string } => {
	if (!rule.when.events.includes(event.kind)) {
		return { matched: false, reason: `event ${event.kind} not in rule` };
	}
	if (rule.when.branches.length > 0) {
		const branch = event.branch;
		if (
			!branch ||
			!rule.when.branches.some((glob) => globToRegExp(glob).test(branch))
		) {
			return {
				matched: false,
				reason: `branch ${branch ?? "(none)"} does not match`,
			};
		}
	}
	if (rule.when.labels.length > 0) {
		const labels = new Set(event.labels.map((label) => label.toLowerCase()));
		if (!rule.when.labels.some((label) => labels.has(label.toLowerCase()))) {
			return { matched: false, reason: "no matching label" };
		}
	}
	if ("fromPayload" in rule.environment) {
		const url =
			rule.environment.fromPayload === "review_app_url"
				? event.reviewAppUrl
				: event.deploymentUrl;
		if (!url) {
			return {
				matched: false,
				reason: `payload has no ${rule.environment.fromPayload.replace(/_/g, " ")}`,
			};
		}
		const check = payloadHostAllowed(
			url,
			rule.environment.allowedHosts,
			baseHosts.get(rule.environment.baseEnvironmentId) ?? null,
		);
		if (!check.allowed) {
			return {
				matched: false,
				reason: `host ${check.host} is not an allowed review app host`,
			};
		}
	}
	return { matched: true };
};

// ---------------------------------------------------------------------------------------------
// Endpoints (settings)
// ---------------------------------------------------------------------------------------------

export const toWebhookEndpoint = (
	row: WebhookEndpointRow,
	apiOrigin: string,
): WebhookEndpoint => ({
	id: row.id,
	provider: row.provider,
	rules: parseRules(row.rulesJson),
	enabled: row.enabled,
	url: `${apiOrigin.replace(/\/+$/, "")}/hooks/${row.id}`,
	createdAt: row.createdAt,
});

export const toWebhookDelivery = (
	row: typeof webhookDeliveries.$inferSelect,
): WebhookDelivery => ({
	id: row.id,
	eventType: row.eventType,
	status: row.status,
	signatureValid: row.signatureValid,
	triggerRef: row.triggerRef,
	batchId: row.batchId,
	error: row.error,
	report: null,
	createdAt: row.createdAt,
});

export const getWebhookEndpointRow = async (
	db: BackendDb,
	orgId: string,
	id: string,
): Promise<WebhookEndpointRow> => {
	const row = await db.query.webhookEndpoints.findFirst({
		where: and(
			eq(webhookEndpoints.id, id),
			eq(webhookEndpoints.orgId, orgId),
			isNull(webhookEndpoints.deletedAt),
		),
	});
	if (!row) throw notFound("WEBHOOK_NOT_FOUND", "Webhook endpoint not found");
	return row;
};

const credentialKindFor: Record<WebhookProvider, string | null> = {
	github: "github_app",
	gitlab: "gitlab_token",
	generic: null,
};

const invalid = (message: string) => new HttpError(422, "VALIDATION", message);

// Every suite, environment and credential a rule names must belong to the organisation.
export const validateRules = async (
	db: BackendDb,
	orgId: string,
	provider: WebhookProvider,
	rules: readonly WebhookRule[],
) => {
	for (const [index, rule] of rules.entries()) {
		const where = `rules.${index}`;
		const suite = await db.query.testSuites.findFirst({
			where: and(
				eq(testSuites.id, rule.run.suiteId),
				eq(testSuites.orgId, orgId),
				isNull(testSuites.deletedAt),
			),
			columns: { id: true },
		});
		if (!suite) throw invalid(`${where}.run.suiteId: suite not found`);
		const environmentId =
			"id" in rule.environment
				? rule.environment.id
				: rule.environment.baseEnvironmentId;
		const environment = await db.query.testEnvironments.findFirst({
			where: and(
				eq(testEnvironments.id, environmentId),
				eq(testEnvironments.orgId, orgId),
				isNull(testEnvironments.deletedAt),
			),
			columns: { id: true },
		});
		if (!environment) {
			throw invalid(`${where}.environment: environment not found`);
		}
		if (rule.report.credentialId) {
			const credential = await db.query.testCredentials.findFirst({
				where: and(
					eq(testCredentials.id, rule.report.credentialId),
					eq(testCredentials.orgId, orgId),
					isNull(testCredentials.deletedAt),
				),
				columns: { kind: true, fieldsJson: true },
			});
			if (!credential) {
				throw invalid(`${where}.report.credentialId: credential not found`);
			}
			// The PAT only ever goes to the API URL the credential names, never to a host taken
			// from a payload.
			const fields = parseJsonColumn(
				credential.fieldsJson,
				z.record(z.string(), z.string()),
				{},
			);
			if (provider === "gitlab" && !fields.api_url) {
				throw invalid(
					`${where}.report.credentialId: a gitlab_token credential needs the api_url field (https://gitlab.example.com/api/v4)`,
				);
			}
			const expected = credentialKindFor[provider];
			if (expected && credential.kind !== expected) {
				throw invalid(
					`${where}.report.credentialId: a ${provider} endpoint reports with a ${expected} credential`,
				);
			}
		}
	}
};

export const createWebhookEndpoint = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: {
		orgId: string;
		userId: string;
		request: UpsertWebhookEndpointRequest;
	},
): Promise<{ row: WebhookEndpointRow; secret: string }> => {
	await validateRules(
		db,
		input.orgId,
		input.request.provider,
		input.request.rules,
	);
	secrets.assertAvailable();
	const id = createUuidV7();
	const secret = createWebhookSecret();
	const sealed = await secrets.encrypt(input.orgId, webhookSubject(id), {
		secret,
	});
	const [row] = await db
		.insert(webhookEndpoints)
		.values({
			id,
			orgId: input.orgId,
			provider: input.request.provider,
			secretEnc: sealed.enc,
			keyVersion: sealed.keyVersion,
			rulesJson: JSON.stringify(input.request.rules),
			enabled: input.request.enabled,
			createdBy: input.userId,
		})
		.returning();
	if (!row) throw new Error("Failed to create webhook endpoint");
	return { row, secret };
};

export const rotateWebhookSecret = async (
	db: BackendDb,
	secrets: TestSecrets,
	row: WebhookEndpointRow,
): Promise<{ row: WebhookEndpointRow; secret: string }> => {
	const secret = createWebhookSecret();
	const sealed = await secrets.encrypt(row.orgId, webhookSubject(row.id), {
		secret,
	});
	const [updated] = await db
		.update(webhookEndpoints)
		.set({
			secretEnc: sealed.enc,
			keyVersion: sealed.keyVersion,
			updatedAt: Date.now(),
		})
		.where(eq(webhookEndpoints.id, row.id))
		.returning();
	if (!updated) throw new Error("Failed to rotate webhook secret");
	return { row: updated, secret };
};

const endpointSecret = async (
	secrets: TestSecrets,
	row: WebhookEndpointRow,
	reason: string,
) =>
	(
		await secrets.decrypt(row.orgId, webhookSubject(row.id), row.secretEnc, {
			actorUserId: null,
			reason,
		})
	).secret ?? "";

const endpointSecretForCheck = async (
	secrets: TestSecrets,
	row: WebhookEndpointRow,
) =>
	(
		await secrets.decryptForSignatureCheck(
			row.orgId,
			webhookSubject(row.id),
			row.secretEnc,
		)
	).secret ?? "";

// ---------------------------------------------------------------------------------------------
// Inbound deliveries
// ---------------------------------------------------------------------------------------------

export type WebhookReportDeps = {
	db: BackendDb;
	secrets: TestSecrets;
	fetch: typeof fetch;
	// SSRF guard for callback URLs and provider API URLs (services/outbound-http.ts).
	outbound: OutboundPolicy;
	// Links in commit statuses and notes point at the web app.
	webOrigin: string | null;
};

type BatchContext = {
	provider: WebhookProvider;
	eventType: string;
	event: WebhookEvent;
	baseUrl: string | null;
	// Report targets already delivered, so a retry never posts a note twice.
	done: string[];
};

const batchContextSchema = z.object({
	provider: z.enum(["gitlab", "github", "generic"]),
	eventType: z.string(),
	event: z.custom<WebhookEvent>(
		(value) => typeof value === "object" && value !== null,
	),
	baseUrl: z.string().nullable().default(null),
	done: z.array(z.string()).default([]),
});

export type DeliveryResult = {
	status: number;
	body: {
		status: "matched" | "ignored" | "rejected" | "error" | "pong";
		deliveryId?: string;
		reason?: string;
		batches?: Array<{ ruleIndex: number; batchId: string; attached: boolean }>;
		errors?: Array<{ ruleIndex: number; message: string }>;
	};
};

const recordDelivery = async (
	db: BackendDb,
	values: typeof webhookDeliveries.$inferInsert,
) => {
	const [row] = await db
		.insert(webhookDeliveries)
		.values({
			...values,
			error: values.error ? values.error.slice(0, 2000) : null,
		})
		.returning({ id: webhookDeliveries.id });
	return row?.id;
};

const providerDeliveryId = (headers: Headers) =>
	headers.get("x-github-delivery") ??
	headers.get("x-gitlab-event-uuid") ??
	headers.get("idempotency-key") ??
	headers.get("x-request-id");

const withId = (id: string | undefined) => (id ? { deliveryId: id } : {});

// Bad signatures are recorded at most once a minute per endpoint, so forged requests cannot fill
// the deliveries table (the route also rate-limits per endpoint and client address).
export const BAD_SIGNATURE_SAMPLE_MS = 60_000;

// Hosts of the base environments of rules that take their base URL from the payload.
const baseEnvironmentHosts = async (
	db: BackendDb,
	orgId: string,
	rules: readonly WebhookRule[],
): Promise<Map<string, string | null>> => {
	const ids = [
		...new Set(
			rules.flatMap((rule) =>
				"fromPayload" in rule.environment
					? [rule.environment.baseEnvironmentId]
					: [],
			),
		),
	];
	const out = new Map<string, string | null>();
	if (ids.length === 0) return out;
	const rows = await db.query.testEnvironments.findMany({
		where: and(
			eq(testEnvironments.orgId, orgId),
			inArray(testEnvironments.id, ids),
		),
		columns: { id: true, baseUrl: true },
	});
	for (const row of rows) {
		try {
			out.set(row.id, new URL(row.baseUrl).hostname.toLowerCase());
		} catch {
			out.set(row.id, null);
		}
	}
	return out;
};

export const handleWebhookDelivery = async (
	deps: WebhookReportDeps,
	input: {
		endpointId: string;
		headers: Headers;
		raw: Uint8Array;
		now?: number;
	},
): Promise<DeliveryResult> => {
	const { db } = deps;
	const now = input.now ?? Date.now();
	const endpoint = await db.query.webhookEndpoints.findFirst({
		where: and(
			eq(webhookEndpoints.id, input.endpointId),
			isNull(webhookEndpoints.deletedAt),
		),
	});
	if (!endpoint) {
		return {
			status: 404,
			body: { status: "rejected", reason: "unknown endpoint" },
		};
	}
	const payloadSha256 = sha256Hex(input.raw);
	const deliveryId = providerDeliveryId(input.headers)?.slice(0, 200) ?? null;
	const eventHeader = (
		input.headers.get("x-gitlab-event") ??
		input.headers.get("x-github-event") ??
		"generic"
	).slice(0, 100);
	const base = {
		endpointId: endpoint.id,
		orgId: endpoint.orgId,
		payloadSha256,
		deliveryId,
		createdAt: now,
	};
	// Unauthenticated callers reach this point: the decrypt writes no audit row.
	const secret = await endpointSecretForCheck(deps.secrets, endpoint);
	if (
		!verifyWebhookSignature(endpoint.provider, secret, input.headers, input.raw)
	) {
		const sampled = await db.query.webhookDeliveries.findFirst({
			where: and(
				eq(webhookDeliveries.endpointId, endpoint.id),
				eq(webhookDeliveries.signatureValid, false),
				gte(webhookDeliveries.createdAt, now - BAD_SIGNATURE_SAMPLE_MS),
			),
			columns: { id: true },
		});
		const id = sampled
			? undefined
			: await recordDelivery(db, {
					...base,
					eventType: eventHeader,
					signatureValid: false,
					status: "rejected",
					error: "invalid signature",
				});
		return {
			status: 401,
			body: { status: "rejected", reason: "invalid signature", ...withId(id) },
		};
	}
	// A delivery that already started or joined a batch (same provider delivery id or same signed
	// body) is a replay. Ignored deliveries may be redelivered, e.g. after fixing a rule.
	const earlier = await db.query.webhookDeliveries.findFirst({
		where: and(
			eq(webhookDeliveries.endpointId, endpoint.id),
			eq(webhookDeliveries.signatureValid, true),
			eq(webhookDeliveries.status, "matched"),
			gte(webhookDeliveries.createdAt, now - REPLAY_WINDOW_MS),
			deliveryId
				? or(
						eq(webhookDeliveries.deliveryId, deliveryId),
						eq(webhookDeliveries.payloadSha256, payloadSha256),
					)
				: eq(webhookDeliveries.payloadSha256, payloadSha256),
		),
		columns: { id: true },
	});
	if (earlier) {
		const id = await recordDelivery(db, {
			...base,
			eventType: eventHeader,
			signatureValid: true,
			status: "rejected",
			error: `replay of delivery ${earlier.id}`,
		});
		return {
			status: 409,
			body: { status: "rejected", reason: "replayed delivery", ...withId(id) },
		};
	}
	const accepted = { ...base, signatureValid: true };
	if (!endpoint.enabled) {
		const id = await recordDelivery(db, {
			...accepted,
			eventType: eventHeader,
			status: "ignored",
			error: "endpoint disabled",
		});
		return {
			status: 200,
			body: { status: "ignored", reason: "endpoint disabled", ...withId(id) },
		};
	}
	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(input.raw).toString("utf8"));
	} catch {
		const id = await recordDelivery(db, {
			...accepted,
			eventType: eventHeader,
			status: "rejected",
			error: "body is not JSON",
		});
		return {
			status: 400,
			body: { status: "rejected", reason: "body is not JSON", ...withId(id) },
		};
	}
	const normalized = normalizeWebhookEvent(
		endpoint.provider,
		input.headers,
		payload,
	);
	if (!normalized.ok || !shaPattern.test(normalized.event.sha)) {
		const reason = normalized.ok
			? "payload has no commit SHA"
			: normalized.reason;
		const ping = !normalized.ok && normalized.ping === true;
		const id = await recordDelivery(db, {
			...accepted,
			eventType: normalized.eventType.slice(0, 100),
			status: "ignored",
			error: ping ? null : reason,
		});
		return {
			status: 200,
			body: { status: ping ? "pong" : "ignored", reason, ...withId(id) },
		};
	}

	const { event } = normalized;
	const rules = parseRules(endpoint.rulesJson);
	const hosts = await baseEnvironmentHosts(db, endpoint.orgId, rules);
	const batches: Array<{
		ruleIndex: number;
		batchId: string;
		attached: boolean;
	}> = [];
	const errors: Array<{ ruleIndex: number; message: string }> = [];
	const reasons: string[] = [];
	const created: WebhookBatchRow[] = [];
	for (const [ruleIndex, rule] of rules.entries()) {
		const match = matchRule(rule, event, hosts);
		if (!match.matched) {
			reasons.push(`rule ${ruleIndex + 1}: ${match.reason}`);
			continue;
		}
		try {
			const link = await startOrJoinBatch(db, {
				endpoint,
				rule,
				ruleIndex,
				ruleKey: webhookRuleKey(rule),
				eventType: normalized.eventType,
				event,
				now,
			});
			batches.push({
				ruleIndex,
				batchId: link.row.batchId,
				attached: link.attached,
			});
			if (!link.attached) created.push(link.row);
		} catch (error) {
			errors.push({
				ruleIndex,
				message:
					error instanceof Error
						? error.message.slice(0, 300)
						: "failed to start runs",
			});
		}
	}
	const status: "matched" | "ignored" | "error" =
		batches.length > 0 ? "matched" : errors.length > 0 ? "error" : "ignored";
	const id = await recordDelivery(db, {
		...accepted,
		eventType: normalized.eventType.slice(0, 100),
		triggerRef: event.sha,
		batchId: batches[0]?.batchId ?? null,
		status,
		error:
			[
				...errors.map(
					(entry) => `rule ${entry.ruleIndex + 1}: ${entry.message}`,
				),
				...reasons,
			].join("; ") || null,
	});
	// The pending commit status goes out now; the worker retries it if the provider is down.
	for (const link of created) {
		await runReport(deps, link, now).catch(() => undefined);
	}
	return {
		status: status === "matched" ? 202 : 200,
		body: {
			status,
			...withId(id),
			batches,
			...(errors.length > 0 ? { errors } : {}),
			...(status === "ignored"
				? { reason: reasons.join("; ") || "no rules" }
				: {}),
		},
	};
};

// A later event for the same commit (a push, then the merge request) adds what it knows: the
// MR/PR id for the note, labels, the repository.
export const mergeEventContext = (
	current: WebhookEvent,
	next: WebhookEvent,
): WebhookEvent => ({
	...current,
	mrId: current.mrId ?? next.mrId,
	title: current.title ?? next.title,
	branch: current.branch ?? next.branch,
	labels: [...new Set([...current.labels, ...next.labels])],
	github: current.github ?? next.github,
	gitlab: current.gitlab ?? next.gitlab,
	reviewAppUrl: current.reviewAppUrl ?? next.reviewAppUrl,
	deploymentUrl: current.deploymentUrl ?? next.deploymentUrl,
});

const joinBatch = async (
	db: BackendDb,
	row: WebhookBatchRow,
	event: WebhookEvent,
	now: number,
): Promise<{ row: WebhookBatchRow; attached: true }> => {
	const context = parseJsonColumn(
		row.contextJson,
		batchContextSchema.nullable(),
		null,
	);
	if (context) {
		const merged = mergeEventContext(context.event, event);
		if (JSON.stringify(merged) !== JSON.stringify(context.event)) {
			await db
				.update(webhookBatches)
				.set({
					contextJson: JSON.stringify({ ...context, event: merged }),
					updatedAt: now,
				})
				.where(eq(webhookBatches.id, row.id));
		}
	}
	return { row, attached: true };
};

// The (endpoint, rule, SHA) row is claimed first, under its unique index, and the runs are
// created only by the delivery that won the claim; a concurrent delivery for the same commit
// waits for the batch id and joins it.
const startOrJoinBatch = async (
	db: BackendDb,
	input: {
		endpoint: WebhookEndpointRow;
		rule: WebhookRule;
		ruleIndex: number;
		ruleKey: string;
		eventType: string;
		event: WebhookEvent;
		now: number;
	},
): Promise<{ row: WebhookBatchRow; attached: boolean }> => {
	const { endpoint, rule, event } = input;
	const find = () =>
		db.query.webhookBatches.findFirst({
			where: and(
				eq(webhookBatches.endpointId, endpoint.id),
				eq(webhookBatches.ruleKey, input.ruleKey),
				eq(webhookBatches.triggerRef, event.sha),
			),
		});
	const baseUrl =
		"fromPayload" in rule.environment
			? rule.environment.fromPayload === "review_app_url"
				? event.reviewAppUrl
				: event.deploymentUrl
			: null;
	const context: BatchContext = {
		provider: endpoint.provider,
		eventType: input.eventType,
		event,
		baseUrl,
		done: [],
	};
	const [claim] = await db
		.insert(webhookBatches)
		.values({
			orgId: endpoint.orgId,
			endpointId: endpoint.id,
			ruleKey: input.ruleKey,
			ruleIndex: input.ruleIndex,
			triggerRef: event.sha,
			// Filled in once the runs exist.
			batchId: "",
			contextJson: JSON.stringify(context),
			createdAt: input.now,
			updatedAt: input.now,
		})
		.onConflictDoNothing()
		.returning();
	if (!claim) {
		for (let wait = 0; wait < 50; wait += 1) {
			const winner = await find();
			if (!winner) break;
			if (winner.batchId) return joinBatch(db, winner, event, input.now);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("Another delivery for this commit is still starting runs");
	}
	try {
		const batchId = await createBatchRuns(db, {
			endpoint,
			rule,
			event,
			baseUrl,
			now: input.now,
		});
		const [row] = await db
			.update(webhookBatches)
			.set({ batchId, updatedAt: input.now })
			.where(eq(webhookBatches.id, claim.id))
			.returning();
		return { row: row ?? { ...claim, batchId }, attached: false };
	} catch (error) {
		// Free the claim so a redelivery can try again.
		await db.delete(webhookBatches).where(eq(webhookBatches.id, claim.id));
		throw error;
	}
};

const createBatchRuns = async (
	db: BackendDb,
	input: {
		endpoint: WebhookEndpointRow;
		rule: WebhookRule;
		event: WebhookEvent;
		baseUrl: string | null;
		now: number;
	},
): Promise<string> => {
	const { endpoint, rule, event } = input;
	if (!endpoint.createdBy) {
		throw new Error("The endpoint has no owner any more; recreate it");
	}
	const suite = await db.query.testSuites.findFirst({
		where: and(
			eq(testSuites.id, rule.run.suiteId),
			eq(testSuites.orgId, endpoint.orgId),
			isNull(testSuites.deletedAt),
		),
	});
	if (!suite) throw new Error("The rule's suite no longer exists");
	// CI runs only approved cases: drafts and cases in review stay out of pipelines.
	const members = (await suiteMembers(db, endpoint.orgId, suite)).filter(
		(row) => row.status === "active",
	);
	if (members.length === 0) {
		throw new Error("The suite has no active test cases");
	}
	const environmentId =
		"id" in rule.environment
			? rule.environment.id
			: rule.environment.baseEnvironmentId;
	const request = createTestRunRequestSchema.parse({
		environmentId,
		trigger: "webhook",
		priority: rule.priority,
	});
	// The SHA is part of each run's dedupe key: a run never attaches to another commit's run.
	const { batchId } = await requestRuns(db, {
		orgId: endpoint.orgId,
		requester: {
			userId: endpoint.createdBy,
			tokenId: `webhook:${endpoint.id}`,
			kind: "automation",
		},
		cases: members.map((row) => ({ row, request })),
		batch: { kind: "ci", suiteId: suite.id, triggerRef: event.sha },
		baseUrlOverride: input.baseUrl,
		now: input.now,
	});
	if (!batchId) throw new Error("No batch was created");
	return batchId;
};

// ---------------------------------------------------------------------------------------------
// Outbound reports
// ---------------------------------------------------------------------------------------------

type ProviderCredential = { token: string; apiUrl: string | null };

// github_app and gitlab_token credentials hold the token in the secret field `token` (a
// fine-grained PAT or an installation token); `api_url` (public field) points at GitHub
// Enterprise or a self-managed GitLab.
const loadCredential = async (
	deps: WebhookReportDeps,
	orgId: string,
	credentialId: string | null,
): Promise<ProviderCredential | null> => {
	if (!credentialId) return null;
	const row = await deps.db.query.testCredentials.findFirst({
		where: and(
			eq(testCredentials.id, credentialId),
			eq(testCredentials.orgId, orgId),
			isNull(testCredentials.deletedAt),
		),
	});
	if (!row?.secretFieldsEnc) {
		throw new Error("The report credential has no token");
	}
	const secret = await deps.secrets.decrypt(
		orgId,
		credentialSubject(row),
		row.secretFieldsEnc,
		{ actorUserId: null, reason: "webhook.report" },
	);
	const fields = parseJsonColumn(
		row.fieldsJson,
		z.record(z.string(), z.string()),
		{},
	);
	const token = secret.token;
	if (!token) throw new Error("The report credential has no token field");
	return { token, apiUrl: fields.api_url ?? null };
};

class ProviderError extends Error {
	constructor(
		readonly target: string,
		readonly status: number,
		readonly detail: string,
	) {
		super(`${target} answered ${status}${detail ? `: ${detail}` : ""}`);
		this.name = "ProviderError";
	}
}

const postJson = async (
	deps: WebhookReportDeps,
	target: string,
	url: string,
	headers: Record<string, string>,
	body: unknown,
) => {
	const response = await guardedFetch(deps.fetch, deps.outbound, url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"user-agent": "jittle-lamp-webhooks",
			...headers,
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, 200);
		throw new ProviderError(target, response.status, detail);
	}
};

export type RunLine = {
	id: string;
	key: string;
	title: string;
	status: string;
	outcome: string | null;
	url: string | null;
};

const runLines = async (
	deps: WebhookReportDeps,
	batch: TestRunBatch,
): Promise<RunLine[]> => {
	const ids = [...new Set(batch.runIds)];
	if (ids.length === 0) return [];
	const runs = await deps.db.query.testRuns.findMany({
		where: inArray(testRuns.id, ids),
		columns: { id: true, testCaseId: true, status: true, outcome: true },
	});
	const cases = await deps.db.query.testCases.findMany({
		where: inArray(
			testCases.id,
			runs.map((run) => run.testCaseId),
		),
		columns: { id: true, key: true, title: true },
	});
	const caseById = new Map(cases.map((row) => [row.id, row]));
	const runById = new Map(runs.map((run) => [run.id, run]));
	const web = deps.webOrigin?.replace(/\/+$/, "") ?? null;
	return ids.flatMap((id) => {
		const run = runById.get(id);
		if (!run) return [];
		const testCase = caseById.get(run.testCaseId);
		return [
			{
				id,
				key: testCase?.key ?? "",
				title: testCase?.title ?? "",
				status: run.status,
				outcome: run.outcome,
				url: web ? `${web}/test-runs/${id}` : null,
			},
		];
	});
};

export const batchSummary = (batch: TestRunBatch) =>
	`${batch.counts.passed} passed, ${batch.counts.failed} failed, ${batch.counts.blocked} blocked${
		batch.counts.pending > 0 ? `, ${batch.counts.pending} pending` : ""
	}`;

const verdict = (batch: TestRunBatch) =>
	batch.status === "completed"
		? "passed"
		: batch.status === "cancelled"
			? "cancelled"
			: batch.status === "failed"
				? "failed"
				: "running";

export const renderMergeRequestNote = (
	batch: TestRunBatch,
	lines: readonly RunLine[],
	sha: string,
) =>
	[
		`### Jittle Lamp E2E: ${verdict(batch)}`,
		"",
		`**${batchSummary(batch)}** for \`${sha.slice(0, 12)}\``,
		"",
		"| Case | Result | Run |",
		"| --- | --- | --- |",
		...lines.map(
			(line) =>
				`| ${`${line.key} ${line.title}`.trim().replace(/\|/g, "\\|")} | ${line.outcome ?? line.status} | ${line.url ? `[open](${line.url})` : "-"} |`,
		),
	].join("\n");

type Stage = "pending" | "final";

const githubState = (batch: TestRunBatch, stage: Stage) =>
	stage === "pending"
		? "pending"
		: batch.status === "completed"
			? "success"
			: batch.status === "cancelled"
				? "error"
				: "failure";

const gitlabState = (batch: TestRunBatch, stage: Stage) =>
	stage === "pending"
		? "pending"
		: batch.status === "completed"
			? "success"
			: batch.status === "cancelled"
				? "canceled"
				: "failed";

// The first failing run, else the first run: what a reviewer wants to open from the status.
const targetUrl = (lines: readonly RunLine[]) =>
	(
		lines.find(
			(line) => line.outcome === "failed" || line.outcome === "blocked",
		) ?? lines[0]
	)?.url ?? null;

const githubApi = (credential: ProviderCredential) =>
	(credential.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");

// Only the credential names the API host; a payload's project URL is never trusted with the PAT.
const gitlabApi = (credential: ProviderCredential) => {
	if (!credential.apiUrl) {
		throw new Error(
			"The GitLab credential needs api_url (https://gitlab.example.com/api/v4)",
		);
	}
	return credential.apiUrl.replace(/\/+$/, "");
};

const githubHeaders = (credential: ProviderCredential) => ({
	authorization: `Bearer ${credential.token}`,
	accept: "application/vnd.github+json",
	"x-github-api-version": "2022-11-28",
});

const sendTarget = async (
	deps: WebhookReportDeps,
	input: {
		target: "status" | "note" | "callback";
		endpoint: WebhookEndpointRow;
		rule: WebhookRule;
		context: BatchContext;
		batch: TestRunBatch;
		lines: RunLine[];
		credential: ProviderCredential | null;
		stage: Stage;
	},
) => {
	const { context, batch, credential, stage } = input;
	const { event } = context;
	const description =
		stage === "pending"
			? `Jittle Lamp: ${batch.counts.total} test case(s) queued`
			: `Jittle Lamp: ${batchSummary(batch)}`;
	const url = targetUrl(input.lines);
	if (input.target === "status") {
		if (!credential) return;
		if (context.provider === "github" && event.github) {
			await postJson(
				deps,
				"GitHub commit status",
				`${githubApi(credential)}/repos/${event.github.owner}/${event.github.repo}/statuses/${event.sha}`,
				githubHeaders(credential),
				{
					state: githubState(batch, stage),
					description: description.slice(0, 140),
					context: STATUS_CONTEXT,
					...(url ? { target_url: url } : {}),
				},
			);
		} else if (context.provider === "gitlab" && event.gitlab) {
			try {
				await postJson(
					deps,
					"GitLab commit status",
					`${gitlabApi(credential)}/projects/${encodeURIComponent(event.gitlab.projectId)}/statuses/${event.sha}`,
					{ "private-token": credential.token },
					{
						state: gitlabState(batch, stage),
						name: STATUS_CONTEXT,
						description: description.slice(0, 255),
						...(url ? { target_url: url } : {}),
					},
				);
			} catch (error) {
				// GitLab refuses to set the state a status already has; nothing left to do.
				if (
					error instanceof ProviderError &&
					error.status === 400 &&
					/cannot transition/i.test(error.detail)
				) {
					return;
				}
				throw error;
			}
		}
		return;
	}
	if (input.target === "note") {
		if (!credential || !event.mrId) return;
		const body = renderMergeRequestNote(batch, input.lines, event.sha);
		if (context.provider === "github" && event.github) {
			await postJson(
				deps,
				"GitHub PR comment",
				`${githubApi(credential)}/repos/${event.github.owner}/${event.github.repo}/issues/${event.mrId}/comments`,
				githubHeaders(credential),
				{ body },
			);
		} else if (context.provider === "gitlab" && event.gitlab) {
			await postJson(
				deps,
				"GitLab MR note",
				`${gitlabApi(credential)}/projects/${encodeURIComponent(event.gitlab.projectId)}/merge_requests/${event.mrId}/notes`,
				{ "private-token": credential.token },
				{ body },
			);
		}
		return;
	}
	const callbackUrl = input.rule.report.callbackUrl;
	if (!callbackUrl) return;
	const text = JSON.stringify({
		event: "batch.finished",
		batch,
		runs: input.lines,
		trigger: {
			provider: context.provider,
			event: event.kind,
			sha: event.sha,
			branch: event.branch,
			mrId: event.mrId,
			baseUrl: context.baseUrl,
		},
	});
	// Signed with the endpoint secret so the receiver can verify the sender.
	const secret = await endpointSecret(
		deps.secrets,
		input.endpoint,
		"webhook.callback",
	);
	const response = await guardedFetch(deps.fetch, deps.outbound, callbackUrl, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"user-agent": "jittle-lamp-webhooks",
			"x-jl-signature-256": signBody(secret, text),
		},
		body: text,
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new ProviderError("Callback", response.status, "");
};

const markReported = async (
	db: BackendDb,
	link: WebhookBatchRow,
	stage: Stage,
	now: number,
	note: string | null,
) => {
	await db
		.update(webhookBatches)
		.set({
			pendingReportedAt: link.pendingReportedAt ?? now,
			...(stage === "final" ? { finalReportedAt: now } : {}),
			reportError: note,
			updatedAt: now,
		})
		.where(eq(webhookBatches.id, link.id));
};

// Sends what the batch still owes: the pending status while it runs, then the final status,
// note and callback once it finished. Each delivered target is remembered, so a retry after a
// partial failure never posts the MR note twice.
const runReport = async (
	deps: WebhookReportDeps,
	link: WebhookBatchRow,
	now: number,
): Promise<Stage> => {
	const { db } = deps;
	const endpoint = await db.query.webhookEndpoints.findFirst({
		where: eq(webhookEndpoints.id, link.endpointId),
	});
	const context = parseJsonColumn(
		link.contextJson,
		batchContextSchema.nullable(),
		null,
	);
	const batch = await toBatch(db, link.batchId, link.orgId).catch(() => null);
	if (!endpoint || !context || !batch) {
		await markReported(db, link, "final", now, "endpoint or batch missing");
		return "final";
	}
	const stage: Stage = batch.finishedAt !== null ? "final" : "pending";
	const rules = parseRules(endpoint.rulesJson);
	const rule =
		rules.find((candidate) => webhookRuleKey(candidate) === link.ruleKey) ??
		null;
	if (!rule) {
		await markReported(db, link, stage, now, "rule removed; nothing reported");
		return stage;
	}
	const targets: Array<"status" | "note" | "callback"> =
		stage === "pending"
			? rule.report.commitStatus
				? ["status"]
				: []
			: [
					...(rule.report.commitStatus ? (["status"] as const) : []),
					...(rule.report.mrNote ? (["note"] as const) : []),
					...(rule.report.callbackUrl ? (["callback"] as const) : []),
				];
	const done = new Set(context.done);
	const todo = targets.filter((target) => !done.has(`${stage}:${target}`));
	let failure: string | null = null;
	let credential: ProviderCredential | null = null;
	let lines: RunLine[] = [];
	try {
		if (todo.some((target) => target !== "callback")) {
			credential = await loadCredential(
				deps,
				link.orgId,
				rule.report.credentialId,
			);
		}
		if (todo.length > 0) lines = await runLines(deps, batch);
	} catch (error) {
		failure = error instanceof Error ? error.message : "report failed";
	}
	for (const target of failure ? [] : todo) {
		try {
			await sendTarget(deps, {
				target,
				endpoint,
				rule,
				context,
				batch,
				lines,
				credential,
				stage,
			});
			done.add(`${stage}:${target}`);
		} catch (error) {
			failure = error instanceof Error ? error.message : "report failed";
		}
	}
	// Attempts count per stage: a pending status that ran out of attempts must not stop the final
	// report once the batch finishes.
	const previous = link.reportStage === stage ? link.reportAttempts : 0;
	const attempts = failure ? previous + 1 : 0;
	await db
		.update(webhookBatches)
		.set({
			contextJson: JSON.stringify({ ...context, done: [...done] }),
			reportStage: stage,
			...(failure
				? {
						reportAttempts: attempts,
						reportNextAt: now + 60_000 * 2 ** Math.min(attempts - 1, 5),
						reportError: failure.slice(0, 500),
					}
				: {
						reportAttempts: 0,
						reportNextAt: null,
						reportError: null,
						pendingReportedAt: link.pendingReportedAt ?? now,
						...(stage === "final" ? { finalReportedAt: now } : {}),
					}),
			updatedAt: now,
		})
		.where(eq(webhookBatches.id, link.id));
	if (failure) throw new Error(failure);
	return stage;
};

// Worker step: pending statuses not sent yet, and final reports of finished batches.
export const processWebhookReports = async (
	deps: WebhookReportDeps,
	now = Date.now(),
): Promise<number> => {
	const rows = await deps.db
		.select({ link: webhookBatches })
		.from(webhookBatches)
		.innerJoin(testRunBatches, eq(testRunBatches.id, webhookBatches.batchId))
		.where(
			and(
				or(
					lt(webhookBatches.reportAttempts, WEBHOOK_REPORT_MAX_ATTEMPTS),
					// Attempts spent on the pending status do not count for the final report.
					and(
						eq(webhookBatches.reportStage, "pending"),
						isNotNull(testRunBatches.finishedAt),
					),
				),
				or(
					isNull(webhookBatches.reportNextAt),
					lte(webhookBatches.reportNextAt, now),
					and(
						eq(webhookBatches.reportStage, "pending"),
						isNotNull(testRunBatches.finishedAt),
					),
				),
				isNull(webhookBatches.finalReportedAt),
				or(
					isNull(webhookBatches.pendingReportedAt),
					isNotNull(testRunBatches.finishedAt),
				),
			),
		)
		.orderBy(asc(webhookBatches.createdAt))
		.limit(100);
	let sent = 0;
	for (const { link } of rows) {
		try {
			await runReport(deps, link, now);
			sent += 1;
		} catch {
			// Recorded on the row and retried with backoff.
		}
	}
	return sent;
};

export const createWebhookReportWorker = (
	deps: WebhookReportDeps & { intervalMs?: number },
) => ({
	runOnce: () => processWebhookReports(deps),
	start: () => {
		let stopped = false;
		const loop = async () => {
			while (!stopped) {
				await processWebhookReports(deps).catch(() => 0);
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, deps.intervalMs ?? 5_000);
					timer.unref();
				});
			}
		};
		void loop();
		return () => {
			stopped = true;
		};
	},
});

export const reportStateOf = (
	link: Pick<
		WebhookBatchRow,
		"reportStage" | "reportAttempts" | "reportError" | "finalReportedAt"
	>,
): NonNullable<WebhookDelivery["report"]> => ({
	stage: link.reportStage,
	state:
		link.finalReportedAt !== null
			? "sent"
			: link.reportAttempts >= WEBHOOK_REPORT_MAX_ATTEMPTS
				? "failed"
				: link.reportAttempts > 0
					? "retrying"
					: "pending",
	attempts: link.reportAttempts,
	error: link.reportError,
});

// Deliveries with the outbound report of the batch each one started or joined, so a dead-lettered
// commit status or MR note is visible in settings.
export const listWebhookDeliveries = async (
	db: BackendDb,
	endpointId: string,
	limit = 50,
): Promise<WebhookDelivery[]> => {
	const rows = await db.query.webhookDeliveries.findMany({
		where: eq(webhookDeliveries.endpointId, endpointId),
		orderBy: desc(webhookDeliveries.createdAt),
		limit,
	});
	const batchIds = [
		...new Set(rows.flatMap((row) => (row.batchId ? [row.batchId] : []))),
	];
	const links = batchIds.length
		? await db.query.webhookBatches.findMany({
				where: and(
					eq(webhookBatches.endpointId, endpointId),
					inArray(webhookBatches.batchId, batchIds),
				),
			})
		: [];
	const byBatch = new Map(links.map((link) => [link.batchId, link]));
	return rows.map((row) => {
		const link = row.batchId ? byBatch.get(row.batchId) : undefined;
		return {
			...toWebhookDelivery(row),
			report: link ? reportStateOf(link) : null,
		};
	});
};
