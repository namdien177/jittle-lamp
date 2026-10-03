import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { createUuidV7 } from "../uuid";
import { organizations } from "./organizations";
import { testCases } from "./test-cases";
import { testEnvironments } from "./test-config";
import { runnerPools } from "./test-runs";
import { users } from "./users";

// Import batches and their items (design.md §7 "Import pipeline").

const timestamps = {
	createdAt: integer("created_at")
		.notNull()
		.$defaultFn(() => Date.now()),
	updatedAt: integer("updated_at")
		.notNull()
		.$defaultFn(() => Date.now()),
};

export const testImportBatches = sqliteTable(
	"test_import_batches",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		sourceKind: text("source_kind", {
			enum: [
				"transcript-doc",
				"gherkin",
				"csv",
				"xlsx",
				"jira",
				"ai-generation",
				"instructions",
			],
		}).notNull(),
		fileName: text("file_name"),
		fileArtifactId: text("file_artifact_id"),
		mappingJson: text("mapping_json").notNull().default("{}"),
		optionsJson: text("options_json").notNull().default("{}"),
		status: text("status", {
			enum: ["parsing", "ready", "committing", "done", "error"],
		})
			.notNull()
			.default("parsing"),
		total: integer("total").notNull().default(0),
		created: integer("created").notNull().default(0),
		updated: integer("updated").notNull().default(0),
		skipped: integer("skipped").notNull().default(0),
		errors: integer("errors").notNull().default(0),
		error: text("error"),
		...timestamps,
		finishedAt: integer("finished_at"),
	},
	(table) => [
		index("test_import_batches_org_created_idx").on(
			table.orgId,
			table.createdAt,
		),
	],
);

export const testImportItems = sqliteTable(
	"test_import_items",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		batchId: text("batch_id")
			.notNull()
			.references(() => testImportBatches.id, { onDelete: "cascade" }),
		ordinal: integer("ordinal").notNull(),
		externalId: text("external_id"),
		title: text("title").notNull().default(""),
		transcript: text("transcript").notNull().default(""),
		sourceJson: text("source_json"),
		parsedJson: text("parsed_json"),
		lintJson: text("lint_json").notNull().default("[]"),
		similarJson: text("similar_json").notNull().default("[]"),
		decision: text("decision", {
			enum: ["create", "update", "skip", "merge"],
		})
			.notNull()
			.default("create"),
		state: text("state", {
			enum: ["pending", "ready", "committed", "skipped", "error"],
		})
			.notNull()
			.default("pending"),
		resultTestCaseId: text("result_test_case_id").references(
			() => testCases.id,
			{ onDelete: "set null" },
		),
		error: text("error"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("test_import_items_batch_ordinal_unique").on(
			table.batchId,
			table.ordinal,
		),
	],
);

// An import item tried on a browser before review: a runner of the environment's pool runs
// `e2e explore` with the item's instructions and posts what the agent did.
export const testExplorations = sqliteTable(
	"test_explorations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		batchId: text("batch_id")
			.notNull()
			.references(() => testImportBatches.id, { onDelete: "cascade" }),
		itemId: text("item_id")
			.notNull()
			.references(() => testImportItems.id, { onDelete: "cascade" }),
		environmentId: text("environment_id").references(
			() => testEnvironments.id,
			{ onDelete: "set null" },
		),
		// The environment's pool reference; a pool created later adopts the exploration.
		runnerPool: text("runner_pool").notNull().default("cloud"),
		runnerPoolId: text("runner_pool_id").references(() => runnerPools.id, {
			onDelete: "set null",
		}),
		title: text("title").notNull(),
		instructions: text("instructions").notNull(),
		goal: text("goal").notNull(),
		status: text("status", {
			enum: ["queued", "running", "done", "failed"],
		})
			.notNull()
			.default("queued"),
		attempts: integer("attempts").notNull().default(0),
		workerId: text("worker_id"),
		leaseExpiresAt: integer("lease_expires_at"),
		resultJson: text("result_json"),
		error: text("error"),
		...timestamps,
		finishedAt: integer("finished_at"),
	},
	(table) => [
		index("test_explorations_pool_status_idx").on(
			table.runnerPoolId,
			table.status,
		),
		uniqueIndex("test_explorations_item_unique").on(table.itemId),
		index("test_explorations_batch_idx").on(table.batchId),
	],
);
