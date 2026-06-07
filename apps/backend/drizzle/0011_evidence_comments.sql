CREATE TABLE `evidence_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`evidence_id` text NOT NULL,
	`created_by` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `evidence_comments_evidence_id_idx` ON `evidence_comments` (`evidence_id`);
--> statement-breakpoint
CREATE INDEX `evidence_comments_created_by_idx` ON `evidence_comments` (`created_by`);
--> statement-breakpoint
CREATE INDEX `evidence_comments_created_at_idx` ON `evidence_comments` (`created_at`);
