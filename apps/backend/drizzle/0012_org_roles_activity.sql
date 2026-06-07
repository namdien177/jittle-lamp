ALTER TABLE `organizations` ADD `require_invitation_approval` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE `organization_roles`
(
    `id`               text PRIMARY KEY         NOT NULL,
    `organization_id`  text                     NOT NULL,
    `key`              text                     NOT NULL,
    `name`             text                     NOT NULL,
    `permissions_json` text                     NOT NULL,
    `is_system`        integer DEFAULT true     NOT NULL,
    `created_at`       integer                  NOT NULL,
    `updated_at`       integer                  NOT NULL,
    CONSTRAINT `organization_roles_key_check` CHECK (`key` in ('admin', 'moderator', 'developer', 'qa_engineer')),
    FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_roles_org_key_unique` ON `organization_roles` (`organization_id`, `key`);
--> statement-breakpoint
CREATE INDEX `organization_roles_org_idx` ON `organization_roles` (`organization_id`);
--> statement-breakpoint
CREATE TABLE `organization_activity_logs`
(
    `id`              text PRIMARY KEY NOT NULL,
    `organization_id` text             NOT NULL,
    `actor_user_id`   text,
    `action`          text             NOT NULL,
    `entity_type`     text             NOT NULL,
    `entity_id`       text,
    `message`         text             NOT NULL,
    `metadata_json`   text DEFAULT '{}' NOT NULL,
    `ip_address`      text,
    `created_at`      integer          NOT NULL,
    FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `organization_activity_logs_org_created_idx` ON `organization_activity_logs` (`organization_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `organization_activity_logs_org_action_idx` ON `organization_activity_logs` (`organization_id`, `action`);
--> statement-breakpoint
CREATE INDEX `organization_activity_logs_org_actor_idx` ON `organization_activity_logs` (`organization_id`, `actor_user_id`);
--> statement-breakpoint
INSERT INTO `organization_roles` (`id`, `organization_id`, `key`, `name`, `permissions_json`, `is_system`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-7' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       `id`,
       'admin',
       'Admin',
       '["evidence.view","evidence.download","evidence.comment","evidence.create","evidence.update.own","evidence.delete.own","evidence.move.own","evidence.update.any","evidence.delete.any","evidence.move.any","invitations.create","invitations.disable","join_requests.manage","roles.manage","members.assign_role","members.kick","activity.view"]',
       true,
       strftime('%s','now') * 1000,
       strftime('%s','now') * 1000
FROM `organizations`;
--> statement-breakpoint
INSERT INTO `organization_roles` (`id`, `organization_id`, `key`, `name`, `permissions_json`, `is_system`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-7' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       `id`,
       'moderator',
       'Moderator',
       '["evidence.view","evidence.download","evidence.comment","evidence.create","evidence.update.own","evidence.delete.own","evidence.move.own","evidence.update.any","evidence.delete.any","evidence.move.any","invitations.disable","join_requests.manage","activity.view"]',
       true,
       strftime('%s','now') * 1000,
       strftime('%s','now') * 1000
FROM `organizations`;
--> statement-breakpoint
INSERT INTO `organization_roles` (`id`, `organization_id`, `key`, `name`, `permissions_json`, `is_system`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-7' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       `id`,
       'developer',
       'Developer',
       '["evidence.view","evidence.download","evidence.comment"]',
       true,
       strftime('%s','now') * 1000,
       strftime('%s','now') * 1000
FROM `organizations`;
--> statement-breakpoint
INSERT INTO `organization_roles` (`id`, `organization_id`, `key`, `name`, `permissions_json`, `is_system`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-7' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
       `id`,
       'qa_engineer',
       'QA Engineer',
       '["evidence.view","evidence.download","evidence.comment","evidence.create","evidence.update.own","evidence.delete.own","evidence.move.own"]',
       true,
       strftime('%s','now') * 1000,
       strftime('%s','now') * 1000
FROM `organizations`;
--> statement-breakpoint
UPDATE `organization_members`
SET `role` = CASE `role`
    WHEN 'owner' THEN 'admin'
    WHEN 'member' THEN 'developer'
    ELSE `role`
END;
--> statement-breakpoint
ALTER TABLE `organization_invitations` RENAME TO `organization_invitations__old`;
--> statement-breakpoint
CREATE TABLE `organization_invitations`
(
    `id`              text PRIMARY KEY             NOT NULL,
    `organization_id` text                         NOT NULL,
    `email`           text                         NOT NULL,
    `role`            text DEFAULT 'developer'     NOT NULL,
    `token_hash`      text                         NOT NULL,
    `status`          text DEFAULT 'pending'       NOT NULL,
    `expires_at`      integer                      NOT NULL,
    `invited_by`      text                         NOT NULL,
    `accepted_by`     text,
    `accepted_at`     integer,
    `revoked_at`      integer,
    `created_at`      integer                      NOT NULL,
    `updated_at`      integer                      NOT NULL,
    CONSTRAINT `organization_invitations_status_check` CHECK (`status` in ('pending', 'accepted', 'revoked', 'expired')),
    CONSTRAINT `organization_invitations_role_check` CHECK (`role` in ('admin', 'moderator', 'developer', 'qa_engineer')),
    FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
    FOREIGN KEY (`accepted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `organization_invitations` (`id`, `organization_id`, `email`, `role`, `token_hash`, `status`, `expires_at`, `invited_by`, `accepted_by`, `accepted_at`, `revoked_at`, `created_at`, `updated_at`)
SELECT `id`, `organization_id`, `email`,
       CASE `role` WHEN 'owner' THEN 'admin' WHEN 'member' THEN 'developer' ELSE `role` END,
       `token_hash`, `status`, `expires_at`, `invited_by`, `accepted_by`, `accepted_at`, `revoked_at`, `created_at`, `updated_at`
FROM `organization_invitations__old`;
--> statement-breakpoint
DROP TABLE `organization_invitations__old`;
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_invitations_token_hash_unique` ON `organization_invitations` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `organization_invitations_org_idx` ON `organization_invitations` (`organization_id`);
--> statement-breakpoint
CREATE INDEX `organization_invitations_email_idx` ON `organization_invitations` (`email`);
--> statement-breakpoint
CREATE INDEX `organization_invitations_status_idx` ON `organization_invitations` (`status`);
--> statement-breakpoint
ALTER TABLE `organization_invitation_codes` RENAME TO `organization_invitation_codes__old`;
--> statement-breakpoint
CREATE TABLE `organization_invitation_codes`
(
    `id`                        text PRIMARY KEY              NOT NULL,
    `organization_id`           text                          NOT NULL,
    `label`                     text                          NOT NULL,
    `role`                      text DEFAULT 'developer'      NOT NULL,
    `code_hash`                 text                          NOT NULL,
    `password_hash`             text,
    `email_domain`              text,
    `expires_at`                integer,
    `guest_expires_after_days`  integer,
    `locked_at`                 integer,
    `created_by`                text                          NOT NULL,
    `created_at`                integer                       NOT NULL,
    `updated_at`                integer                       NOT NULL,
    CONSTRAINT `organization_invitation_codes_role_check` CHECK (`role` in ('admin', 'moderator', 'developer', 'qa_engineer')),
    CONSTRAINT `organization_invitation_codes_guest_days_check` CHECK (`guest_expires_after_days` is null or `guest_expires_after_days` > 0),
    FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `organization_invitation_codes` (`id`, `organization_id`, `label`, `role`, `code_hash`, `password_hash`, `email_domain`, `expires_at`, `guest_expires_after_days`, `locked_at`, `created_by`, `created_at`, `updated_at`)
SELECT `id`, `organization_id`, `label`,
       CASE `role` WHEN 'member' THEN 'developer' ELSE `role` END,
       `code_hash`, `password_hash`, `email_domain`, `expires_at`, `guest_expires_after_days`, `locked_at`, `created_by`, `created_at`, `updated_at`
FROM `organization_invitation_codes__old`;
--> statement-breakpoint
DROP TABLE `organization_invitation_codes__old`;
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_invitation_codes_code_hash_unique` ON `organization_invitation_codes` (`code_hash`);
--> statement-breakpoint
CREATE INDEX `organization_invitation_codes_org_idx` ON `organization_invitation_codes` (`organization_id`);
--> statement-breakpoint
CREATE INDEX `organization_invitation_codes_locked_idx` ON `organization_invitation_codes` (`locked_at`);
--> statement-breakpoint
CREATE TABLE `organization_join_requests`
(
    `id`                 text PRIMARY KEY          NOT NULL,
    `organization_id`    text                      NOT NULL,
    `user_id`            text                      NOT NULL,
    `invitation_code_id` text,
    `requested_role`     text DEFAULT 'developer'  NOT NULL,
    `status`             text DEFAULT 'pending'    NOT NULL,
    `reviewed_by`        text,
    `reviewed_at`        integer,
    `created_at`         integer                   NOT NULL,
    `updated_at`         integer                   NOT NULL,
    CONSTRAINT `organization_join_requests_status_check` CHECK (`status` in ('pending', 'approved', 'rejected')),
    CONSTRAINT `organization_join_requests_role_check` CHECK (`requested_role` in ('admin', 'moderator', 'developer', 'qa_engineer')),
    FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (`invitation_code_id`) REFERENCES `organization_invitation_codes`(`id`) ON UPDATE no action ON DELETE set null,
    FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_join_requests_pending_user_unique` ON `organization_join_requests` (`organization_id`, `user_id`) WHERE `status` = 'pending';
--> statement-breakpoint
CREATE INDEX `organization_join_requests_org_status_idx` ON `organization_join_requests` (`organization_id`, `status`);
