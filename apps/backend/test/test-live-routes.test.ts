import { describe, expect, it } from "bun:test";
import type {
	ClaimedRun,
	CreateTestRunResponse,
	LiveControlResponse,
	LiveState,
	TestRunDetail,
} from "@jittle-lamp/shared";

import { and, eq } from "drizzle-orm";

import { organizationActivityLogs, testRuns } from "../src/db/schema";
import { HIDDEN_FRAME_JPEG } from "../src/services/live-hidden-frame";
import {
	createLiveHub,
	jpegDimensions,
	LIVE_FRAME_HIDDEN_CONTENT_TYPE,
	LIVE_FRAME_MAX_BYTES,
	LIVE_TAKEOVER_TTL_MS,
	type LiveHub,
} from "../src/services/test-live";
import {
	createTestCaseFixture,
	FAKE_MODEL_KEY,
	FAKE_PASSWORD,
} from "./test-case-fixtures";
import {
	buildRunReport,
	registerRunner,
	seedRunnableCase,
} from "./test-run-fixtures";

// Smallest JPEG header the hub reads: SOI, SOF0 with 1440×900, EOI.
const jpeg = (width = 1440, height = 900, padding = 0) =>
	new Uint8Array([
		0xff,
		0xd8,
		0xff,
		0xc0,
		0x00,
		0x11,
		0x08,
		height >> 8,
		height & 0xff,
		width >> 8,
		width & 0xff,
		0x03,
		0x01,
		0x22,
		0x00,
		0x02,
		0x11,
		0x01,
		0x03,
		0x11,
		0x01,
		...new Array<number>(padding).fill(0),
		0xff,
		0xd9,
	]);

const setup = async (hub: LiveHub = createLiveHub()) => {
	const fixture = await createTestCaseFixture({
		dependencies: { liveHub: hub },
	});
	const { testCase } = await seedRunnableCase(fixture, {
		password: FAKE_PASSWORD,
		modelKey: FAKE_MODEL_KEY,
	});
	const runner = await registerRunner(fixture);
	const requested = await fixture.call<CreateTestRunResponse>(
		`/test-cases/${testCase.id}/runs`,
		{ token: fixture.developer.token, body: {} },
	);
	expect(requested.status).toBe(201);
	const claim = await fixture.call<{ run: ClaimedRun | null }>(
		"/runner-pools/claim",
		{ token: runner.workerToken, body: {} },
	);
	const claimed = claim.body.run;
	if (!claimed) throw new Error("Expected a claimed run");
	const runId = claimed.runId;
	const control = (after = -1) =>
		fixture.call<LiveControlResponse>(
			`/test-runs/${runId}/live/control?after=${after}`,
			{ token: claimed.runToken },
		);
	const putFrame = (bytes: Uint8Array, contentType = "image/jpeg") =>
		fixture.call(`/test-runs/${runId}/live/frame`, {
			method: "PUT",
			token: claimed.runToken,
			raw: Uint8Array.from(bytes).buffer,
			headers: { "content-type": contentType },
		});
	const takeover = (token: string, action: "start" | "stop") =>
		fixture.call<LiveState & { error?: { code: string } }>(
			`/test-runs/${runId}/live/takeover`,
			{ token, body: { action } },
		);
	const input = (token: string, events: unknown[]) =>
		fixture.call<{
			accepted: number;
			lastSeq: number | null;
			error?: { code: string };
		}>(`/test-runs/${runId}/live/input`, { token, body: { events } });
	return {
		hub,
		fixture,
		runId,
		claimed,
		control,
		putFrame,
		takeover,
		input,
	};
};

