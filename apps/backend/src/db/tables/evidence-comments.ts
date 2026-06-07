import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod/v4";

import { createUuidV7 } from "../uuid";
import { evidences } from "./evidences";
import { users } from "./users";

export const evidenceComments = sqliteTable(
	"evidence_comments",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		evidenceId: text("evidence_id")
			.notNull()
			.references(() => evidences.id, { onDelete: "cascade" }),
		createdBy: text("created_by")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		body: text("body").notNull(),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		index("evidence_comments_evidence_id_idx").on(table.evidenceId),
		index("evidence_comments_created_by_idx").on(table.createdBy),
		index("evidence_comments_created_at_idx").on(table.createdAt),
	],
);

export const createEvidenceCommentInputSchema = z.object({
	evidenceId: z.string().uuid(),
	createdBy: z.string().uuid(),
	body: z.string().trim().min(1).max(4000),
});
