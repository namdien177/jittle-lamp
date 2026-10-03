import {
	type Notification,
	type NotificationKind,
	notificationKindSchema,
} from "@jittle-lamp/shared";
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod/v4";

import {
	notificationChannels,
	notificationDeliveries,
	notificationEvents,
	notificationReads,
	notificationSubscriptions,
	type OrganizationPermission,
	organizationMembers,
	testCases,
	testRunSubscribers,
	type testRuns,
	testRuns as testRunsTable,
} from "../db/schema";
import { getOrganizationRolePermissions } from "./organization-permissions";
import type { BackendDb } from "./user-provisioning";

// Notification bus (design.md §10b, ADR 0002 decision 16). Producers only call
// emitNotification; delivery runs per channel through adapters, so a Slack, email or webhook
// adapter can be registered later without touching any producer.

export type NotificationEventRow = typeof notificationEvents.$inferSelect;
export type NotificationChannelRow = typeof notificationChannels.$inferSelect;

export type DeliveryOutcome = {
	recipientUserId: string | null;
	status: "delivered" | "failed" | "skipped";
	error?: string;
};

export type NotificationChannelAdapter = {
	kind: "in_app" | "slack" | "email" | "webhook";
	deliver(input: {
		db: BackendDb;
		event: NotificationEventRow;
		// null for the implicit in_app channel every organisation has.
		channel: NotificationChannelRow | null;
		recipients: string[];
	}): Promise<DeliveryOutcome[]>;
};

// in_app: a delivery row per recipient is the notification; reads are tracked per user.
export const inAppChannelAdapter: NotificationChannelAdapter = {
	kind: "in_app",
	deliver: async ({ recipients }) =>
		recipients.map((recipientUserId) => ({
			recipientUserId,
			status: "delivered" as const,
		})),
};

const adapters = new Map<string, NotificationChannelAdapter>([
	["in_app", inAppChannelAdapter],
]);
// Adapters that need the app's secrets and fetch (Slack, outgoing webhook) are registered per
// database handle by createApp, so two apps in one process never share credentials.
const adaptersByDb = new WeakMap<
	BackendDb,
	Map<string, NotificationChannelAdapter>
>();

export const registerNotificationAdapter = (
	adapter: NotificationChannelAdapter,
	db?: BackendDb,
) => {
	if (!db) {
		adapters.set(adapter.kind, adapter);
		return;
	}
	const scoped = adaptersByDb.get(db) ?? new Map();
	scoped.set(adapter.kind, adapter);
	adaptersByDb.set(db, scoped);
};

export const notificationAdapterFor = (db: BackendDb, kind: string) =>
	adaptersByDb.get(db)?.get(kind) ?? adapters.get(kind);

// Kinds delivered to members holding a permission unless they opted out; every other kind goes
// to the users the producer names plus members who opted in.
const defaultAudience: Partial<
	Record<NotificationKind, OrganizationPermission>
> = {
	"review.pending_count": "test_case.approve",
	"runner.offline": "test_config.manage",
};

const membersWithPermission = async (
	db: BackendDb,
	orgId: string,
	permission: OrganizationPermission,
): Promise<string[]> => {
	const members = await db.query.organizationMembers.findMany({
		where: and(
			eq(organizationMembers.organizationId, orgId),
			isNull(organizationMembers.teamId),
		),
		columns: { userId: true, role: true },
	});
	const permissionsByRole = new Map<string, Set<OrganizationPermission>>();
	const out: string[] = [];
	for (const member of members) {
		let permissions = permissionsByRole.get(member.role);
		if (!permissions) {
			permissions = await getOrganizationRolePermissions(db, {
				organizationId: orgId,
				role: member.role,
			});
			permissionsByRole.set(member.role, permissions);
		}
		if (permissions.has(permission)) out.push(member.userId);
	}
	return out;
};

