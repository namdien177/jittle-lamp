import { describe, expect, it } from "bun:test";
import {
	defaultModelPrices,
	defaultPriceTableVersion,
} from "@jittle-lamp/shared";
import { createClient } from "@libsql/client";
import { and, eq, isNull } from "drizzle-orm";

import { createDb } from "../src/db";
import { testCases, testModelPrices } from "../src/db/schema";
import { ensureUserAndPersonalOrganization } from "../src/services/user-provisioning";
import { applyMigrations } from "./test-utils";

const testCaseTables = [
	"test_environments",
	"test_credentials",
	"organization_data_keys",
	"test_macros",
	"test_cases",
	"test_cases_fts",
	"test_case_versions",
	"test_case_datasets",
	"test_suites",
	"test_suite_members",
	"test_import_batches",
	"test_import_items",
	"test_step_scripts",
	"test_runs",
	"test_run_steps",
	"test_run_batches",
	"test_run_subscribers",
	"test_model_prices",
	"test_case_evidences",
	"organization_test_tags",
	"runner_pools",
	"runner_workers",
	"notification_events",
	"notification_channels",
	"notification_deliveries",
	"notification_reads",
	"notification_subscriptions",
	"test_run_settings",
	"organization_model_settings",
	"organization_test_counters",
	"test_rate_buckets",
	"webhook_endpoints",
	"webhook_deliveries",
	"organization_agent_notes",
];

describe("test case platform migrations", () => {
	it("apply on a clean database and create every table", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-tc-migrations-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);
		const client = createClient({ url: databaseUrl });
		const rows = await client.execute(
			"select name from sqlite_master where type in ('table', 'view')",
		);
		const names = new Set(rows.rows.map((row) => String(row.name)));
		for (const table of testCaseTables) {
			expect(names.has(table)).toBe(true);
		}
		const triggers = await client.execute(
			"select name from sqlite_master where type = 'trigger' and tbl_name = 'test_cases'",
		);
		expect(triggers.rows.map((row) => String(row.name)).sort()).toEqual([
			"test_cases_fts_after_delete",
			"test_cases_fts_after_insert",
			"test_cases_fts_after_update",
		]);
		client.close();
	});

	it("seeds global model prices and keeps the FTS index in sync", async () => {
		const databaseUrl = `file:/tmp/jittle-lamp-tc-fts-${crypto.randomUUID()}.db`;
		await applyMigrations(databaseUrl);
		const db = createDb(databaseUrl);
		if (!db) throw new Error("Expected database");

		const prices = await db.query.testModelPrices.findMany({
			where: and(
				isNull(testModelPrices.orgId),
				eq(testModelPrices.version, defaultPriceTableVersion),
			),
		});
		const priceValues = (rows: typeof prices) =>
			rows
				.map((price) => ({
					modelId: price.modelId,
					inputUsdPerMtok: price.inputUsdPerMtok,
					cachedInputUsdPerMtok: price.cachedInputUsdPerMtok,
					outputUsdPerMtok: price.outputUsdPerMtok,
				}))
				.sort((a, b) => a.modelId.localeCompare(b.modelId));
		expect(priceValues(prices)).toEqual(
			[...defaultModelPrices].sort((a, b) =>
				a.modelId.localeCompare(b.modelId),
			),
		);
		expect(
			prices.every((price) => price.effectiveFrom === Date.UTC(2026, 9, 3)),
		).toBe(true);
		const legacyPrices = await db.query.testModelPrices.findMany({
			where: and(
				isNull(testModelPrices.orgId),
				eq(testModelPrices.version, "seed-2026-09-25"),
			),
		});
		expect(priceValues(legacyPrices)).toEqual(
			defaultModelPrices
				.filter((price) =>
					/^(anthropic|gateway\/anthropic|claude-code)\//.test(price.modelId),
				)
				.sort((a, b) => a.modelId.localeCompare(b.modelId)),
		);
		expect(legacyPrices.every((price) => price.effectiveFrom === 0)).toBe(true);
		await applyMigrations(databaseUrl);
		expect(await db.query.testModelPrices.findMany()).toHaveLength(
			prices.length + legacyPrices.length,
		);

		const owner = await ensureUserAndPersonalOrganization(db, {
			clerkUserId: `user_fts_${crypto.randomUUID()}`,
			source: "clerk-callback",
			rawPayload: {},
		});
		const [created] = await db
			.insert(testCases)
			.values({
				orgId: owner.organizationId,
				key: "TC-0001",
				title: "Đăng xuất HQ admin",
				transcript: "[Act] mở menu tài khoản",
				fingerprint: "sha256:test",
				tagsText: "team:qa-pcf",
			})
			.returning({ id: testCases.id });
		if (!created) throw new Error("Expected test case");

		const client = createClient({ url: databaseUrl });
		const match = async (query: string) =>
			(
				await client.execute({
					sql: "select test_case_id from test_cases_fts where test_cases_fts match ?",
					args: [query],
				})
			).rows.map((row) => String(row.test_case_id));

		expect(await match('"đăng xu"')).toEqual([created.id]);
		expect(await match('"qa-pcf"')).toEqual([created.id]);

		await db
			.update(testCases)
			.set({ title: "Logout clears the email field" })
			.where(eq(testCases.id, created.id));
		expect(await match('"đăng xu"')).toEqual([]);
		expect(await match('"clears the"')).toEqual([created.id]);

		await db
			.update(testCases)
			.set({ deletedAt: Date.now() })
			.where(eq(testCases.id, created.id));
		expect(await match('"clears the"')).toEqual([]);
		client.close();
	});
});
