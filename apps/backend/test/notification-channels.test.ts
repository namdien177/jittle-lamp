import { afterAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { ClaimedRun, NotificationChannel } from "@jittle-lamp/shared";
import { and, eq } from "drizzle-orm";
import { createDb } from "../src/db";
import {
	notificationChannels,
	notificationDeliveries,
	notificationEvents,
} from "../src/db/schema";
import { slackMessage } from "../src/services/notification-channels";
import {
	CHANNEL_LEASE_MS,
	claimEventChannels,
	describeNotification,
	dispatchPendingNotifications,
	emitNotification,
} from "../src/services/notifications";
import {
	createTestCaseFixture,
	FAKE_MODEL_KEY,
	FAKE_PASSWORD,
	type TestCaseFixture,
} from "./test-case-fixtures";
import {
	buildRunReport,
	registerRunner,
	seedRunnableCase,
} from "./test-run-fixtures";

const WEB = "https://jl-web.example.test";

// A fake Slack incoming-webhook receiver.
const startFakeSlack = () => {
	const posts: Array<{
		path: string;
		body: Record<string, unknown>;
		raw: string;
		headers: Record<string, string>;
	}> = [];
	let failures = 0;
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const raw = await request.text();
			posts.push({
				path: url.pathname,
				body: JSON.parse(raw) as Record<string, unknown>,
				raw,
				headers: Object.fromEntries(request.headers.entries()),
			});
			if (failures > 0) {
				failures -= 1;
				return new Response("rate_limited", { status: 503 });
			}
			return new Response("ok");
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		posts,
		failNext: (count: number) => {
			failures = count;
		},
		stop: () => server.stop(true),
	};
};

const slack = startFakeSlack();
afterAll(() => slack.stop());

// Obviously fake incoming-webhook path.
const FAKE_HOOK_PATH = "/services/T00000000/B00000000/fakefakefakefakefake";

const slackCredential = async (fixture: TestCaseFixture) => {
	const created = await fixture.call<{ id: string }>("/test-credentials", {
		token: fixture.admin.token,
		body: {
			profile: "SLACK_QA",
			kind: "slack_webhook",
			secretFields: { url: `${slack.url}${FAKE_HOOK_PATH}` },
		},
	});
	expect(created.status).toBe(201);
	return created.body.id;
};

const finishOneRun = async (
	fixture: TestCaseFixture,
	testCaseId: string,
	outcome: "passed" | "failed",
) => {
	const runner = await registerRunner(fixture);
	await fixture.call(`/test-cases/${testCaseId}/runs`, {
		token: fixture.qa.token,
		body: {},
	});
	const claim = await fixture.call<{ run: ClaimedRun | null }>(
		"/runner-pools/claim",
		{ token: runner.workerToken, body: {} },
	);
	const claimed = claim.body.run;
	if (!claimed) throw new Error("Expected a claimed run");
	await fixture.call(`/test-runs/${claimed.runId}/finalize`, {
		token: claimed.runToken,
		body: { report: buildRunReport(claimed, { outcome }), evidenceId: null },
	});
	return claimed.runId;
};

