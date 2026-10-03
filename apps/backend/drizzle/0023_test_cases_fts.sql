-- Full-text index over test cases (design.md §3.1, §7): key, title, description, transcript and
-- tags with the trigram tokenizer, so substring and near-duplicate search work for any script.
-- Triggers keep it in sync with test_cases; soft-deleted cases leave the index.
CREATE VIRTUAL TABLE `test_cases_fts` USING fts5(`test_case_id` UNINDEXED, `org_id` UNINDEXED, `key`, `title`, `description`, `transcript`, `tags`, tokenize = 'trigram');
--> statement-breakpoint
CREATE TRIGGER `test_cases_fts_after_insert` AFTER INSERT ON `test_cases` WHEN NEW.`deleted_at` IS NULL BEGIN
  INSERT INTO `test_cases_fts` (`test_case_id`, `org_id`, `key`, `title`, `description`, `transcript`, `tags`)
  VALUES (NEW.`id`, NEW.`org_id`, NEW.`key`, NEW.`title`, coalesce(NEW.`description`, ''), NEW.`transcript`, NEW.`tags_text`);
END;
--> statement-breakpoint
CREATE TRIGGER `test_cases_fts_after_update` AFTER UPDATE ON `test_cases` BEGIN
  DELETE FROM `test_cases_fts` WHERE `test_case_id` = OLD.`id`;
  INSERT INTO `test_cases_fts` (`test_case_id`, `org_id`, `key`, `title`, `description`, `transcript`, `tags`)
  SELECT NEW.`id`, NEW.`org_id`, NEW.`key`, NEW.`title`, coalesce(NEW.`description`, ''), NEW.`transcript`, NEW.`tags_text`
  WHERE NEW.`deleted_at` IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `test_cases_fts_after_delete` AFTER DELETE ON `test_cases` BEGIN
  DELETE FROM `test_cases_fts` WHERE `test_case_id` = OLD.`id`;
END;
--> statement-breakpoint
-- Global model price defaults (org_id null) from @jittle-lamp/shared defaultModelPrices.
INSERT OR IGNORE INTO `test_model_prices` (`id`, `org_id`, `model_id`, `input_usd_per_mtok`, `cached_input_usd_per_mtok`, `output_usd_per_mtok`, `version`, `effective_from`, `created_at`) VALUES ('seed-anthropic-claude-opus-5-5', NULL, 'anthropic/claude-opus-5-5', 4, 0.2, 20, 'seed-2026-09-25', 0, 0);--> statement-breakpoint
INSERT OR IGNORE INTO `test_model_prices` (`id`, `org_id`, `model_id`, `input_usd_per_mtok`, `cached_input_usd_per_mtok`, `output_usd_per_mtok`, `version`, `effective_from`, `created_at`) VALUES ('seed-gateway-anthropic-claude-opus-5-5', NULL, 'gateway/anthropic/claude-opus-5-5', 4, 0.2, 20, 'seed-2026-09-25', 0, 0);--> statement-breakpoint
INSERT OR IGNORE INTO `test_model_prices` (`id`, `org_id`, `model_id`, `input_usd_per_mtok`, `cached_input_usd_per_mtok`, `output_usd_per_mtok`, `version`, `effective_from`, `created_at`) VALUES ('seed-claude-code-opus', NULL, 'claude-code/opus', 4, 0.2, 20, 'seed-2026-09-25', 0, 0);--> statement-breakpoint
INSERT OR IGNORE INTO `test_model_prices` (`id`, `org_id`, `model_id`, `input_usd_per_mtok`, `cached_input_usd_per_mtok`, `output_usd_per_mtok`, `version`, `effective_from`, `created_at`) VALUES ('seed-claude-code-claude-opus-5-5', NULL, 'claude-code/claude-opus-5-5', 4, 0.2, 20, 'seed-2026-09-25', 0, 0);--> statement-breakpoint
INSERT OR IGNORE INTO `test_model_prices` (`id`, `org_id`, `model_id`, `input_usd_per_mtok`, `cached_input_usd_per_mtok`, `output_usd_per_mtok`, `version`, `effective_from`, `created_at`) VALUES ('seed-anthropic-claude-sonnet-5-5', NULL, 'anthropic/claude-sonnet-5-5', 2, 0.2, 10, 'seed-2026-09-25', 0, 0);--> statement-breakpoint
INSERT OR IGNORE INTO `test_model_prices` (`id`, `org_id`, `model_id`, `input_usd_per_mtok`, `cached_input_usd_per_mtok`, `output_usd_per_mtok`, `version`, `effective_from`, `created_at`) VALUES ('seed-gateway-anthropic-claude-sonnet-5-5', NULL, 'gateway/anthropic/claude-sonnet-5-5', 2, 0.2, 10, 'seed-2026-09-25', 0, 0);--> statement-breakpoint
INSERT OR IGNORE INTO `test_model_prices` (`id`, `org_id`, `model_id`, `input_usd_per_mtok`, `cached_input_usd_per_mtok`, `output_usd_per_mtok`, `version`, `effective_from`, `created_at`) VALUES ('seed-claude-code-sonnet', NULL, 'claude-code/sonnet', 2, 0.2, 10, 'seed-2026-09-25', 0, 0);--> statement-breakpoint
INSERT OR IGNORE INTO `test_model_prices` (`id`, `org_id`, `model_id`, `input_usd_per_mtok`, `cached_input_usd_per_mtok`, `output_usd_per_mtok`, `version`, `effective_from`, `created_at`) VALUES ('seed-claude-code-claude-sonnet-5-5', NULL, 'claude-code/claude-sonnet-5-5', 2, 0.2, 10, 'seed-2026-09-25', 0, 0);--> statement-breakpoint
INSERT OR IGNORE INTO `test_model_prices` (`id`, `org_id`, `model_id`, `input_usd_per_mtok`, `cached_input_usd_per_mtok`, `output_usd_per_mtok`, `version`, `effective_from`, `created_at`) VALUES ('seed-anthropic-claude-haiku-4-5', NULL, 'anthropic/claude-haiku-4-5', 1, 0.1, 5, 'seed-2026-09-25', 0, 0);--> statement-breakpoint
INSERT OR IGNORE INTO `test_model_prices` (`id`, `org_id`, `model_id`, `input_usd_per_mtok`, `cached_input_usd_per_mtok`, `output_usd_per_mtok`, `version`, `effective_from`, `created_at`) VALUES ('seed-gateway-anthropic-claude-haiku-4-5', NULL, 'gateway/anthropic/claude-haiku-4-5', 1, 0.1, 5, 'seed-2026-09-25', 0, 0);--> statement-breakpoint
INSERT OR IGNORE INTO `test_model_prices` (`id`, `org_id`, `model_id`, `input_usd_per_mtok`, `cached_input_usd_per_mtok`, `output_usd_per_mtok`, `version`, `effective_from`, `created_at`) VALUES ('seed-claude-code-haiku', NULL, 'claude-code/haiku', 1, 0.1, 5, 'seed-2026-09-25', 0, 0);--> statement-breakpoint
INSERT OR IGNORE INTO `test_model_prices` (`id`, `org_id`, `model_id`, `input_usd_per_mtok`, `cached_input_usd_per_mtok`, `output_usd_per_mtok`, `version`, `effective_from`, `created_at`) VALUES ('seed-claude-code-claude-haiku-4-5', NULL, 'claude-code/claude-haiku-4-5', 1, 0.1, 5, 'seed-2026-09-25', 0, 0);
