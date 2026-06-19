import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { z } from "zod/v4";

import { createUuidV7 } from "../uuid";
import { users } from "./users";

export const aiAccessTokens = sqliteTable(
	"ai_access_tokens",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		label: text("label").notNull(),
		tokenHash: text("token_hash"),
		tokenSecret: text("token_secret"),
		tokenVersion: text("token_version").notNull().default("v1"),
		tokenPrefix: text("token_prefix").notNull(),
		scopes: text("scopes").notNull().default("evidence:debug"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		expiresAt: integer("expires_at"),
		lastUsedAt: integer("last_used_at"),
		revokedAt: integer("revoked_at"),
	},
	(table) => [
		uniqueIndex("ai_access_tokens_token_hash_unique").on(table.tokenHash),
		index("ai_access_tokens_user_id_idx").on(table.userId),
		index("ai_access_tokens_expires_at_idx").on(table.expiresAt),
		index("ai_access_tokens_revoked_at_idx").on(table.revokedAt),
	],
);

export const createAiAccessTokenInputSchema = z.object({
	userId: z.string().uuid(),
	label: z.string().trim().min(1).max(80),
	expiresAt: z.number().int().nullable().optional(),
	scopes: z.string().trim().min(1).optional(),
	tokenVersion: z.enum(["v1", "v2"]).optional(),
});