describe("Slack and webhook notification channels", () => {
	it("manages channels with test_config.manage and never returns the Slack URL", async () => {
		const fixture = await createTestCaseFixture({
			env: { WEB_APP_ORIGIN: WEB, JL_OUTBOUND_ALLOW_LOOPBACK: "true" },
		});
		const credentialId = await slackCredential(fixture);
		const denied = await fixture.call("/notification-channels", {
			token: fixture.qa.token,
			body: { kind: "slack", config: { credentialId } },
		});
		expect(denied.status).toBe(403);
		const login = await fixture.call<{ id: string }>("/test-credentials", {
			token: fixture.admin.token,
			body: {
				profile: "PCF_LOGIN",
				fields: { username: "qa@example.test" },
				secretFields: { password: FAKE_PASSWORD },
			},
		});
		const wrongKind = await fixture.call("/notification-channels", {
			token: fixture.admin.token,
			body: { kind: "slack", config: { credentialId: login.body.id } },
		});
		expect(wrongKind.status).toBe(422);
		const badUrl = await fixture.call("/notification-channels", {
			token: fixture.admin.token,
			body: { kind: "webhook", config: { url: "ftp://example.test" } },
		});
		expect(badUrl.status).toBe(422);

		const created = await fixture.call<NotificationChannel>(
			"/notification-channels",
			{
				token: fixture.admin.token,
				body: {
					kind: "slack",
					config: { credentialId, channel: "#qa-runs", extra: "dropped" },
					filter: { kinds: ["run.finished"], tags: ["feature:login"] },
				},
			},
		);
		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({
			kind: "slack",
			config: { credentialId, channel: "#qa-runs" },
			filter: { kinds: ["run.finished"], tags: ["feature:login"] },
			enabled: true,
		});
		const list = await fixture.call<{ items: NotificationChannel[] }>(
			"/notification-channels",
			{ token: fixture.admin.token },
		);
		expect(list.body.items).toHaveLength(1);
		expect(JSON.stringify(list.body)).not.toContain(FAKE_HOOK_PATH);

		const before = slack.posts.length;
		const sample = await fixture.call<{
			delivered: boolean;
			error: string | null;
		}>(`/notification-channels/${created.body.id}/test`, {
			token: fixture.admin.token,
			body: {},
		});
		expect(sample.body).toEqual({ delivered: true, error: null });
		const message = slack.posts[before];
		expect(message?.path).toBe(FAKE_HOOK_PATH);
		expect(message?.body.text).toBe(
			"TC-0000 Test message from Jittle Lamp passed",
		);

		const disabled = await fixture.call<NotificationChannel>(
			`/notification-channels/${created.body.id}`,
			{ method: "PATCH", token: fixture.admin.token, body: { enabled: false } },
		);
		expect(disabled.body).toMatchObject({
			enabled: false,
			config: { credentialId },
		});
		const removed = await fixture.call(
			`/notification-channels/${created.body.id}`,
			{
				method: "DELETE",
				token: fixture.admin.token,
			},
		);
		expect(removed.status).toBe(200);
	});

	it("posts run events to Slack filtered by kind and tag, with retries and delivery records", async () => {
		const fixture = await createTestCaseFixture({
			env: { WEB_APP_ORIGIN: WEB, JL_OUTBOUND_ALLOW_LOOPBACK: "true" },
		});
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
			modelKey: FAKE_MODEL_KEY,
		});
		const credentialId = await slackCredential(fixture);
		const matching = await fixture.call<NotificationChannel>(
			"/notification-channels",
			{
				token: fixture.admin.token,
				body: {
					kind: "slack",
					config: { credentialId },
					filter: { kinds: ["run.finished"], tags: ["Feature:Login"] },
				},
			},
		);
		const otherTeam = await fixture.call<NotificationChannel>(
			"/notification-channels",
			{
				token: fixture.admin.token,
				body: {
					kind: "slack",
					config: { credentialId },
					filter: { kinds: [], tags: ["team:billing"] },
				},
			},
		);
		const blockedOnly = await fixture.call<NotificationChannel>(
			"/notification-channels",
			{
				token: fixture.admin.token,
				body: {
					kind: "slack",
					config: { credentialId },
					filter: { kinds: ["run.blocked"], tags: [] },
				},
			},
		);

		// Slack is down for the first three posts: the adapter retries inline twice, then the
		// bus records a failed delivery and retries it a minute later.
		slack.failNext(3);
		const before = slack.posts.length;
		const runId = await finishOneRun(fixture, testCase.id, "passed");
		const event = await fixture.db.query.notificationEvents.findFirst({
			where: and(
				eq(notificationEvents.orgId, fixture.orgId),
				eq(notificationEvents.kind, "run.finished"),
			),
		});
		if (!event) throw new Error("Expected run.finished");
		const deliveries = () =>
			fixture.db.query.notificationDeliveries.findMany({
				where: and(
					eq(notificationDeliveries.eventId, event.id),
					eq(notificationDeliveries.channelKind, "slack"),
				),
			});
		// Finalising the run did not wait for Slack: channels belong to the worker.
		expect(await deliveries()).toHaveLength(0);
		expect(slack.posts.length - before).toBe(0);
		await dispatchPendingNotifications(fixture.appDb, Date.now());
		const first = await deliveries();
		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({
			channelId: matching.body.id,
			status: "failed",
			attempts: 1,
			lastError: "Slack answered 503",
		});
		expect(slack.posts.length - before).toBe(3);

		await dispatchPendingNotifications(fixture.appDb, Date.now() + 61_000);
		const retried = await deliveries();
		expect(retried).toHaveLength(1);
		expect(retried[0]).toMatchObject({ status: "delivered", attempts: 2 });
		const posted = slack.posts.slice(before);
		expect(posted).toHaveLength(4);
		const message = posted[3]?.body as {
			text: string;
			blocks: Array<{
				type: string;
				text?: { text: string };
				fields?: Array<{ text: string }>;
				elements?: Array<{ text: string }>;
			}>;
		};
		expect(message.text).toBe(`${testCase.key} ${testCase.title} passed`);
		expect(message.blocks.map((block) => block.type)).toEqual([
			"header",
			"section",
			"context",
		]);
		expect(message.blocks[1]?.fields?.map((field) => field.text)).toEqual([
			"*Outcome*\n:white_check_mark: passed",
			`*Case*\n${testCase.key} ${testCase.title}`,
		]);
		expect(message.blocks[2]?.elements?.[0]?.text).toBe(
			`<${WEB}/test-runs/${runId}|Open in Jittle Lamp>`,
		);

		// Nothing is sent twice once delivered.
		await dispatchPendingNotifications(fixture.appDb, Date.now() + 600_000);
		expect(slack.posts.length - before).toBe(4);
		const all = await fixture.db.query.notificationDeliveries.findMany({
			where: eq(notificationDeliveries.eventId, event.id),
		});
		const channelIds = all.map((row) => row.channelId);
		expect(channelIds).not.toContain(otherTeam.body.id);
		expect(channelIds).not.toContain(blockedOnly.body.id);
		// The incoming-webhook URL never lands in delivery records.
		expect(JSON.stringify(all)).not.toContain(FAKE_HOOK_PATH);
	});

	it("links notifications to screens the web app has", () => {
		const at = (kind: string, payload: Record<string, unknown>) =>
			describeNotification({
				kind,
				subjectId: "subject-1",
				payloadJson: JSON.stringify(payload),
			}).url;
		expect(at("run.finished", {})).toBe("/test-runs/subject-1");
		expect(at("batch.finished", { focusRunId: "run-9" })).toBe(
			"/test-runs/run-9",
		);
		expect(at("batch.finished", {})).toBeNull();
		expect(at("review.pending_count", { count: 2 })).toBe("/test-cases/review");
		expect(at("runner.offline", {})).toBe("/settings/test-cases/runner-pools");
		expect(at("import.finished", {})).toBe("/test-cases/import/subject-1");

		const message = slackMessage(
			{
				kind: "batch.finished",
				subjectId: "batch-1",
				payloadJson: JSON.stringify({
					status: "failed",
					passed: 1,
					failed: 1,
					blocked: 0,
					focusRunId: "run-9",
				}),
			},
			WEB,
		);
		expect(message.text).toBe(
			"Run batch finished: 1 passed, 1 failed, 0 blocked",
		);
		expect(JSON.stringify(message.blocks)).toContain(
			`<${WEB}/test-runs/run-9|Open in Jittle Lamp>`,
		);
	});
});

