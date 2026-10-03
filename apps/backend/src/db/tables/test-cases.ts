import { sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { createUuidV7 } from "../uuid";
import { evidences } from "./evidences";
import { organizations } from "./organizations";
import { testEnvironments } from "./test-config";
import { users } from "./users";

// Test cases, their versions, datasets, suites, cached step scripts and evidence links
// (design.md §3.1). The FTS5 index `test_cases_fts` is created by a raw SQL migration with
// triggers that keep it in sync with this table.

const timestamps = {
	createdAt: integer("created_at")
		.notNull()
		.$defaultFn(() => Date.now()),
	updatedAt: integer("updated_at")
		.notNull()
		.$defaultFn(() => Date.now()),
};

export const testCases = sqliteTable(
	"test_cases",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		updatedBy: text("updated_by").references(() => users.id, {
			onDelete: "set null",
		}),
		title: text("title").notNull(),
		description: text("description"),
		linksJson: text("links_json").notNull().default("[]"),
		tagsJson: text("tags_json").notNull().default("[]"),
		// Space-joined tags for the FTS index.
		tagsText: text("tags_text").notNull().default(""),
		environmentId: text("environment_id").references(
			() => testEnvironments.id,
			{ onDelete: "set null" },
		),
		transcript: text("transcript").notNull(),
		stepsJson: text("steps_json").notNull().default("[]"),
		transcriptVersion: integer("transcript_version").notNull().default(1),
		paramsSchemaJson: text("params_schema_json").notNull().default("[]"),
		datasetJson: text("dataset_json"),
		lintJson: text("lint_json").notNull().default("[]"),
		lintErrors: integer("lint_errors").notNull().default(0),
		lintWarnings: integer("lint_warnings").notNull().default(0),
		status: text("status", {
			enum: ["draft", "review", "active", "archived"],
		})
			.notNull()
			.default("draft"),
		statusReason: text("status_reason"),
		source: text("source", {
			enum: ["manual", "import", "ai", "duplicate", "recording"],
		})
			.notNull()
			.default("manual"),
		sourceRef: text("source_ref"),
		duplicatedFromId: text("duplicated_from_id").references(
			(): AnySQLiteColumn => testCases.id,
			{ onDelete: "set null" },
		),
		externalId: text("external_id"),
		fingerprint: text("fingerprint").notNull(),
		retries: integer("retries").notNull().default(0),
		...timestamps,
		deletedAt: integer("deleted_at"),
		deletedBy: text("deleted_by").references(() => users.id, {
			onDelete: "set null",
		}),
	},
	(table) => [
		uniqueIndex("test_cases_org_key_unique").on(table.orgId, table.key),
		index("test_cases_org_status_idx").on(table.orgId, table.status),
		index("test_cases_org_updated_idx").on(table.orgId, table.updatedAt),
		index("test_cases_org_fingerprint_idx").on(table.orgId, table.fingerprint),
		index("test_cases_org_external_idx").on(table.orgId, table.externalId),
		index("test_cases_duplicated_from_idx").on(table.duplicatedFromId),
		index("test_cases_environment_idx").on(table.environmentId),
		check(
			"test_cases_status_check",
			sql`${table.status} in ('draft', 'review', 'active', 'archived')`,
		),
		check(
			"test_cases_source_check",
			sql`${table.source} in ('manual', 'import', 'ai', 'duplicate', 'recording')`,
		),
	],
);

export const testCaseVersions = sqliteTable(
	"test_case_versions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		testCaseId: text("test_case_id")
			.notNull()
			.references(() => testCases.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		transcript: text("transcript").notNull(),
		stepsJson: text("steps_json").notNull(),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		changeNote: text("change_note"),
	},
	(table) => [
		uniqueIndex("test_case_versions_case_version_unique").on(
			table.testCaseId,
			table.version,
		),
	],
);

export const testCaseDatasets = sqliteTable(
	"test_case_datasets",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		testCaseId: text("test_case_id")
			.notNull()
			.references(() => testCases.id, { onDelete: "cascade" }),
		name: text("name"),
		columnsJson: text("columns_json").notNull().default("[]"),
		rowsJson: text("rows_json").notNull().default("[]"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		...timestamps,
	},
	(table) => [index("test_case_datasets_case_idx").on(table.testCaseId)],
);

export const testSuites = sqliteTable(
	"test_suites",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description"),
		filterJson: text("filter_json"),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		...timestamps,
		deletedAt: integer("deleted_at"),
	},
	(table) => [index("test_suites_org_idx").on(table.orgId)],
);

export const testSuiteMembers = sqliteTable(
	"test_suite_members",
	{
		suiteId: text("suite_id")
			.notNull()
			.references(() => testSuites.id, { onDelete: "cascade" }),
		testCaseId: text("test_case_id")
			.notNull()
			.references(() => testCases.id, { onDelete: "cascade" }),
		position: integer("position").notNull().default(0),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		primaryKey({ columns: [table.suiteId, table.testCaseId] }),
		index("test_suite_members_case_idx").on(table.testCaseId),
	],
);

// Cached step scripts: the runner's e2e cache entries, one active row per key hash and case
// (design.md §3.1, §5.2; handover 1b.2).
export const testStepScripts = sqliteTable(
	"test_step_scripts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		testCaseId: text("test_case_id")
			.notNull()
			.references(() => testCases.id, { onDelete: "cascade" }),
		stepId: text("step_id").notNull(),
		stepIdsJson: text("step_ids_json").notNull().default("[]"),
		instructionKey: text("instruction_key"),
		environmentId: text("environment_id").references(
			() => testEnvironments.id,
			{ onDelete: "set null" },
		),
		keyHash: text("key_hash").notNull(),
		entryJson: text("entry_json").notNull(),
		version: integer("version").notNull().default(1),
		actionsJson: text("actions_json"),
		endStateJson: text("end_state_json"),
		renderedCode: text("rendered_code").notNull().default(""),
		recordedFromRunId: text("recorded_from_run_id"),
		inheritedFromScriptId: text("inherited_from_script_id"),
		status: text("status", { enum: ["active", "stale", "invalid"] })
			.notNull()
			.default("active"),
		staleReason: text("stale_reason"),
		verifiedCount: integer("verified_count").notNull().default(0),
		lastReplayedAt: integer("last_replayed_at"),
		...timestamps,
	},
	(table) => [
		index("test_step_scripts_case_key_idx").on(table.testCaseId, table.keyHash),
		index("test_step_scripts_case_step_idx").on(
			table.testCaseId,
			table.stepId,
			table.status,
		),
		index("test_step_scripts_org_idx").on(table.orgId),
		check(
			"test_step_scripts_status_check",
			sql`${table.status} in ('active', 'stale', 'invalid')`,
		),
	],
);

export const testCaseEvidences = sqliteTable(
	"test_case_evidences",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		testCaseId: text("test_case_id")
			.notNull()
			.references(() => testCases.id, { onDelete: "cascade" }),
		evidenceId: text("evidence_id")
			.notNull()
			.references(() => evidences.id, { onDelete: "cascade" }),
		runId: text("run_id"),
		relation: text("relation", { enum: ["run", "import"] })
			.notNull()
			.default("run"),
		note: text("note"),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		uniqueIndex("test_case_evidences_case_evidence_unique").on(
			table.testCaseId,
			table.evidenceId,
		),
		index("test_case_evidences_evidence_idx").on(table.evidenceId),
		index("test_case_evidences_run_idx").on(table.runId),
	],
);