export const resolveRecipients = async (
	db: BackendDb,
	event: NotificationEventRow,
): Promise<string[]> => {
	const named = z
		.array(z.string())
		.catch([])
		.parse(JSON.parse(event.recipientsJson));
	const subscriptions = await db.query.notificationSubscriptions.findMany({
		where: and(
			eq(notificationSubscriptions.orgId, event.orgId),
			eq(notificationSubscriptions.kind, event.kind),
		),
	});
	const optedIn = subscriptions
		.filter((row) => row.enabled)
		.map((row) => row.userId);
	const optedOut = new Set(
		subscriptions.filter((row) => !row.enabled).map((row) => row.userId),
	);
	const permission = defaultAudience[event.kind as NotificationKind];
	const audience = permission
		? (await membersWithPermission(db, event.orgId, permission)).filter(
				(userId) => !optedOut.has(userId),
			)
		: [];
	const members = new Set(
		(
			await db.query.organizationMembers.findMany({
				where: eq(organizationMembers.organizationId, event.orgId),
				columns: { userId: true },
			})
		).map((member) => member.userId),
	);
	// Only current members of the organisation receive its notifications.
	return [...new Set([...named, ...optedIn, ...audience])].filter((userId) =>
		members.has(userId),
	);
};

const channelFilterSchema = z
	.object({
		kinds: z.array(z.string()).default([]),
		tags: z.array(z.string()).default([]),
	})
	.catch({ kinds: [], tags: [] });

// Tags of the test cases an event is about: the run's case, or every case of a batch.
export const eventTags = async (
	db: BackendDb,
	event: Pick<
		NotificationEventRow,
		"subjectType" | "subjectId" | "payloadJson"
	>,
): Promise<string[]> => {
	const payload = payloadSchema.parse(JSON.parse(event.payloadJson));
	let caseIds: string[] = [];
	if (event.subjectType === "test_run") {
		const caseId =
			typeof payload.testCaseId === "string" ? payload.testCaseId : null;
		if (caseId) caseIds = [caseId];
	} else if (event.subjectType === "test_run_batch") {
		const runIds = z
			.array(z.string())
			.catch([])
			.parse(payload.runIds ?? []);
		if (runIds.length > 0) {
			caseIds = (
				await db.query.testRuns.findMany({
					where: inArray(testRunsTable.id, runIds),
					columns: { testCaseId: true },
				})
			).map((run) => run.testCaseId);
		}
	}
	if (caseIds.length === 0) return [];
	const cases = await db.query.testCases.findMany({
		where: inArray(testCases.id, [...new Set(caseIds)]),
		columns: { tagsJson: true },
	});
	return [
		...new Set(
			cases.flatMap((row) =>
				z.array(z.string()).catch([]).parse(JSON.parse(row.tagsJson)),
			),
		),
	];
};

// Kinds and tags each match when empty; tags match when the event's cases carry any of them.
const channelMatches = async (
	channel: NotificationChannelRow,
	event: NotificationEventRow,
	tagsOf: () => Promise<string[]>,
) => {
	const filter = channelFilterSchema.parse(JSON.parse(channel.filterJson));
	if (filter.kinds.length > 0 && !filter.kinds.includes(event.kind)) {
		return false;
	}
	if (filter.tags.length === 0) return true;
	const wanted = new Set(filter.tags.map((tag) => tag.toLowerCase()));
	return (await tagsOf()).some((tag) => wanted.has(tag.toLowerCase()));
};

