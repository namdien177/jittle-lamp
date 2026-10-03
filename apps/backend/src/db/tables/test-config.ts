import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { createUuidV7 } from "../uuid";
import { organizations } from "./organizations";
import { users } from "./users";

// Organisation configuration for AI-driven test cases (design.md §9, §10, §14).

const timestamps = {
	createdAt: integer("created_at")
		.notNull()
		.$defaultFn(() => Date.now()),
	updatedAt: integer("updated_at")
		.notNull()
		.$defaultFn(() => Date.now()),
};

// Per-organisation data keys for test credential secrets, wrapped by the server master key
// (JL_SECRETS_MASTER_KEY or another KeyProvider). Only services/test-config.ts reads them.
export const organizationDataKeys = sqliteTable(
	"organization_data_keys",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		keyVersion: integer("key_version").notNull(),
		provider: text("provider").notNull(),
		masterKeyId: text("master_key_id").notNull(),
		wrappedKey: text("wrapped_key").notNull(),
		status: text("status", { enum: ["active", "retired"] })
			.notNull()
			.default("active"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		retiredAt: integer("retired_at"),
	},
	(table) => [
		uniqueIndex("organization_data_keys_org_version_unique").on(
			table.orgId,
			table.keyVersion,
		),
		index("organization_data_keys_org_status_idx").on(
			table.orgId,
			table.status,
		),
	],
);

export const testEnvironments = sqliteTable(
	"test_environments",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		baseUrl: text("base_url").notNull(),
		variablesJson: text("variables_json").notNull().default("{}"),
		// `cloud`, `self-hosted:<pool name or id>` or a pool id.
		runnerPool: text("runner_pool").notNull().default("cloud"),
		agentInstructions: text("agent_instructions"),
		notes: text("notes"),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		...timestamps,
		deletedAt: integer("deleted_at"),
		deletedBy: text("deleted_by").references(() => users.id, {
			onDelete: "set null",
		}),
	},
	(table) => [
		uniqueIndex("test_environments_org_name_unique")
			.on(table.orgId, table.name)
			.where(sql`${table.deletedAt} is null`),
		index("test_environments_org_idx").on(table.orgId),
	],
);

export const testMacros = sqliteTable(
	"test_macros",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		paramsJson: text("params_json").notNull().default("[]"),
		transcript: text("transcript").notNull(),
		stepsJson: text("steps_json").notNull().default("[]"),
		version: integer("version").notNull().default(1),
		status: text("status", { enum: ["draft", "active"] })
			.notNull()
			.default("active"),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		...timestamps,
		deletedAt: integer("deleted_at"),
	},
	(table) => [
		uniqueIndex("test_macros_org_name_unique")
			.on(table.orgId, sql`lower(${table.name})`)
			.where(sql`${table.deletedAt} is null`),
		index("test_macros_org_idx").on(table.orgId),
		check(
			"test_macros_status_check",
			sql`${table.status} in ('draft', 'active')`,
		),
	],
);

export const testCredentials = sqliteTable(
	"test_credentials",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		profile: text("profile").notNull(),
		kind: text("kind", {
			enum: [
				"login",
				"model_key",
				"jira",
				"github_app",
				"gitlab_token",
				"slack_webhook",
			],
		})
			.notNull()
			.default("login"),
		environmentId: text("environment_id").references(
			() => testEnvironments.id,
			{ onDelete: "set null" },
		),
		fieldsJson: text("fields_json").notNull().default("{}"),
		// AES-256-GCM envelope of the secret fields object; never returned by any route.
		secretFieldsEnc: text("secret_fields_enc"),
		// Names only, so lists can show which secret fields exist without decrypting.
		secretFieldNamesJson: text("secret_field_names_json")
			.notNull()
			.default("[]"),
		keyVersion: integer("key_version").notNull().default(1),
		lastUsedAt: integer("last_used_at"),
		loginMacroId: text("login_macro_id").references(() => testMacros.id, {
			onDelete: "set null",
		}),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		...timestamps,
		deletedAt: integer("deleted_at"),
		deletedBy: text("deleted_by").references(() => users.id, {
			onDelete: "set null",
		}),
	},
	(table) => [
		uniqueIndex("test_credentials_org_profile_env_unique")
			.on(table.orgId, table.profile, sql`coalesce(${table.environmentId}, '')`)
			.where(sql`${table.deletedAt} is null`),
		index("test_credentials_org_idx").on(table.orgId),
		index("test_credentials_org_kind_idx").on(table.orgId, table.kind),
		check(
			"test_credentials_kind_check",
			sql`${table.kind} in ('login', 'model_key', 'jira', 'github_app', 'gitlab_token', 'slack_webhook')`,
		),
	],
);

