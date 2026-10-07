import { describe, expect, it } from "bun:test";
import type { RunnerPool } from "@jittle-lamp/shared";
import { eq } from "drizzle-orm";
import { runnerWorkers } from "../src/db/schema";
import { createTestCaseFixture } from "./test-case-fixtures";

async function fixture() {
	const f = await createTestCaseFixture();
	const pools = await f.call<{ items: RunnerPool[] }>("/runner-pools", {
		token: f.admin.token,
	});
	const pool = pools.body.items.find((p) => p.kind === "cloud");
	if (!pool) throw new Error("Expected cloud pool");
	const token = await f.call<{ registrationToken: string }>(
		`/runner-pools/${pool.id}/registration-token`,
		{ token: f.admin.token, body: {} },
	);
	const registered = await f.call<{ workerToken: string; workerId: string }>(
		"/runner-pools/register",
		{
			token: token.body.registrationToken,
			body: {
				hostname: "managed-cloud",
				version: "1.0.0",
				capabilities: { managedUpdates: true },
			},
		},
	);
	return { ...f, pool, ...registered.body };
}

describe("managed cloud runner updates", () => {
	it("shows skew, requires management permission, drains and cancels without revoking credentials", async () => {
		const f = await fixture();
		const pools = await f.call<{ items: RunnerPool[] }>("/runner-pools", {
			token: f.admin.token,
		});
		expect(pools.body.items.find((p) => p.id === f.pool.id)).toMatchObject({
			serverVersion: "9.9.9",
			workers: [{ version: "1.0.0", versionSkew: true, managedUpdates: true }],
		});
		expect(
			(
				await f.call(`/runner-pools/${f.pool.id}/update`, {
					token: f.developer.token,
					body: {},
				})
			).status,
		).toBe(403);
		const update = await f.call<RunnerPool>(
			`/runner-pools/${f.pool.id}/update`,
			{ token: f.admin.token, body: {} },
		);
		expect(update.status).toBe(200);
		expect(update.body.targetVersion).toBe("9.9.9");
		const heartbeat = await f.call<{ updateId: number }>(
			"/runner-pools/heartbeat",
			{
				token: f.workerToken,
				body: {
					version: "1.0.0",
					managedUpdates: true,
					load: 1,
					drainingVersion: "9.9.9",
				},
			},
		);
		const plan = () =>
			f.call<{ ready: boolean; targetVersion: string | null }>(
				"/runner-pools/update-plan",
				{ token: f.workerToken },
			);
		expect((await plan()).body.ready).toBe(false);
		expect(
			(await f.call("/runner-pools/claim", { token: f.workerToken, body: {} }))
				.body,
		).toEqual({ run: null, exploration: null });
		await f.call("/runner-pools/heartbeat", {
			token: f.workerToken,
			body: {
				load: 0,
				drainingVersion: "9.9.9",
				drainingUpdateId: heartbeat.body.updateId,
			},
		});
		expect((await plan()).body.ready).toBe(true);
		await f.call(`/runner-pools/${f.pool.id}/update`, {
			token: f.admin.token,
			body: { cancel: true },
		});
		expect((await plan()).body.targetVersion).toBeNull();
		expect(
			(
				await f.call("/runner-pools/heartbeat", {
					token: f.workerToken,
					body: { version: "9.9.9" },
				})
			).status,
		).toBe(200);
		const after = await f.call<{ items: RunnerPool[] }>("/runner-pools", {
			token: f.admin.token,
		});
		expect(
			after.body.items.find((p) => p.id === f.pool.id)?.workers[0],
		).toMatchObject({ version: "9.9.9", versionSkew: false });
	});

	it("does not accept stale drain acknowledgements from a previous request", async () => {
		const f = await fixture();
		await f.call(`/runner-pools/${f.pool.id}/update`, {
			token: f.admin.token,
			body: {},
		});
		const hb = await f.call<{ updateId: number }>("/runner-pools/heartbeat", {
			token: f.workerToken,
			body: {},
		});
		await f.call("/runner-pools/heartbeat", {
			token: f.workerToken,
			body: {
				load: 0,
				drainingVersion: "9.9.9",
				drainingUpdateId: hb.body.updateId - 1,
			},
		});
		expect(
			(
				await f.call<{ ready: boolean }>("/runner-pools/update-plan", {
					token: f.workerToken,
				})
			).body.ready,
		).toBe(false);
		await f.db
			.update(runnerWorkers)
			.set({ lastHeartbeatAt: Date.now() - 60_000 })
			.where(eq(runnerWorkers.id, f.workerId));
		expect(
			(
				await f.call<{ ready: boolean }>("/runner-pools/update-plan", {
					token: f.workerToken,
				})
			).body.ready,
		).toBe(false);
		expect((await f.call("/runner-pools/update-plan")).status).toBe(401);
	});

	it("refuses update requests without a managed online worker", async () => {
		const f = await fixture();
		await f.call("/runner-pools/heartbeat", {
			token: f.workerToken,
			body: { managedUpdates: false },
		});
		expect(
			(
				await f.call(`/runner-pools/${f.pool.id}/update`, {
					token: f.admin.token,
					body: {},
				})
			).status,
		).toBe(409);
	});
	it("persists progress, rejects stale reports and verifies replacement heartbeats before completion", async () => {
		const f = await fixture();
		const update = await f.call<RunnerPool>(
			`/runner-pools/${f.pool.id}/update`,
			{ token: f.admin.token, body: {} },
		);
		const progress = update.body.updateProgress;
		if (!progress) throw new Error("Expected update progress");
		const report = (body: Record<string, unknown>, token = f.workerToken) =>
			f.call("/runner-pools/update-progress", {
				token,
				body: {
					updateId: progress.updateId,
					targetVersion: "9.9.9",
					phase: "downloading",
					...body,
				},
			});
		expect(
			(
				await report({
					downloadPercent: 42,
					downloadedBytes: 420,
					totalBytes: 1000,
				})
			).status,
		).toBe(200);
		const pools = await f.call<{ items: RunnerPool[] }>("/runner-pools", {
			token: f.admin.token,
		});
		expect(
			pools.body.items.find((item) => item.id === f.pool.id)?.updateProgress,
		).toMatchObject({
			phase: "downloading",
			downloadPercent: 42,
			totalBytes: 1000,
			startedAt: progress.startedAt,
		});
		expect((await report({ downloadPercent: 101 })).status).toBe(422);
		expect((await report({ updateId: progress.updateId - 1 })).status).toBe(
			409,
		);
		expect((await report({}, f.admin.token)).status).toBe(401);
		expect(
			(await report({ phase: "completed", replacementWorkerIds: [f.workerId] }))
				.status,
		).toBe(409);
		expect(
			(
				await report({
					phase: "completed",
					replacementWorkerIds: ["another-pool-worker"],
				})
			).status,
		).toBe(409);
		await f.call(`/runner-pools/${f.pool.id}/registration-token`, {
			token: f.admin.token,
			body: {},
		});
		const plan = await f.call<{ updateId: number }>(
			"/runner-pools/update-plan",
			{ token: f.workerToken },
		);
		expect(plan.body.updateId).toBe(progress.updateId);
		await f.call("/runner-pools/heartbeat", {
			token: f.workerToken,
			body: { version: "9.9.9", managedUpdates: true },
		});
		expect(
			(await report({ phase: "completed", replacementWorkerIds: [f.workerId] }))
				.status,
		).toBe(200);
		expect((await report({ phase: "downloading" })).status).toBe(409);
	});

	it("blocks cancellation during replacement and rejects reports after cancellation or retry", async () => {
		const f = await fixture();
		const update = await f.call<RunnerPool>(
			`/runner-pools/${f.pool.id}/update`,
			{ token: f.admin.token, body: {} },
		);
		const progress = update.body.updateProgress;
		if (!progress) throw new Error("Expected update progress");
		const body = {
			updateId: progress.updateId,
			targetVersion: "9.9.9",
			phase: "restarting",
		};
		expect(
			(
				await f.call("/runner-pools/update-progress", {
					token: f.workerToken,
					body,
				})
			).status,
		).toBe(200);
		expect(
			(
				await f.call(`/runner-pools/${f.pool.id}/update`, {
					token: f.admin.token,
					body: { cancel: true },
				})
			).status,
		).toBe(409);
		await f.call("/runner-pools/update-progress", {
			token: f.workerToken,
			body: { ...body, phase: "failed", errorCode: "RESTART_FAILED" },
		});
		const retry = await f.call<RunnerPool>(
			`/runner-pools/${f.pool.id}/update`,
			{ token: f.admin.token, body: {} },
		);
		expect(retry.body.updateProgress?.updateId).toBeGreaterThan(body.updateId);
		expect(
			(
				await f.call("/runner-pools/update-progress", {
					token: f.workerToken,
					body,
				})
			).status,
		).toBe(409);
		await f.call(`/runner-pools/${f.pool.id}/update`, {
			token: f.admin.token,
			body: { cancel: true },
		});
		expect(
			(
				await f.call("/runner-pools/update-progress", {
					token: f.workerToken,
					body: { ...body, updateId: retry.body.updateProgress?.updateId },
				})
			).status,
		).toBe(409);
	});
});