const recordOutcomes = async (
	db: BackendDb,
	event: NotificationEventRow,
	channel: { id: string | null; kind: string },
	outcomes: DeliveryOutcome[],
	now: number,
) => {
	for (const outcome of outcomes) {
		const values = {
			status: outcome.status,
			lastError: outcome.error ?? null,
			deliveredAt: outcome.status === "delivered" ? now : null,
			nextAttemptAt: outcome.status === "failed" ? now + 60_000 : null,
			updatedAt: now,
		};
		const existing = await db.query.notificationDeliveries.findFirst({
			where: and(
				eq(notificationDeliveries.eventId, event.id),
				eq(notificationDeliveries.channelKind, channel.kind),
				channel.id === null
					? isNull(notificationDeliveries.channelId)
					: eq(notificationDeliveries.channelId, channel.id),
				outcome.recipientUserId === null
					? isNull(notificationDeliveries.recipientUserId)
					: eq(notificationDeliveries.recipientUserId, outcome.recipientUserId),
			),
			columns: { id: true, attempts: true, status: true },
		});
		if (existing) {
			if (existing.status === "delivered") continue;
			await db
				.update(notificationDeliveries)
				.set({ ...values, attempts: existing.attempts + 1 })
				.where(eq(notificationDeliveries.id, existing.id));
			continue;
		}
		await db
			.insert(notificationDeliveries)
			.values({
				eventId: event.id,
				orgId: event.orgId,
				channelId: channel.id,
				channelKind: channel.kind,
				recipientUserId: outcome.recipientUserId,
				attempts: 1,
				createdAt: now,
				...values,
			})
			.onConflictDoNothing();
	}
};

// A channel delivery is retried at most this many times, a minute apart.
export const CHANNEL_MAX_ATTEMPTS = 5;

// In-app delivery: rows per recipient, written with the producer.
export const dispatchInApp = async (
	db: BackendDb,
	event: NotificationEventRow,
	now = Date.now(),
): Promise<void> => {
	const recipients = await resolveRecipients(db, event);
	const inApp = notificationAdapterFor(db, "in_app") ?? inAppChannelAdapter;
	await recordOutcomes(
		db,
		event,
		{ id: null, kind: "in_app" },
		await inApp.deliver({ db, event, channel: null, recipients }),
		now,
	);
	await db
		.update(notificationEvents)
		.set({ dispatchedAt: now })
		.where(eq(notificationEvents.id, event.id));
};

// Slack and webhook channels, from the maintenance worker only: a slow or unreachable chat
// service never holds up the request that produced the event. A channel that delivered, skipped,
// is waiting for its next attempt or used up its attempts is left alone.
export const dispatchChannels = async (
	db: BackendDb,
	event: NotificationEventRow,
	now = Date.now(),
): Promise<void> => {
	const channels = await db.query.notificationChannels.findMany({
		where: and(
			eq(notificationChannels.orgId, event.orgId),
			eq(notificationChannels.enabled, true),
		),
	});
	let tags: Promise<string[]> | null = null;
	const tagsOf = () => {
		tags ??= eventTags(db, event).catch(() => []);
		return tags;
	};
	let recipients: string[] | null = null;
	for (const channel of channels) {
		if (
			channel.kind === "in_app" ||
			!(await channelMatches(channel, event, tagsOf))
		)
			continue;
		const previous = await db.query.notificationDeliveries.findFirst({
			where: and(
				eq(notificationDeliveries.eventId, event.id),
				eq(notificationDeliveries.channelId, channel.id),
			),
			columns: { status: true, attempts: true, nextAttemptAt: true },
		});
		if (
			previous &&
			(previous.status !== "failed" ||
				previous.attempts >= CHANNEL_MAX_ATTEMPTS ||
				(previous.nextAttemptAt ?? 0) > now)
		) {
			continue;
		}
		const adapter = notificationAdapterFor(db, channel.kind);
		let outcomes: DeliveryOutcome[];
		if (!adapter) {
			outcomes = [
				{
					recipientUserId: null,
					status: "skipped",
					error: `No ${channel.kind} adapter is installed`,
				},
			];
		} else {
			try {
				recipients ??= await resolveRecipients(db, event);
				outcomes = await adapter.deliver({ db, event, channel, recipients });
			} catch (error) {
				outcomes = [
					{
						recipientUserId: null,
						status: "failed",
						error:
							error instanceof Error ? error.message.slice(0, 500) : "failed",
					},
				];
			}
		}
		await recordOutcomes(db, event, channel, outcomes, now);
	}
	await db
		.update(notificationEvents)
		.set({ channelsDispatchedAt: now })
		.where(eq(notificationEvents.id, event.id));
};