describe("live view routes", () => {
	it("reads JPEG dimensions from the SOF segment", () => {
		expect(jpegDimensions(jpeg(1280, 720))).toEqual({
			width: 1280,
			height: 720,
		});
		expect(jpegDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
	});

	it("streams frames to viewers with test_run.view while someone watches", async () => {
		const { fixture, runId, control, putFrame } = await setup();
		const outsider = await fixture.call(`/test-runs/${runId}/live/watch`, {
			token: null,
			body: {},
		});
		expect(outsider.status).toBe(401);

		// The runner's first control poll marks the run as live-capable.
		const first = await control();
		expect(first.status).toBe(200);
		expect(first.body).toEqual({
			live: false,
			takeover: false,
			takeoverBy: null,
			inputs: [],
			cancelRequested: false,
		});
		const badToken = await fixture.call(
			`/test-runs/${runId}/live/control?after=-1`,
			{ token: "jl_run_not-a-real-token" },
		);
		expect(badToken.status).toBe(401);

		const watched = await fixture.call<LiveState>(
			`/test-runs/${runId}/live/watch`,
			{ token: fixture.developer.token, body: {} },
		);
		expect(watched.status).toBe(200);
		expect(watched.body).toMatchObject({
			available: true,
			takeoverBy: null,
			frameAt: null,
		});
		expect((await control()).body.live).toBe(true);

		const missing = await fixture.call(`/test-runs/${runId}/live/frame`, {
			token: fixture.developer.token,
		});
		expect(missing.status).toBe(404);

		expect((await putFrame(jpeg(), "image/png")).status).toBe(415);
		expect(
			(await putFrame(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).status,
		).toBe(422);
		const tooLarge = await putFrame(jpeg(1440, 900, LIVE_FRAME_MAX_BYTES));
		expect(tooLarge.status).toBe(413);
		expect(tooLarge.body).toMatchObject({
			error: { code: "LIVE_FRAME_TOO_LARGE" },
		});
		const stored = await putFrame(jpeg());
		expect(stored.status).toBe(200);
		// Only the latest frame is kept.
		expect((await putFrame(jpeg(1280, 800))).status).toBe(200);

		const frame = await fixture.app.handle(
			new Request(`http://localhost/test-runs/${runId}/live/frame`, {
				headers: { authorization: `Bearer ${fixture.developer.token}` },
			}),
		);
		expect(frame.status).toBe(200);
		expect(frame.headers.get("content-type")).toBe("image/jpeg");
		expect(frame.headers.get("cache-control")).toBe("no-store");
		expect(frame.headers.get("x-frame-width")).toBe("1280");
		expect(new Uint8Array(await frame.arrayBuffer())).toEqual(jpeg(1280, 800));

		const detail = await fixture.call<TestRunDetail>(`/test-runs/${runId}`, {
			token: fixture.developer.token,
		});
		expect(detail.body.live).toMatchObject({
			available: true,
			takeoverBy: null,
			paused: false,
			viewport: { width: 1280, height: 800 },
		});
		expect(detail.body.live?.frameUrl).toStartWith(
			`/test-runs/${runId}/live/frame`,
		);

		// Another organisation cannot see the run at all.
		const otherOrg = await fixture.call(`/test-runs/${runId}/live/frame`, {
			token: (await fixture.member("admin", await otherOrganization(fixture)))
				.token,
		});
		expect(otherOrg.status).toBe(404);
	});

	it("allows one take-over holder: the requester or test_run.cancel_any", async () => {
		const { fixture, control, takeover, input } = await setup();
		await control();
		const otherDeveloper = await fixture.member("developer");

		const denied = await takeover(otherDeveloper.token, "start");
		expect(denied.status).toBe(403);
		const started = await takeover(fixture.developer.token, "start");
		expect(started.status).toBe(200);
		expect(started.body.takeoverBy).toBe(fixture.developer.userId);
		// Idempotent for the holder.
		expect((await takeover(fixture.developer.token, "start")).status).toBe(200);
		const held = await takeover(fixture.qa.token, "start");
		expect(held.status).toBe(409);
		expect(held.body.error?.code).toBe("LIVE_TAKEOVER_HELD");

		const state = await control();
		expect(state.body).toMatchObject({
			live: true,
			takeover: true,
			takeoverBy: fixture.developer.userId,
		});

		expect(
			(await input(fixture.qa.token, [{ kind: "press", key: "Enter" }])).status,
		).toBe(403);
		expect((await takeover(otherDeveloper.token, "stop")).status).toBe(403);

		// test_run.cancel_any can end someone else's take-over.
		const released = await takeover(fixture.qa.token, "stop");
		expect(released.status).toBe(200);
		expect(released.body.takeoverBy).toBeNull();
		expect((await control()).body.takeover).toBe(false);
		expect(
			(await input(fixture.developer.token, [{ kind: "press", key: "Enter" }]))
				.status,
		).toBe(403);
	});

	it("assigns increasing sequence numbers and caps the input queue", async () => {
		const { fixture, runId, claimed, control, takeover, input } = await setup();
		await control();
		await takeover(fixture.developer.token, "start");
		const first = await input(fixture.developer.token, [
			{ kind: "click", x: 120, y: 48 },
			{ kind: "type", text: "hello" },
		]);
		expect(first.status).toBe(200);
		expect(first.body).toEqual({ accepted: 2, lastSeq: 1 });
		const second = await input(fixture.developer.token, [
			{ kind: "scroll", x: 10, y: 10, deltaY: 300 },
		]);
		expect(second.body.lastSeq).toBe(2);
		const invalid = await input(fixture.developer.token, [
			{ kind: "type", text: "" },
		]);
		expect(invalid.status).toBe(422);

		const all = await control(-1);
		expect(all.body.inputs.map((event) => event.seq)).toEqual([0, 1, 2]);
		expect(all.body.inputs[0]).toMatchObject({
			kind: "click",
			x: 120,
			y: 48,
			button: "left",
			double: false,
		});
		// The runner acknowledges with `after`.
		const rest = await control(1);
		expect(rest.body.inputs.map((event) => event.seq)).toEqual([2]);

		const batch = Array.from({ length: 100 }, () => ({
			kind: "move",
			x: 1,
			y: 1,
		}));
		for (let index = 0; index < 4; index += 1) {
			expect((await input(fixture.developer.token, batch)).status).toBe(200);
		}
		const full = await input(fixture.developer.token, batch);
		expect(full.status).toBe(429);
		expect(full.body.error?.code).toBe("LIVE_INPUT_QUEUE_FULL");
		const caughtUp = await control(402);
		expect(caughtUp.body.inputs).toHaveLength(0);
		expect((await input(fixture.developer.token, batch)).status).toBe(200);

		// The runner reports the pause; the detail shows it.
		await fixture.call(`/test-runs/${runId}/progress`, {
			method: "PATCH",
			token: claimed.runToken,
			body: { status: "paused", steps: [] },
		});
		const paused = await fixture.call<TestRunDetail>(`/test-runs/${runId}`, {
			token: fixture.developer.token,
		});
		expect(paused.body.status).toBe("paused");
		expect(paused.body.live?.paused).toBe(true);

		// Finalising ends the live view and the take-over.
		await fixture.call(`/test-runs/${runId}/finalize`, {
			token: claimed.runToken,
			body: { report: buildRunReport(claimed), evidenceId: null },
		});
		const finished = await fixture.call<TestRunDetail>(`/test-runs/${runId}`, {
			token: fixture.developer.token,
		});
		expect(finished.body.live).toBeNull();
		const late = await takeover(fixture.developer.token, "start");
		expect(late.status).toBe(409);
		expect(late.body.error?.code).toBe("TEST_RUN_NOT_LIVE");
	});
});

const otherOrganization = async (
	fixture: Awaited<ReturnType<typeof createTestCaseFixture>>,
) => {
	const { organizations } = await import("../src/db/schema");
	const { ensureDefaultOrganizationRoles } = await import(
		"../src/services/organization-permissions"
	);
	const [org] = await fixture.db
		.insert(organizations)
		.values({ name: "Elsewhere", isPersonal: false })
		.returning({ id: organizations.id });
	if (!org) throw new Error("Expected organisation");
	await ensureDefaultOrganizationRoles(fixture.db, org.id);
	return org.id;
};

describe("live view review fixes", () => {
	it("releases a take-over whose holder went quiet and drops the input left behind", async () => {
		const { hub, fixture, runId, control, takeover, input } = await setup();
		await control();
		expect((await takeover(fixture.developer.token, "start")).status).toBe(200);
		expect(
			(await input(fixture.developer.token, [{ kind: "press", key: "Enter" }]))
				.status,
		).toBe(200);
		// The holder's watch calls are the heartbeat.
		await fixture.call(`/test-runs/${runId}/live/watch`, {
			token: fixture.developer.token,
			body: {},
		});
		expect((await control()).body.takeover).toBe(true);

		hub.touchHolder(runId, Date.now() - LIVE_TAKEOVER_TTL_MS - 1_000);
		const after = await control();
		expect(after.body).toMatchObject({
			takeover: false,
			takeoverBy: null,
			inputs: [],
		});
		const run = await fixture.db.query.testRuns.findFirst({
			where: eq(testRuns.id, runId),
		});
		expect(run?.liveTakeoverBy).toBeNull();
		const logged = await fixture.db.query.organizationActivityLogs.findMany({
			where: and(
				eq(organizationActivityLogs.organizationId, fixture.orgId),
				eq(organizationActivityLogs.action, "test_run.takeover_expired"),
			),
		});
		expect(logged).toHaveLength(1);
		expect(
			(await input(fixture.developer.token, [{ kind: "press", key: "Enter" }]))
				.status,
		).toBe(403);
	});

	it("keeps input sent with a release for the runner, but a new take-over starts without stale input", async () => {
		const { fixture, control, takeover, input } = await setup();
		await control();
		await takeover(fixture.developer.token, "start");
		await input(fixture.developer.token, [
			{ kind: "type", text: "last words" },
		]);
		await takeover(fixture.developer.token, "stop");
		// The runner reads input before state, so the release does not lose it.
		const released = await control(-1);
		expect(released.body.takeover).toBe(false);
		expect(released.body.inputs.map((event) => event.kind)).toEqual(["type"]);
		// Not acknowledged, then someone takes over again: the old input is gone.
		await takeover(fixture.qa.token, "start");
		expect((await control(-1)).body.inputs).toEqual([]);
	});

	it("serves a placeholder instead of frames once the runner reports a secret entry", async () => {
		const { fixture, runId, claimed, control, putFrame } = await setup();
		await control();
		await fixture.call(`/test-runs/${runId}/live/watch`, {
			token: fixture.developer.token,
			body: {},
		});
		expect((await putFrame(jpeg())).status).toBe(200);
		const hidden = await fixture.call(`/test-runs/${runId}/live/frame`, {
			method: "PUT",
			token: claimed.runToken,
			raw: new Uint8Array().buffer,
			headers: { "content-type": LIVE_FRAME_HIDDEN_CONTENT_TYPE },
		});
		expect(hidden.status).toBe(200);
		// A late frame captured before the secret never comes back.
		expect((await putFrame(jpeg(1280, 800))).status).toBe(200);
		const frame = await fixture.app.handle(
			new Request(`http://localhost/test-runs/${runId}/live/frame`, {
				headers: { authorization: `Bearer ${fixture.developer.token}` },
			}),
		);
		expect(frame.status).toBe(200);
		expect(frame.headers.get("content-type")).toBe("image/jpeg");
		expect(frame.headers.get("x-frame-hidden")).toBe("secret-entered");
		expect(new Uint8Array(await frame.arrayBuffer())).toEqual(
			HIDDEN_FRAME_JPEG,
		);
		const state = await fixture.call<LiveState>(
			`/test-runs/${runId}/live/watch`,
			{
				token: fixture.developer.token,
				body: {},
			},
		);
		expect(state.body.framesHidden).toBe(true);
		const detail = await fixture.call<TestRunDetail>(`/test-runs/${runId}`, {
			token: fixture.developer.token,
		});
		expect(detail.body.live?.framesHidden).toBe(true);
	});
});
