import { Buffer } from "node:buffer";
import { createHmac, randomBytes } from "node:crypto";
import {
	type NotificationChannel,
	notificationKindSchema,
	type UpsertNotificationChannelRequest,
} from "@jittle-lamp/shared";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod/v4";

import { notificationChannels, testCredentials } from "../db/schema";
import { HttpError, notFound } from "../http/test-http";
import {
	type DeliveryOutcome,
	describeNotification,
	type NotificationChannelAdapter,
	type NotificationChannelRow,
	type NotificationEventRow,
} from "./notifications";
import {
	guardedFetch,
	OutboundBlockedError,
	type OutboundPolicy,
} from "./outbound-http";
import { parseJsonColumn } from "./test-cases";
import type { TestSecrets } from "./test-config";
import { credentialSubject } from "./test-settings";
import type { BackendDb } from "./user-provisioning";

// Slack and outgoing-webhook channels on the notification bus (design.md §10b, ADR 0002
// decision 16, phase 2 unit 2.2). Producers are untouched: the bus hands each event to these
// adapters, which post a short message and report delivered or failed; failed deliveries are
// retried by dispatchPendingNotifications (up to five attempts).
//
// Slack config is { credentialId } of a slack_webhook credential whose secret field `url` holds
// the incoming-webhook URL; the URL never leaves the server or appears in errors.

