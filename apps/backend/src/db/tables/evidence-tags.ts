import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { z } from "zod/v4";

import { createUuidV7 } from "../uuid";
import { evidences } from "./evidences";
import { organizations } from "./organizations";
import { users } from "./users";

export const organizationEvidenceTags = sqliteTable(
	"organization_evidence_tags",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		color: text("color").notNull(),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		uniqueIndex("organization_evidence_tags_org_name_unique").on(
			table.orgId,
			table.name,
		),
		index("organization_evidence_tags_org_idx").on(table.orgId),
	],
);

export const evidenceTagAssignments = sqliteTable(
	"evidence_tag_assignments",
	{
		evidenceId: text("evidence_id")
			.notNull()
			.references(() => evidences.id, { onDelete: "cascade" }),
		tagId: text("tag_id")
			.notNull()
			.references(() => organizationEvidenceTags.id, { onDelete: "cascade" }),
		assignedBy: text("assigned_by").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		primaryKey({ columns: [table.evidenceId, table.tagId] }),
		index("evidence_tag_assignments_tag_idx").on(table.tagId),
	],
);

export const createOrganizationEvidenceTagInputSchema = z.object({
	orgId: z.string().uuid(),
	name: z.string().trim().min(1).max(40),
	color: z.string().trim().min(1).max(40),
});
