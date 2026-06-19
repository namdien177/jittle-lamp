import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod/v4";

import { createUuidV7 } from "../uuid";
import { organizations } from "./organizations";
import { users } from "./users";

export const automationApiTokens = sqliteTable(
	"automation_api_tokens",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		label: text("label").notNull(),
		tokenSecret: text("token_secret").notNull(),
		tokenPrefix: text("token_prefix").notNull(),
		scopes: text("scopes").notNull().default("evidence:upload"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		expiresAt: integer("expires_at"),
		lastUsedAt: integer("last_used_at"),
		revokedAt: integer("revoked_at"),
	},
	(table) => [
		index("automation_api_tokens_user_id_idx").on(table.userId),
		index("automation_api_tokens_org_id_idx").on(table.orgId),
		index("automation_api_tokens_token_secret_idx").on(table.tokenSecret),
		index("automation_api_tokens_expires_at_idx").on(table.expiresAt),
		index("automation_api_tokens_revoked_at_idx").on(table.revokedAt),
	],
);

export const createAutomationApiTokenInputSchema = z.object({
	userId: z.string().uuid(),
	orgId: z.string().uuid(),
	label: z.string().trim().min(1).max(80),
	expiresAt: z.number().int().nullable().optional(),
	scopes: z.string().trim().min(1).optional(),
});