const stringRecord = z.record(z.string(), z.string());
const httpUrl = z
	.string()
	.url()
	.refine((value) => /^https?:\/\//i.test(value), "must be an http(s) URL");

export const filterSchema = z
	.object({
		kinds: z.array(notificationKindSchema).default([]),
		tags: z.array(z.string()).default([]),
	})
	.catch({ kinds: [], tags: [] });

// "https://chat.example.com/…": enough to recognise the target, never the path or its tokens.
export const maskUrl = (url: string): string => {
	try {
		return `${new URL(url).origin}/…`;
	} catch {
		return "…";
	}
};

// Webhook channel URLs are stored encrypted; the API only ever returns the masked form.
export const toNotificationChannel = (
	row: NotificationChannelRow,
): NotificationChannel => {
	const config = parseJsonColumn(row.configJson, stringRecord, {});
	if (row.kind === "webhook") {
		const { url: legacyUrl, ...rest } = config;
		return {
			id: row.id,
			kind: row.kind,
			config: {
				...rest,
				...(rest.urlMasked
					? {}
					: legacyUrl
						? { urlMasked: maskUrl(legacyUrl) }
						: {}),
			},
			filter: filterSchema.parse(JSON.parse(row.filterJson)),
			enabled: row.enabled,
		};
	}
	return {
		id: row.id,
		kind: row.kind,
		config,
		filter: filterSchema.parse(JSON.parse(row.filterJson)),
		enabled: row.enabled,
	};
};

const channelSubject = (id: string) => ({
	kind: "notification_channel",
	id,
	label: `notification channel ${id}`,
});

export const createChannelSigningSecret = () =>
	`jlsig_${Buffer.from(randomBytes(32)).toString("base64url")}`;

export type PreparedChannel = {
	configJson: string;
	secretEnc: string | null;
	keyVersion: number;
	// Returned once, when a webhook channel is created.
	signingSecret: string | null;
};

// Webhook channels: the URL and a per-channel signing secret are encrypted with the organisation
// data key; config keeps only the masked URL. An update without a new URL keeps the stored one.
export const prepareChannel = async (
	db: BackendDb,
	secrets: TestSecrets,
	input: {
		orgId: string;
		id: string;
		request: Pick<UpsertNotificationChannelRequest, "kind" | "config">;
		existing: NotificationChannelRow | null;
		actorUserId: string;
	},
): Promise<PreparedChannel> => {
	const config = await normalizeChannelConfig(db, input.orgId, input.request, {
		urlRequired: !input.existing,
	});
	if (input.request.kind !== "webhook") {
		return {
			configJson: JSON.stringify(config),
			secretEnc: null,
			keyVersion: 1,
			signingSecret: null,
		};
	}
	const existingSecret = input.existing?.secretEnc
		? await secrets.decrypt(
				input.orgId,
				channelSubject(input.id),
				input.existing.secretEnc,
				{
					actorUserId: input.actorUserId,
					reason: "notification_channel.update",
				},
			)
		: null;
	const legacyUrl = input.existing
		? parseJsonColumn(input.existing.configJson, stringRecord, {}).url
		: undefined;
	const url = config.url ?? existingSecret?.url ?? legacyUrl;
	if (!url) {
		throw new HttpError(
			422,
			"VALIDATION",
			"config.url: an http(s) URL is required",
		);
	}
	const isNew = !existingSecret?.signingSecret;
	const signingSecret =
		existingSecret?.signingSecret ?? createChannelSigningSecret();
	const sealed = await secrets.encrypt(input.orgId, channelSubject(input.id), {
		url,
		signingSecret,
	});
	return {
		configJson: JSON.stringify({ urlMasked: maskUrl(url) }),
		secretEnc: sealed.enc,
		keyVersion: sealed.keyVersion,
		signingSecret: isNew ? signingSecret : null,
	};
};

export const getChannelRow = async (
	db: BackendDb,
	orgId: string,
	id: string,
): Promise<NotificationChannelRow> => {
	const row = await db.query.notificationChannels.findFirst({
		where: and(
			eq(notificationChannels.id, id),
			eq(notificationChannels.orgId, orgId),
		),
	});
	if (!row) {
		throw notFound(
			"NOTIFICATION_CHANNEL_NOT_FOUND",
			"Notification channel not found",
		);
	}
	return row;
};

// Only the keys each kind uses are stored; references must belong to the organisation.
export const normalizeChannelConfig = async (
	db: BackendDb,
	orgId: string,
	request: Pick<UpsertNotificationChannelRequest, "kind" | "config">,
	options: { urlRequired?: boolean } = {},
): Promise<Record<string, string>> => {
	if (request.kind === "slack") {
		const credentialId = request.config.credentialId;
		if (!credentialId) {
			throw new HttpError(
				422,
				"VALIDATION",
				"config.credentialId: choose a slack_webhook credential",
			);
		}
		const credential = await db.query.testCredentials.findFirst({
			where: and(
				eq(testCredentials.id, credentialId),
				eq(testCredentials.orgId, orgId),
				isNull(testCredentials.deletedAt),
			),
			columns: { kind: true },
		});
		if (credential?.kind !== "slack_webhook") {
			throw new HttpError(
				422,
				"VALIDATION",
				"config.credentialId: not a slack_webhook credential of this organisation",
			);
		}
		const channelLabel = request.config.channel?.trim();
		return {
			credentialId,
			...(channelLabel ? { channel: channelLabel.slice(0, 80) } : {}),
		};
	}
	// The masked URL the API returned, sent back unchanged, means "keep the stored URL".
	const given = request.config.url?.trim();
	if (!given || given.endsWith("/…")) {
		if (options.urlRequired !== false) {
			throw new HttpError(
				422,
				"VALIDATION",
				"config.url: an http(s) URL is required",
			);
		}
		return {};
	}
	const url = httpUrl.safeParse(given);
	if (!url.success) {
		throw new HttpError(
			422,
			"VALIDATION",
			"config.url: an http(s) URL is required",
		);
	}
	return { url: url.data };
};

// ---------------------------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------------------------

const payloadSchema = z.record(z.string(), z.unknown()).catch({});
const text = (value: unknown) => (typeof value === "string" ? value : null);

const outcomeEmoji: Record<string, string> = {
	passed: ":white_check_mark:",
	failed: ":x:",
	blocked: ":warning:",
};

const escapeSlack = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const absoluteUrl = (url: string | null, webOrigin: string | null) => {
	if (!url) return null;
	if (/^https?:\/\//i.test(url)) return url;
	return webOrigin ? `${webOrigin.replace(/\/+$/, "")}${url}` : null;
};

// Block Kit-lite: a header with the title, the outcome and case as fields, and a link.
export const slackMessage = (
	event: Pick<NotificationEventRow, "kind" | "subjectId" | "payloadJson">,
	webOrigin: string | null,
) => {
	const described = describeNotification(event);
	const payload = payloadSchema.parse(JSON.parse(event.payloadJson));
	const outcome =
		text(payload.outcome) ??
		(event.kind === "batch.finished" ? text(payload.status) : null);
	const caseLabel = [text(payload.testCaseKey), text(payload.testCaseTitle)]
		.filter(Boolean)
		.join(" ");
	const link = absoluteUrl(described.url, webOrigin);
	const fields = [
		...(outcome
			? [
					{
						type: "mrkdwn",
						text: `*Outcome*\n${outcomeEmoji[outcome] ?? ""} ${escapeSlack(outcome)}`.trim(),
					},
				]
			: []),
		...(caseLabel
			? [{ type: "mrkdwn", text: `*Case*\n${escapeSlack(caseLabel)}` }]
			: []),
	];
	return {
		text: described.title,
		blocks: [
			{
				type: "header",
				text: {
					type: "plain_text",
					text: described.title.slice(0, 150),
					emoji: true,
				},
			},
			...(fields.length > 0 ? [{ type: "section", fields }] : []),
			...(described.body
				? [
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: escapeSlack(described.body).slice(0, 2900),
							},
						},
					]
				: []),
			...(link
				? [
						{
							type: "context",
							elements: [
								{ type: "mrkdwn", text: `<${link}|Open in Jittle Lamp>` },
							],
						},
					]
				: []),
		],
	};
};

