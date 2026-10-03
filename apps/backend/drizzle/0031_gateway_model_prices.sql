-- Publish the complete price version without changing historical rates or organisation overrides.
INSERT OR IGNORE INTO `test_model_prices` (`id`, `org_id`, `model_id`, `input_usd_per_mtok`, `cached_input_usd_per_mtok`, `output_usd_per_mtok`, `version`, `effective_from`, `created_at`) VALUES
('seed-2026-10-03-anthropic-claude-opus-5-5', NULL, 'anthropic/claude-opus-5-5', 4, 0.2, 20, 'seed-2026-10-03', 1790985600000, 1790985600000),
('seed-2026-10-03-gateway-anthropic-claude-opus-5-5', NULL, 'gateway/anthropic/claude-opus-5-5', 4, 0.2, 20, 'seed-2026-10-03', 1790985600000, 1790985600000),
('seed-2026-10-03-claude-code-opus', NULL, 'claude-code/opus', 4, 0.2, 20, 'seed-2026-10-03', 1790985600000, 1790985600000),
('seed-2026-10-03-claude-code-claude-opus-5-5', NULL, 'claude-code/claude-opus-5-5', 4, 0.2, 20, 'seed-2026-10-03', 1790985600000, 1790985600000),
('seed-2026-10-03-anthropic-claude-sonnet-5-5', NULL, 'anthropic/claude-sonnet-5-5', 2, 0.2, 10, 'seed-2026-10-03', 1790985600000, 1790985600000),
('seed-2026-10-03-gateway-anthropic-claude-sonnet-5-5', NULL, 'gateway/anthropic/claude-sonnet-5-5', 2, 0.2, 10, 'seed-2026-10-03', 1790985600000, 1790985600000),
('seed-2026-10-03-claude-code-sonnet', NULL, 'claude-code/sonnet', 2, 0.2, 10, 'seed-2026-10-03', 1790985600000, 1790985600000),
('seed-2026-10-03-claude-code-claude-sonnet-5-5', NULL, 'claude-code/claude-sonnet-5-5', 2, 0.2, 10, 'seed-2026-10-03', 1790985600000, 1790985600000),
('seed-2026-10-03-anthropic-claude-haiku-4-5', NULL, 'anthropic/claude-haiku-4-5', 1, 0.1, 5, 'seed-2026-10-03', 1790985600000, 1790985600000),
('seed-2026-10-03-gateway-anthropic-claude-haiku-4-5', NULL, 'gateway/anthropic/claude-haiku-4-5', 1, 0.1, 5, 'seed-2026-10-03', 1790985600000, 1790985600000),
('seed-2026-10-03-claude-code-haiku', NULL, 'claude-code/haiku', 1, 0.1, 5, 'seed-2026-10-03', 1790985600000, 1790985600000),
('seed-2026-10-03-claude-code-claude-haiku-4-5', NULL, 'claude-code/claude-haiku-4-5', 1, 0.1, 5, 'seed-2026-10-03', 1790985600000, 1790985600000),
('seed-2026-10-03-zai-glm-5.3-flash', NULL, 'zai/glm-5.3-flash', 0.15, 0.03, 0.5, 'seed-2026-10-03', 1790985600000, 1790985600000),
('seed-2026-10-03-alibaba-qwen3.7-flash', NULL, 'alibaba/qwen3.7-flash', 0.03, 0.006, 0.13, 'seed-2026-10-03', 1790985600000, 1790985600000);
