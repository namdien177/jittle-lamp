import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod/v4";

import { createUuidV7 } from "../uuid";
import { aiAccessTokens } from "./ai-access-tokens";
import { evidences } from "./evidences";
import { users } from "./users";

export const aiAccessTokenUsageLogs = sqliteTable(
	"ai_access_token_usage_logs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		tokenId: text("token_id")
			.notNull()
			.references(() => aiAccessTokens.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		evidenceId: text("evidence_id").references(() => evidences.id, {
			onDelete: "set null",
		}),
		method: text("method").notNull(),
		path: text("path").notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		index("ai_access_token_usage_logs_token_id_idx").on(table.tokenId),
		index("ai_access_token_usage_logs_user_id_idx").on(table.userId),
		index("ai_access_token_usage_logs_evidence_id_idx").on(table.evidenceId),
		index("ai_access_token_usage_logs_created_at_idx").on(table.createdAt),
	],
);

export const createAiAccessTokenUsageLogInputSchema = z.object({
	tokenId: z.string().uuid(),
	userId: z.string().uuid(),
	evidenceId: z.string().uuid().nullable().optional(),
	method: z.string().trim().min(1),
	path: z.string().trim().min(1),
	ipAddress: z.string().trim().min(1).nullable().optional(),
	userAgent: z.string().trim().min(1).nullable().optional(),
	createdAt: z.number().int().optional(),
});
