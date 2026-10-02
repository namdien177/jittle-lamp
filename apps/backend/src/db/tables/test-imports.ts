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
