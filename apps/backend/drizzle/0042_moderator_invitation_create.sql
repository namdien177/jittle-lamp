-- Moderators can now create invitation links. Add the permission to every stored moderator role;
-- other customised permissions are kept.
UPDATE `organization_roles` SET `permissions_json` = (
  SELECT json_group_array(`value`) FROM (
    SELECT `value` FROM json_each(`organization_roles`.`permissions_json`)
    UNION
    SELECT `value` FROM json_each('["invitations.create"]')
  )
), `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `key` = 'moderator';
