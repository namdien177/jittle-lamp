UPDATE `organization_roles`
SET
    `permissions_json` = CASE
        WHEN instr(`permissions_json`, '"evidence.comment"') > 0 THEN
            replace(`permissions_json`, '"evidence.comment"', '"evidence.comment","evidence.create"')
        WHEN `permissions_json` = '[]' THEN
            '["evidence.create"]'
        ELSE
            substr(`permissions_json`, 1, length(`permissions_json`) - 1) || ',"evidence.create"]'
    END,
    `updated_at` = strftime('%s','now') * 1000
WHERE `key` = 'developer'
  AND instr(`permissions_json`, '"evidence.create"') = 0;