describe("webhook notification channels after review", () => {
	it("stores the URL encrypted, shows it masked, signs posts and returns the signing secret once", async () => {
		const fixture = await createTestCaseFixture({
			env: { WEB_APP_ORIGIN: WEB, JL_OUTBOUND_ALLOW_LOOPBACK: "true" },
		});
		const url = `${slack.url}/hooks/jittle-lamp?token=fake-path-token-0000`;
		const created = await fixture.call<
			NotificationChannel & { signingSecret: string | null }
		>("/notification-channels", {
			token: fixture.admin.token,
			body: { kind: "webhook", config: { url } },
		});
		expect(created.status).toBe(201);
		expect(created.body.signingSecret).toStartWith("jlsig_");
		expect(created.body.config).toEqual({ urlMasked: `${slack.url}/…` });
		const row = await fixture.db.query.notificationChannels.findFirst({
			where: eq(notificationChannels.id, created.body.id),
		});
		expect(row?.secretEnc).toBeString();
		expect(JSON.stringify(row)).not.toContain("fake-path-token-0000");
		const list = await fixture.call<{ items: NotificationChannel[] }>(
			"/notification-channels",
			{ token: fixture.admin.token },
		);
		expect(JSON.stringify(list.body)).not.toContain("fake-path-token-0000");
		expect(JSON.stringify(list.body)).not.toContain(
			created.body.signingSecret ?? "missing",
		);

		// Editing the filter keeps the stored URL and secret.
		const edited = await fixture.call<NotificationChannel>(
			`/notification-channels/${created.body.id}`,
			{
				method: "PATCH",
				token: fixture.admin.token,
				body: { filter: { kinds: ["run.finished"], tags: [] } },
			},
		);
		expect(edited.status).toBe(200);
		expect(edited.body).not.toHaveProperty("signingSecret");

		const before = slack.posts.length;
		const sample = await fixture.call<{ delivered: boolean }>(
			`/notification-channels/${created.body.id}/test`,
			{
				token: fixture.admin.token,
				body: {},
			},
		);
		expect(sample.body.delivered).toBe(true);
		const post = slack.posts[before];
		expect(post?.path).toBe("/hooks/jittle-lamp");
		expect(post?.headers["x-jl-signature-256"]).toBe(
			`sha256=${createHmac("sha256", created.body.signingSecret ?? "")
				.update(post?.raw ?? "")
				.digest("hex")}`,
		);
	});

	it("refuses channel URLs on local addresses unless the dev flag allows loopback", async () => {
		const fixture = await createTestCaseFixture({
			env: { WEB_APP_ORIGIN: WEB, JL_OUTBOUND_ALLOW_LOOPBACK: "false" },
		});
		const created = await fixture.call<NotificationChannel>(
			"/notification-channels",
			{
				token: fixture.admin.token,
				body: { kind: "webhook", config: { url: `${slack.url}/hooks/local` } },
			},
		);
		const before = slack.posts.length;
		const sample = await fixture.call<{
			delivered: boolean;
			error: string | null;
		}>(`/notification-channels/${created.body.id}/test`, {
			token: fixture.admin.token,
			body: {},
		});
		expect(sample.body.delivered).toBe(false);
		expect(sample.body.error).toContain("private or local address");
		expect(slack.posts.length).toBe(before);
	});
});

