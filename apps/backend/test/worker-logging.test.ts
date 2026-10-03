import { describe, expect, it } from "bun:test";

import { createDb } from "../src/db";
import { createTestSecrets } from "../src/services/test-config";
import { createTestRunQueueWorker } from "../src/services/test-run-queue";
import { createWebhookReportWorker } from "../src/services/test-webhooks";

// Background workers log their failures instead of swallowing them (deployment.md §8).

const captureLogger = () => {
	const entries: Array<{
		level: "warn" | "error";
		object: Record<string, unknown>;
		message: string;
	}> = [];
	return {
		entries,
		logger: {
			warn: (object: Record<string, unknown>, message: string) =>
				entries.push({ level: "warn", object, message }),
			error: (object: Record<string, unknown>, message: string) =>
				entries.push({ level: "error", object, message }),
		},
	};
};

// A database without the schema: every worker pass fails.
const brokenDb = () => {
	const db = createDb(
		`file:/tmp/jittle-lamp-no-schema-${crypto.randomUUID()}.db`,
	);
	if (!db) throw new Error("Expected database");
	return db;
};

const waitFor = async (check: () => boolean) => {
	for (let index = 0; index < 100 && !check(); index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

describe("background worker logging", () => {
	it("logs a failed test run queue sweep and keeps looping", async () => {
		const { entries, logger } = captureLogger();
		const stop = createTestRunQueueWorker({
			db: brokenDb(),
			logger,
			intervalMs: 5,
		}).start();
		await waitFor(() => entries.length >= 2);
		stop();
		expect(entries.length).toBeGreaterThanOrEqual(2);
		expect(entries[0]).toMatchObject({
			level: "error",
			message: "test run queue sweep failed",
		});
		expect(entries[0]?.object.err).toBeInstanceOf(Error);
	});

	it("logs a failed webhook report pass", async () => {
		const { entries, logger } = captureLogger();
		const db = brokenDb();
		const stop = createWebhookReportWorker({
			db,
			secrets: createTestSecrets({
				db,
				keyProvider: {
					id: "none",
					currentKeyId: () => "none",
					wrap: async () => "",
					unwrap: async () => new Uint8Array(),
				},
			}),
			fetch,
			outbound: { allowLoopback: false, allowHosts: [] },
			webOrigin: null,
			logger,
			intervalMs: 5,
		}).start();
		await waitFor(() => entries.length >= 1);
		stop();
		expect(entries[0]).toMatchObject({
			level: "error",
			message: "webhook report worker failed",
		});
	});
});
