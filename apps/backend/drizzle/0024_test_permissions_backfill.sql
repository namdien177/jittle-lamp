-- Backfill the test case permissions (design.md §6) into stored default roles of existing
-- organisations. Only adds the new values; customised evidence permissions are kept.
UPDATE `organization_roles` SET `permissions_json` = (
  SELECT json_group_array(`value`) FROM (
    SELECT `value` FROM json_each(`organization_roles`.`permissions_json`)
    UNION
    SELECT `value` FROM json_each('["test_case.view", "test_run.create", "test_run.view", "test_config.use"]')
  )
), `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `key` = 'developer';
--> statement-breakpoint
UPDATE `organization_roles` SET `permissions_json` = (
  SELECT json_group_array(`value`) FROM (
    SELECT `value` FROM json_each(`organization_roles`.`permissions_json`)
    UNION
    SELECT `value` FROM json_each('["test_case.view", "test_case.create", "test_case.update", "test_case.approve", "test_case.delete", "test_run.create", "test_run.cancel", "test_run.cancel_any", "test_run.view", "test_config.use"]')
  )
), `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `key` = 'qa_engineer';
--> statement-breakpoint
UPDATE `organization_roles` SET `permissions_json` = (
  SELECT json_group_array(`value`) FROM (
    SELECT `value` FROM json_each(`organization_roles`.`permissions_json`)
    UNION
    SELECT `value` FROM json_each('["test_case.view", "test_case.create", "test_case.update", "test_case.approve", "test_case.delete", "test_run.create", "test_run.cancel", "test_run.cancel_any", "test_run.view", "test_config.manage", "test_config.use"]')
  )
), `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `key` = 'moderator';
--> statement-breakpoint
UPDATE `organization_roles` SET `permissions_json` = (
  SELECT json_group_array(`value`) FROM (
    SELECT `value` FROM json_each(`organization_roles`.`permissions_json`)
    UNION
    SELECT `value` FROM json_each('["test_case.view", "test_case.create", "test_case.update", "test_case.approve", "test_case.delete", "test_run.create", "test_run.cancel", "test_run.cancel_any", "test_run.view", "test_config.manage", "test_config.use"]')
  )
), `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `key` = 'admin';
