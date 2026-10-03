import { describe, expect, it } from "bun:test";
import type {
	ClaimedRun,
	CreateTestRunResponse,
	ImportBatch,
	Notification,
} from "@jittle-lamp/shared";
import { and, eq } from "drizzle-orm";

import {
	notificationChannels,
	notificationDeliveries,
	notificationEvents,
} from "../src/db/schema";
import {
	dispatchPendingNotifications,
	emitNotification,
	type NotificationChannelAdapter,
	registerNotificationAdapter,
} from "../src/services/notifications";
import {
	RUNNER_OFFLINE_MS,
	sweepRunQueue,
} from "../src/services/test-run-queue";
import {
	createTestCaseFixture,
	FAKE_PASSWORD,
	type Member,
	type TestCaseFixture,
} from "./test-case-fixtures";
import {
	buildRunReport,
	registerRunner,
	seedRunnableCase,
} from "./test-run-fixtures";

const inbox = async (fixture: TestCaseFixture, member: Member) =>
	(
		await fixture.call<{ items: Notification[]; unread: number }>(
			"/notifications",
			{
				token: member.token,
			},
		)
	).body;

const kinds = (items: Notification[]) => items.map((item) => item.kind).sort();

describe("notifications", () => {
	it("delivers run, batch and runner events in-app to requesters, subscribers and managers", async () => {
		const fixture = await createTestCaseFixture();
		const { testCase } = await seedRunnableCase(fixture, {
			password: FAKE_PASSWORD,
		});
		const runner = await registerRunner(fixture);
		const suite = await fixture.call<{ id: string }>("/test-suites", {
			token: fixture.qa.token,
			body: { name: "Smoke", memberIds: [testCase.id] },
		});
		const requested = await fixture.call<CreateTestRunResponse>(
			`/test-suites/${suite.body.id}/runs`,
			{ token: fixture.qa.token, body: {} },
		);
		await fixture.call(`/test-cases/${testCase.id}/runs`, {
			token: fixture.developer.token,
			body: {},
		});
		const claim = await fixture.call<{ run: ClaimedRun }>(
			"/runner-pools/claim",
			{
				token: runner.workerToken,
				body: {},
			},
		);
		expect(claim.body.run.runId).toBe(requested.body.runId);
		await fixture.call(`/test-runs/${claim.body.run.runId}/finalize`, {
			token: claim.body.run.runToken,
			body: {
				report: buildRunReport(claim.body.run, { outcome: "failed" }),
				evidenceId: null,
			},
		});

		const qa = await inbox(fixture, fixture.qa);
		expect(kinds(qa.items)).toEqual(["batch.finished", "run.finished"]);
		expect(qa.unread).toBe(2);
		const run = qa.items.find((item) => item.kind === "run.finished");
		expect(run).toMatchObject({
			subjectType: "test_run",
			subjectId: requested.body.runId,
			title: "TC-0001 HQ admin logout clears the email failed",
			url: `/test-runs/${requested.body.runId}`,
			readAt: null,
		});
		const batch = qa.items.find((item) => item.kind === "batch.finished");
		expect(batch?.title).toBe(
			"Run batch finished: 0 passed, 1 failed, 0 blocked",
		);
		// The developer attached to the run and hears about it, the admin did not ask.
		expect(kinds((await inbox(fixture, fixture.developer)).items)).toEqual([
			"batch.finished",
			"run.finished",
		]);
		expect((await inbox(fixture, fixture.admin)).items).toHaveLength(0);

		const read = await fixture.call<{ unread: number }>(
			`/notifications/${run?.id}/read`,
			{ token: fixture.qa.token, body: {} },
		);
		expect(read.body.unread).toBe(1);
		const all = await fixture.call<{ unread: number }>(
			"/notifications/read-all",
			{
				token: fixture.qa.token,
				body: {},
			},
		);
		expect(all.body.unread).toBe(0);
		const bodyRead = await fixture.call<{ unread: number }>(
			"/notifications/read",
			{
				token: fixture.developer.token,
				body: { ids: [run?.id] },
			},
		);
		expect(bodyRead.body.unread).toBe(1);
		expect(
			(await inbox(fixture, fixture.qa)).items.every((item) => item.readAt),
		).toBe(true);
		// Read state is per user.
		expect((await inbox(fixture, fixture.developer)).unread).toBe(1);

		// A blocked verdict is its own kind.
		await fixture.call(`/test-cases/${testCase.id}/runs`, {
			token: fixture.qa.token,
			body: { force: true },
		});
		const blocked = await fixture.call<{ run: ClaimedRun }>(
			"/runner-pools/claim",
			{
				token: runner.workerToken,
				body: {},
			},
		);
		const report = {
			...buildRunReport(blocked.body.run, { outcome: "blocked" }),
			blockedReason: "MISSING_CREDENTIAL" as const,
		};
		await fixture.call(`/test-runs/${blocked.body.run.runId}/finalize`, {
			token: blocked.body.run.runToken,
			body: { report, evidenceId: null },
		});
		const blockedNote = (await inbox(fixture, fixture.qa)).items.find(
			(item) => item.kind === "run.blocked",
		);
		expect(blockedNote).toMatchObject({
			title: "TC-0001 HQ admin logout clears the email is blocked",
			body: "MISSING_CREDENTIAL",
		});

		// Silent runners are reported to configuration managers once.
		await sweepRunQueue(fixture.db, Date.now() + RUNNER_OFFLINE_MS + 1);
		const offline = (await inbox(fixture, fixture.admin)).items.filter(
			(item) => item.kind === "runner.offline",
		);
		expect(offline).toHaveLength(1);
		expect(offline[0]?.title).toBe("Runner devbox-1 in pool devbox is offline");
		expect(
			(await inbox(fixture, fixture.qa)).items.some(
				(item) => item.kind === "runner.offline",
			),
		).toBe(false);
	});

	it("announces imports and the review queue to approvers, honouring subscriptions", async () => {
		const fixture = await createTestCaseFixture();
		const batch = await fixture.call<ImportBatch>("/test-cases/import", {
			token: fixture.qa.token,
			body: {
				sourceKind: "transcript-doc",
				content: "# One\n\n[Act] one\n\n# Two\n\n[Act] two",
			},
		});
		await fixture.call(`/test-cases/import/${batch.body.id}`, {
			method: "PATCH",
			token: fixture.qa.token,
			body: { commit: true },
		});
		const qa = await inbox(fixture, fixture.qa);
		expect(kinds(qa.items)).toEqual([
			"import.finished",
			"review.pending_count",
		]);
		expect(
			qa.items.find((item) => item.kind === "import.finished")?.title,
		).toBe("Import finished: 2 created, 0 updated");
		expect(
			qa.items.find((item) => item.kind === "review.pending_count")?.title,
		).toBe("2 test case(s) waiting for review");
		expect(kinds((await inbox(fixture, fixture.admin)).items)).toEqual([
			"review.pending_count",
		]);
		expect((await inbox(fixture, fixture.developer)).items).toHaveLength(0);

		const developerOptIn = await fixture.call<{ subscribed: string[] }>(
			"/notifications/subscriptions",
			{
				method: "PUT",
				token: fixture.developer.token,
				body: { subscribed: ["review.pending_count"] },
			},
		);
		expect(developerOptIn.body.subscribed).toEqual(["review.pending_count"]);
		await fixture.call("/notifications/subscriptions", {
			method: "PUT",
			token: fixture.admin.token,
			body: { subscribed: [], unsubscribed: ["review.pending_count"] },
		});
		const first = batch.body.items[0];
		const caseId = (
			await fixture.call<ImportBatch>(`/test-cases/import/${batch.body.id}`, {
				token: fixture.qa.token,
			})
		).body.items[0]?.resultTestCaseId;
		expect(first).toBeDefined();
		await fixture.call(`/test-cases/${caseId}/approve`, {
			token: fixture.qa.token,
			body: {},
		});
		const developer = await inbox(fixture, fixture.developer);
		expect(developer.items.map((item) => item.title)).toEqual([
			"1 test case(s) waiting for review",
		]);
		expect(
			(await inbox(fixture, fixture.admin)).items.filter(
				(item) => item.kind === "review.pending_count",
			),
		).toHaveLength(1);
	});

	it("routes events through channel adapters without touching producers", async () => {
		const fixture = await createTestCaseFixture();
		let failNext = true;
		const delivered: string[] = [];
		const webhook: NotificationChannelAdapter = {
			kind: "webhook",
			deliver: async ({ event, channel }) => {
				if (failNext) {
					failNext = false;
					throw new Error("endpoint unavailable");
				}
				delivered.push(`${event.kind}:${channel?.id}`);
				return [{ recipientUserId: null, status: "delivered" }];
			},
		};
		registerNotificationAdapter(webhook);
		const [webhookChannel] = await fixture.db
			.insert(notificationChannels)
			.values({
				orgId: fixture.orgId,
				kind: "webhook",
				configJson: JSON.stringify({ url: "https://hooks.example.test/jl" }),
				filterJson: JSON.stringify({ kinds: ["run.finished"], tags: [] }),
			})
			.returning();
		const [slackChannel] = await fixture.db
			.insert(notificationChannels)
			.values({ orgId: fixture.orgId, kind: "slack" })
			.returning();
		if (!webhookChannel || !slackChannel) throw new Error("Expected channels");

		const event = await emitNotification(fixture.db, {
			orgId: fixture.orgId,
			kind: "run.finished",
			subjectType: "test_run",
			subjectId: "run-1",
			recipients: [fixture.qa.userId, "not-a-member"],
			payload: { outcome: "passed", testCaseKey: "TC-0009" },
		});
		if (!event) throw new Error("Expected event");
		const deliveries = async () =>
			fixture.db.query.notificationDeliveries.findMany({
				where: eq(notificationDeliveries.eventId, event.id),
			});
		// Producers deliver in-app only; the worker delivers to channels.
		expect((await deliveries()).map((row) => row.channelKind).sort()).toEqual([
			"in_app",
		]);
		await dispatchPendingNotifications(fixture.db, Date.now());
		const initial = await deliveries();
		expect(
			initial
				.map((row) => [row.channelKind, row.status, row.recipientUserId])
				.sort(),
		).toEqual(
			[
				["in_app", "delivered", fixture.qa.userId],
				["slack", "skipped", null],
				["webhook", "failed", null],
			].sort(),
		);
		const stored = await fixture.db.query.notificationEvents.findFirst({
			where: eq(notificationEvents.id, event.id),
		});
		expect(stored?.dispatchedAt).toBeNumber();

		await dispatchPendingNotifications(fixture.db, Date.now() + 61_000);
		expect(delivered).toEqual([`run.finished:${webhookChannel.id}`]);
		const retried = await fixture.db.query.notificationDeliveries.findFirst({
			where: and(
				eq(notificationDeliveries.eventId, event.id),
				eq(notificationDeliveries.channelKind, "webhook"),
			),
		});
		expect(retried).toMatchObject({ status: "delivered", attempts: 2 });
		// In-app delivery was not duplicated by the retry.
		expect(
			(await deliveries()).filter((row) => row.channelKind === "in_app"),
		).toHaveLength(1);
		const qa = await inbox(fixture, fixture.qa);
		expect(qa.items[0]?.title).toBe("TC-0009 passed");
	});

	it("stops retrying a channel after five attempts and never re-sends to it", async () => {
		const fixture = await createTestCaseFixture();
		let calls = 0;
		registerNotificationAdapter({
			kind: "email",
			deliver: async () => {
				calls += 1;
				return [
					{ recipientUserId: null, status: "failed", error: "mail relay down" },
				];
			},
		});
		const [channel] = await fixture.db
			.insert(notificationChannels)
			.values({ orgId: fixture.orgId, kind: "email" })
			.returning();
		if (!channel) throw new Error("Expected a channel");
		const event = await emitNotification(fixture.db, {
			orgId: fixture.orgId,
			kind: "run.finished",
			subjectType: "test_run",
			subjectId: "run-exhausted",
			payload: { outcome: "failed" },
		});
		if (!event) throw new Error("Expected event");
		let now = Date.now();
		for (let pass = 0; pass < 8; pass += 1) {
			await dispatchPendingNotifications(fixture.db, now);
			now += 61_000;
		}
		expect(calls).toBe(5);
		const delivery = await fixture.db.query.notificationDeliveries.findFirst({
			where: and(
				eq(notificationDeliveries.eventId, event.id),
				eq(notificationDeliveries.channelId, channel.id),
			),
		});
		expect(delivery).toMatchObject({
			status: "failed",
			attempts: 5,
			lastError: "mail relay down",
		});
	});
});
