ALTER TABLE `desktop_auth_flows` ADD `client` text DEFAULT 'desktop' NOT NULL;
--> statement-breakpoint
CREATE TABLE `device_sessions`
(
    `id`            text PRIMARY KEY NOT NULL,
    `clerk_user_id` text             NOT NULL,
    `client`        text             NOT NULL,
    `flow_id`       text,
    `scope`         text             NOT NULL,
    `expires_at`    integer          NOT NULL,
    `revoked_at`    integer,
    `last_seen_at`  integer,
    `created_at`    integer          NOT NULL,
    `updated_at`    integer          NOT NULL,
    CONSTRAINT `device_sessions_client_check` CHECK (`client` in ('desktop', 'extension'))
);
--> statement-breakpoint
CREATE INDEX `device_sessions_clerk_user_id_idx` ON `device_sessions` (`clerk_user_id`);--> statement-breakpoint
CREATE INDEX `device_sessions_client_idx` ON `device_sessions` (`client`);--> statement-breakpoint
CREATE INDEX `device_sessions_expires_at_idx` ON `device_sessions` (`expires_at`);