describe("notification channel leases", () => {
	it("lets exactly one of two concurrent claims take an event's channel delivery", async () => {
		const fixture = await createTestCaseFixture({
			env: { WEB_APP_ORIGIN: WEB, JL_OUTBOUND_ALLOW_LOOPBACK: "true" },
		});
		const event = await emitNotification(fixture.db, {
			orgId: fixture.orgId,
			kind: "run.finished",
			subjectType: "test_run",
			subjectId: "run-lease",
		});
		if (!event) throw new Error("Expected an event");
		// Separate connections to the same database, as separate backend instances would use.
		const connections = Array.from({ length: 2 }, () => {
			const db = createDb(fixture.databaseUrl);
			if (!db) throw new Error("Expected database");
			return db;
		});
		const now = Date.now();
		const claims = await Promise.all(
			connections.map((db, index) =>
				claimEventChannels(db, event.id, `instance-${index}`, now),
			),
		);
		expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
		expect(
			await claimEventChannels(fixture.db, event.id, "late", now + 1_000),
		).toBeNull();
		expect(
			await claimEventChannels(
				fixture.db,
				event.id,
				"after-expiry",
				now + CHANNEL_LEASE_MS,
			),
		).toMatchObject({ channelsLeaseOwner: "after-expiry" });
	});

	it("posts to Slack once when two workers dispatch the same event at the same time", async () => {
		const fixture = await createTestCaseFixture({
			env: { WEB_APP_ORIGIN: WEB, JL_OUTBOUND_ALLOW_LOOPBACK: "true" },
		});
		const credentialId = await slackCredential(fixture);
		const channel = await fixture.call<NotificationChannel>(
			"/notification-channels",
			{
				token: fixture.admin.token,
				body: { kind: "slack", config: { credentialId } },
			},
		);
		expect(channel.status).toBe(201);
		const event = await emitNotification(fixture.appDb, {
			orgId: fixture.orgId,
			kind: "run.finished",
			subjectType: "test_run",
			subjectId: "run-twice",
			payload: { outcome: "passed", testCaseKey: "TC-9", testCaseTitle: "x" },
		});
		if (!event) throw new Error("Expected an event");
		const before = slack.posts.length;
		const now = Date.now();
		await Promise.all([
			dispatchPendingNotifications(fixture.appDb, now),
			dispatchPendingNotifications(fixture.appDb, now),
		]);
		expect(slack.posts.length - before).toBe(1);
		const deliveries = await fixture.db.query.notificationDeliveries.findMany({
			where: and(
				eq(notificationDeliveries.eventId, event.id),
				eq(notificationDeliveries.channelKind, "slack"),
			),
		});
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]).toMatchObject({ status: "delivered", attempts: 1 });
		const row = await fixture.db.query.notificationEvents.findFirst({
			where: eq(notificationEvents.id, event.id),
		});
		expect(row).toMatchObject({
			channelsLeaseOwner: null,
			channelsLeaseExpiresAt: null,
		});
		expect(row?.channelsDispatchedAt).toBeNumber();
	});
});