export const organizationTestTags = sqliteTable(
	"organization_test_tags",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		namespace: text("namespace").notNull().default(""),
		name: text("name").notNull(),
		color: text("color").notNull(),
		description: text("description"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("organization_test_tags_org_ns_name_unique").on(
			table.orgId,
			table.namespace,
			table.name,
		),
		index("organization_test_tags_org_idx").on(table.orgId),
	],
);

export const testRunSettings = sqliteTable("test_run_settings", {
	orgId: text("org_id")
		.primaryKey()
		.references(() => organizations.id, { onDelete: "cascade" }),
	maxConcurrentRuns: integer("max_concurrent_runs").notNull().default(1),
	dedupeWindowSeconds: integer("dedupe_window_seconds").notNull().default(120),
	maxQueuedRuns: integer("max_queued_runs").notNull().default(20),
	maxQueuedPerCase: integer("max_queued_per_case").notNull().default(3),
	tokenBucketSize: integer("token_bucket_size").notNull().default(30),
	tokenBucketWindowSeconds: integer("token_bucket_window_seconds")
		.notNull()
		.default(600),
	dailyBudgetUsd: real("daily_budget_usd"),
	retentionFailedDays: integer("retention_failed_days").notNull().default(180),
	retentionPassedDays: integer("retention_passed_days").notNull().default(30),
	updatedBy: text("updated_by").references(() => users.id, {
		onDelete: "set null",
	}),
	updatedAt: integer("updated_at")
		.notNull()
		.$defaultFn(() => Date.now()),
});

// BYOK model settings (ADR 0002 decision 14). Provider keys are `model_key` credentials.
export const organizationModelSettings = sqliteTable(
	"organization_model_settings",
	{
		orgId: text("org_id")
			.primaryKey()
			.references(() => organizations.id, { onDelete: "cascade" }),
		actModel: text("act_model").notNull(),
		judgeModel: text("judge_model").notNull(),
		provider: text("provider").notNull(),
		keyCredentialId: text("key_credential_id").references(
			() => testCredentials.id,
			{ onDelete: "set null" },
		),
		keyLast4: text("key_last4"),
		// Key for the judge model's provider when it differs from the act provider (ADR 0002
		// amendment 2026-10-03). Null on rows saved before the amendment.
		judgeKeyCredentialId: text("judge_key_credential_id").references(
			() => testCredentials.id,
			{ onDelete: "set null" },
		),
		judgeKeyLast4: text("judge_key_last4"),
		// OPENAI_COMPATIBLE_BASE_URL for `openai-compatible/` models. Not a secret.
		baseUrl: text("base_url"),
		updatedBy: text("updated_by").references(() => users.id, {
			onDelete: "set null",
		}),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
);

// Phase 2 (design.md §2 "Agent notes"); schema now so the config response can carry it.
export const organizationAgentNotes = sqliteTable("organization_agent_notes", {
	orgId: text("org_id")
		.primaryKey()
		.references(() => organizations.id, { onDelete: "cascade" }),
	notes: text("notes").notNull().default(""),
	updatedBy: text("updated_by").references(() => users.id, {
		onDelete: "set null",
	}),
	updatedAt: integer("updated_at")
		.notNull()
		.$defaultFn(() => Date.now()),
});

// Per-organisation human key sequence (TC-0001).
export const organizationTestCounters = sqliteTable(
	"organization_test_counters",
	{
		orgId: text("org_id")
			.primaryKey()
			.references(() => organizations.id, { onDelete: "cascade" }),
		nextCaseNumber: integer("next_case_number").notNull().default(1),
	},
);

// Token buckets for run requests per user or token (design.md §10.3).
export const testRateBuckets = sqliteTable(
	"test_rate_buckets",
	{
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		bucketKey: text("bucket_key").notNull(),
		tokens: real("tokens").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.orgId, table.bucketKey] })],
);