export const dispatchNotificationEvent = async (
	db: BackendDb,
	event: NotificationEventRow,
	now = Date.now(),
): Promise<void> => {
	await dispatchInApp(db, event, now);
	await dispatchChannels(db, event, now);
};

export type EmitNotificationInput = {
	orgId: string;
	kind: NotificationKind;
	subjectType: string;
	subjectId: string;
	actorId?: string | null;
	recipients?: readonly (string | null | undefined)[];
	payload?: Record<string, unknown>;
};

// Producers call this. In-app delivery happens inline; Slack and webhook channels are delivered
// by the maintenance worker (dispatchPendingNotifications). A delivery failure never fails the
// producer.
export const emitNotification = async (
	db: BackendDb,
	input: EmitNotificationInput,
): Promise<NotificationEventRow | null> => {
	try {
		const [event] = await db
			.insert(notificationEvents)
			.values({
				orgId: input.orgId,
				kind: input.kind,
				subjectType: input.subjectType,
				subjectId: input.subjectId,
				actorId: input.actorId ?? null,
				recipientsJson: JSON.stringify([
					...new Set(
						(input.recipients ?? []).filter(
							(value): value is string => typeof value === "string",
						),
					),
				]),
				payloadJson: JSON.stringify(input.payload ?? {}),
			})
			.returning();
		if (!event) return null;
		await dispatchInApp(db, event).catch(() => undefined);
		return event;
	} catch {
		return null;
	}
};

// Worker step: in-app delivery that did not happen inline, channel delivery of new events, and
// failed channel deliveries whose next attempt is due.
export const dispatchPendingNotifications = async (
	db: BackendDb,
	now = Date.now(),
): Promise<number> => {
	const pendingInApp = await db.query.notificationEvents.findMany({
		where: isNull(notificationEvents.dispatchedAt),
		orderBy: asc(notificationEvents.createdAt),
		limit: 200,
	});
	for (const event of pendingInApp) await dispatchInApp(db, event, now);
	const pendingChannels = await db.query.notificationEvents.findMany({
		where: isNull(notificationEvents.channelsDispatchedAt),
		orderBy: asc(notificationEvents.createdAt),
		limit: 200,
	});
	for (const event of pendingChannels) await dispatchChannels(db, event, now);
	const failed = await db.query.notificationDeliveries.findMany({
		where: and(
			eq(notificationDeliveries.status, "failed"),
			lte(notificationDeliveries.nextAttemptAt, now),
			sql`${notificationDeliveries.attempts} < ${CHANNEL_MAX_ATTEMPTS}`,
		),
		limit: 200,
	});
	const retried = new Set(pendingChannels.map((event) => event.id));
	for (const delivery of failed) {
		if (retried.has(delivery.eventId)) continue;
		retried.add(delivery.eventId);
		const event = await db.query.notificationEvents.findFirst({
			where: eq(notificationEvents.id, delivery.eventId),
		});
		if (event) await dispatchChannels(db, event, now);
	}
	return pendingInApp.length + retried.size;
};

// ---------------------------------------------------------------------------------------------
// Reading the in-app channel
// ---------------------------------------------------------------------------------------------

const payloadSchema = z.record(z.string(), z.unknown()).catch({});
const text = (value: unknown) => (typeof value === "string" ? value : null);

