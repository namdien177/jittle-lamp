UPDATE `share_links` SET `expires_at` = 0 WHERE `revoked_at` IS NULL;