// ---------------------------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------------------------

export type ChannelAdapterDeps = {
	secrets: TestSecrets;
	fetch: typeof fetch;
	// SSRF guard (services/outbound-http.ts).
	outbound: OutboundPolicy;
	webOrigin: string | null;
	// Inline retries for 429, 5xx and network errors before the bus schedules a later one.
	retryDelaysMs?: readonly number[];
};

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

const failed = (error: string): DeliveryOutcome[] => [
	{ recipientUserId: null, status: "failed", error: error.slice(0, 500) },
];

// Posts JSON with a few quick retries; the URL is never part of a returned error.
const postWithRetries = async (
	deps: ChannelAdapterDeps,
	label: string,
	url: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<DeliveryOutcome[]> => {
	const delays = deps.retryDelaysMs ?? [250, 1_000];
	let lastError = `${label} did not answer`;
	for (let attempt = 0; attempt <= delays.length; attempt += 1) {
		try {
			const response = await guardedFetch(deps.fetch, deps.outbound, url, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: typeof body === "string" ? body : JSON.stringify(body),
				signal: AbortSignal.timeout(10_000),
			});
			if (response.ok) {
				return [{ recipientUserId: null, status: "delivered" }];
			}
			lastError = `${label} answered ${response.status}`;
			if (response.status !== 429 && response.status < 500) {
				return failed(lastError);
			}
			const retryAfter = Number(response.headers.get("retry-after"));
			const wait = Number.isFinite(retryAfter)
				? Math.min(retryAfter * 1000, 2_000)
				: (delays[attempt] ?? 0);
			if (attempt < delays.length) await sleep(wait);
		} catch (error) {
			if (error instanceof OutboundBlockedError) {
				// Not retried: the address is refused, not down.
				return failed(`${label} refused: ${error.message}`);
			}
			lastError = `${label} unreachable (${error instanceof Error ? error.name : "error"})`;
			if (attempt < delays.length) await sleep(delays[attempt] ?? 0);
		}
	}
	return failed(lastError);
};

export const createSlackChannelAdapter = (
	deps: ChannelAdapterDeps,
): NotificationChannelAdapter => ({
	kind: "slack",
	deliver: async ({ db, event, channel }) => {
		if (!channel) return [];
		const config = parseJsonColumn(channel.configJson, stringRecord, {});
		const credential = config.credentialId
			? await db.query.testCredentials.findFirst({
					where: and(
						eq(testCredentials.id, config.credentialId),
						eq(testCredentials.orgId, channel.orgId),
						isNull(testCredentials.deletedAt),
					),
				})
			: null;
		if (!credential?.secretFieldsEnc || credential.kind !== "slack_webhook") {
			return failed("The Slack credential is missing or has no URL");
		}
		const secret = await deps.secrets.decrypt(
			channel.orgId,
			credentialSubject(credential),
			credential.secretFieldsEnc,
			{ actorUserId: null, reason: `notification.${event.kind}` },
		);
		const url = httpUrl.safeParse(secret.url);
		if (!url.success) {
			return failed("The Slack credential's url field is not a URL");
		}
		return postWithRetries(
			deps,
			"Slack",
			url.data,
			slackMessage(event, deps.webOrigin),
		);
	},
});

// Generic outgoing webhook: the event as JSON, for chat tools other than Slack.
export const createWebhookChannelAdapter = (
	deps: ChannelAdapterDeps,
): NotificationChannelAdapter => ({
	kind: "webhook",
	deliver: async ({ event, channel }) => {
		if (!channel) return [];
		const stored = channel.secretEnc
			? await deps.secrets.decrypt(
					channel.orgId,
					channelSubject(channel.id),
					channel.secretEnc,
					{ actorUserId: null, reason: `notification.${event.kind}` },
				)
			: null;
		const legacy = parseJsonColumn(channel.configJson, stringRecord, {});
		const url = httpUrl.safeParse(stored?.url ?? legacy.url);
		if (!url.success) return failed("The webhook channel has no URL");
		const described = describeNotification(event);
		const text = JSON.stringify({
			id: event.id,
			kind: event.kind,
			subjectType: event.subjectType,
			subjectId: event.subjectId,
			title: described.title,
			body: described.body,
			url: absoluteUrl(described.url, deps.webOrigin),
			payload: payloadSchema.parse(JSON.parse(event.payloadJson)),
			createdAt: event.createdAt,
		});
		// Receivers verify the sender with the channel's signing secret.
		return postWithRetries(deps, "Webhook", url.data, text, {
			"x-jl-event": event.kind,
			...(stored?.signingSecret
				? {
						"x-jl-signature-256": `sha256=${createHmac("sha256", stored.signingSecret).update(text).digest("hex")}`,
					}
				: {}),
		});
	},
});