export const describeNotification = (
	event: Pick<NotificationEventRow, "kind" | "subjectId" | "payloadJson">,
): { title: string; body: string | null; url: string | null } => {
	const payload = payloadSchema.parse(JSON.parse(event.payloadJson));
	const caseLabel = [text(payload.testCaseKey), text(payload.testCaseTitle)]
		.filter(Boolean)
		.join(" ");
	switch (event.kind) {
		case "run.finished":
			return {
				title: `${caseLabel || "Test run"} ${payload.outcome === "passed" ? "passed" : payload.outcome === "failed" ? "failed" : "finished"}${payload.flaky ? " (flaky)" : ""}`,
				body: text(payload.summary),
				url: `/test-runs/${event.subjectId}`,
			};
		case "run.blocked":
			return {
				title: `${caseLabel || "Test run"} is blocked`,
				body: text(payload.blockedReason),
				url: `/test-runs/${event.subjectId}`,
			};
		case "batch.finished":
			return {
				title: `Run batch finished: ${payload.passed ?? 0} passed, ${payload.failed ?? 0} failed, ${payload.blocked ?? 0} blocked`,
				body: null,
				// The web app has no batch page: open the first failing run, else the first run.
				url: text(payload.focusRunId)
					? `/test-runs/${text(payload.focusRunId)}`
					: null,
			};
		case "import.finished":
			return {
				title: `Import finished: ${payload.created ?? 0} created, ${payload.updated ?? 0} updated`,
				body:
					Number(payload.errors ?? 0) > 0
						? `${payload.errors} item(s) failed`
						: null,
				url: `/test-cases/import/${event.subjectId}`,
			};
		case "review.pending_count":
			return {
				title: `${payload.count ?? 0} test case(s) waiting for review`,
				body: null,
				url: "/test-cases/review",
			};
		case "runner.offline":
			return {
				title:
					`Runner ${text(payload.hostname) ?? ""} in pool ${text(payload.poolName) ?? ""} is offline`.replace(
						/\s+/g,
						" ",
					),
				body: null,
				url: "/settings/test-cases/runner-pools",
			};
		default:
			return { title: event.kind, body: null, url: null };
	}
};

export const listInAppNotifications = async (
	db: BackendDb,
	input: { orgId: string; userId: string; limit: number; unreadOnly: boolean },
): Promise<{ items: Notification[]; unread: number }> => {
	const rows = await db
		.select({
			event: notificationEvents,
			readAt: notificationReads.readAt,
		})
		.from(notificationDeliveries)
		.innerJoin(
			notificationEvents,
			eq(notificationDeliveries.eventId, notificationEvents.id),
		)
		.leftJoin(
			notificationReads,
			and(
				eq(notificationReads.eventId, notificationEvents.id),
				eq(notificationReads.userId, input.userId),
			),
		)
		.where(
			and(
				eq(notificationDeliveries.orgId, input.orgId),
				eq(notificationDeliveries.channelKind, "in_app"),
				eq(notificationDeliveries.recipientUserId, input.userId),
				input.unreadOnly ? isNull(notificationReads.readAt) : undefined,
			),
		)
		.orderBy(desc(notificationEvents.createdAt))
		.limit(input.limit);
	const [unread] = await db
		.select({ value: sql<number>`count(*)` })
		.from(notificationDeliveries)
		.leftJoin(
			notificationReads,
			and(
				eq(notificationReads.eventId, notificationDeliveries.eventId),
				eq(notificationReads.userId, input.userId),
			),
		)
		.where(
			and(
				eq(notificationDeliveries.orgId, input.orgId),
				eq(notificationDeliveries.channelKind, "in_app"),
				eq(notificationDeliveries.recipientUserId, input.userId),
				isNull(notificationReads.readAt),
			),
		);
	return {
		items: rows.flatMap(({ event, readAt }) => {
			const kind = notificationKindSchema.safeParse(event.kind);
			if (!kind.success) return [];
			return [
				{
					id: event.id,
					kind: kind.data,
					subjectType: event.subjectType,
					subjectId: event.subjectId,
					...describeNotification(event),
					createdAt: event.createdAt,
					readAt: readAt ?? null,
				},
			];
		}),
		unread: Number(unread?.value ?? 0),
	};
};

export const markNotificationsRead = async (
	db: BackendDb,
	input: { orgId: string; userId: string; ids: string[]; all: boolean },
	now = Date.now(),
): Promise<void> => {
	const deliveries = await db.query.notificationDeliveries.findMany({
		where: and(
			eq(notificationDeliveries.orgId, input.orgId),
			eq(notificationDeliveries.channelKind, "in_app"),
			eq(notificationDeliveries.recipientUserId, input.userId),
			input.all
				? undefined
				: inArray(notificationDeliveries.eventId, input.ids),
		),
		columns: { eventId: true },
	});
	for (const delivery of deliveries) {
		await db
			.insert(notificationReads)
			.values({ userId: input.userId, eventId: delivery.eventId, readAt: now })
			.onConflictDoNothing();
	}
};

