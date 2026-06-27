CREATE TABLE `organization_evidence_tags`
(
    `id`         text PRIMARY KEY NOT NULL,
    `org_id`     text             NOT NULL,
    `name`       text             NOT NULL,
    `color`      text             NOT NULL,
    `created_at` integer          NOT NULL,
    `updated_at` integer          NOT NULL,
    FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_evidence_tags_org_name_unique` ON `organization_evidence_tags` (`org_id`, `name`);
--> statement-breakpoint
CREATE INDEX `organization_evidence_tags_org_idx` ON `organization_evidence_tags` (`org_id`);
--> statement-breakpoint
CREATE TABLE `evidence_tag_assignments`
(
    `evidence_id` text    NOT NULL,
    `tag_id`      text    NOT NULL,
    `assigned_by` text,
    `created_at`  integer NOT NULL,
    PRIMARY KEY (`evidence_id`, `tag_id`),
    FOREIGN KEY (`evidence_id`) REFERENCES `evidences`(`id`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (`tag_id`) REFERENCES `organization_evidence_tags`(`id`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (`assigned_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `evidence_tag_assignments_tag_idx` ON `evidence_tag_assignments` (`tag_id`);
--> statement-breakpoint
INSERT INTO `organization_evidence_tags` (`id`, `org_id`, `name`, `color`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-7' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       `id`,
       'Bug',
       '#ef4444',
       strftime('%s','now') * 1000,
       strftime('%s','now') * 1000
FROM `organizations`;
--> statement-breakpoint
INSERT INTO `organization_evidence_tags` (`id`, `org_id`, `name`, `color`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-7' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       `id`,
       'Smoke Test',
       '#f59e0b',
       strftime('%s','now') * 1000,
       strftime('%s','now') * 1000
FROM `organizations`;
--> statement-breakpoint
INSERT INTO `organization_evidence_tags` (`id`, `org_id`, `name`, `color`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-7' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       `id`,
       'Evidence',
       '#22c55e',
       strftime('%s','now') * 1000,
       strftime('%s','now') * 1000
FROM `organizations`;
--> statement-breakpoint
UPDATE `organization_roles`
SET `permissions_json` = substr(`permissions_json`, 1, length(`permissions_json`) - 1) || ',"evidence.tags.manage"]',
    `updated_at` = strftime('%s','now') * 1000
WHERE `key` IN ('admin', 'moderator')
  AND `permissions_json` NOT LIKE '%"evidence.tags.manage"%';