export const getNotificationSubscriptions = async (
	db: BackendDb,
	orgId: string,
	userId: string,
) => {
	const rows = await db.query.notificationSubscriptions.findMany({
		where: and(
			eq(notificationSubscriptions.orgId, orgId),
			eq(notificationSubscriptions.userId, userId),
		),
	});
	const parse = (kinds: string[]) =>
		kinds.flatMap((kind) => {
			const parsed = notificationKindSchema.safeParse(kind);
			return parsed.success ? [parsed.data] : [];
		});
	return {
		subscribed: parse(rows.filter((row) => row.enabled).map((row) => row.kind)),
		unsubscribed: parse(
			rows.filter((row) => !row.enabled).map((row) => row.kind),
		),
	};
};

export const saveNotificationSubscriptions = async (
	db: BackendDb,
	input: {
		orgId: string;
		userId: string;
		subscribed: NotificationKind[];
		unsubscribed: NotificationKind[];
	},
) => {
	await db
		.delete(notificationSubscriptions)
		.where(
			and(
				eq(notificationSubscriptions.orgId, input.orgId),
				eq(notificationSubscriptions.userId, input.userId),
			),
		);
	const rows = [
		...input.subscribed.map((kind) => ({ kind, enabled: true })),
		...input.unsubscribed
			.filter((kind) => !input.subscribed.includes(kind))
			.map((kind) => ({ kind, enabled: false })),
	];
	for (const row of rows) {
		await db.insert(notificationSubscriptions).values({
			orgId: input.orgId,
			userId: input.userId,
			kind: row.kind,
			enabled: row.enabled,
		});
	}
};

export const reviewQueueCount = async (db: BackendDb, orgId: string) => {
	const [row] = await db.all<{ count: number }>(
		sql`select count(*) as count from test_cases where org_id = ${orgId} and status = 'review' and deleted_at is null`,
	);
	return Number(row?.count ?? 0);
};

export const emitReviewPendingCount = async (
	db: BackendDb,
	orgId: string,
	actorId: string | null,
) =>
	emitNotification(db, {
		orgId,
		kind: "review.pending_count",
		subjectType: "organization",
		subjectId: orgId,
		actorId,
		payload: { count: await reviewQueueCount(db, orgId) },
	});

// ---------------------------------------------------------------------------------------------
// Producers for runs (design.md §10b): requester and everyone attached to the run
// ---------------------------------------------------------------------------------------------

export const emitRunOutcome = async (
	db: BackendDb,
	run: Pick<
		typeof testRuns.$inferSelect,
		| "id"
		| "orgId"
		| "testCaseId"
		| "createdBy"
		| "status"
		| "outcome"
		| "blockedReason"
		| "flaky"
		| "costUsd"
		| "durationMs"
		| "cancelledBy"
	>,
) => {
	const testCase = await db.query.testCases.findFirst({
		where: eq(testCases.id, run.testCaseId),
		columns: { key: true, title: true },
	});
	const subscribers = await db.query.testRunSubscribers.findMany({
		where: eq(testRunSubscribers.runId, run.id),
		columns: { userId: true },
	});
	const blocked = run.outcome === "blocked";
	return emitNotification(db, {
		orgId: run.orgId,
		kind: blocked ? "run.blocked" : "run.finished",
		subjectType: "test_run",
		subjectId: run.id,
		actorId: run.cancelledBy,
		recipients: [run.createdBy, ...subscribers.map((row) => row.userId)],
		payload: {
			testCaseId: run.testCaseId,
			testCaseKey: testCase?.key ?? null,
			testCaseTitle: testCase?.title ?? null,
			status: run.status,
			outcome: run.outcome,
			blockedReason: run.blockedReason,
			flaky: run.flaky,
			costUsd: run.costUsd,
			durationMs: run.durationMs,
		},
	});
};
