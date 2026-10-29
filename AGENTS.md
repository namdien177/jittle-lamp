# Repository Guidelines

## Project Structure & Module Organization

This is a Bun workspace. Application code lives in `apps/`: `extension` for the Chromium extension, `desktop` for the native macOS app (a Rust/GPUI Cargo workspace: recorder, companion server, reviewer), `evidence-web` for the web viewer, `backend` for the Elysia API, and `mcp` for the local MCP server. Shared libraries live in `packages/`: `shared` contains session schemas, timeline logic and archive compaction, `viewer-core` contains viewer state helpers, `viewer-react` contains reusable React components, `ui` contains shared UI primitives, and `e2e-runner` runs test cases and builds their evidence. Cross-package tests are in root `tests/`; backend-specific tests are in `apps/backend/test/`. Static/sample assets live in `assets/`, docs in `docs/`, and release utilities in `scripts/release/`.

## Build, Test, and Development Commands

- `bun run build`: builds shared packages, viewer packages, extension, web viewer and MCP server. It does not build the desktop app.
- `bun run typecheck`: runs TypeScript over the full workspace.
- `bun test`: runs all Bun tests.
- `bun run --cwd apps/extension build`: rebuilds unpacked extension assets into `apps/extension/dist/`.
- `bun run --cwd apps/backend dev`: starts the backend in watch mode.
- `bun run --cwd apps/backend lint`: runs Biome checks for backend `src` and `test`.
- `bun run --cwd apps/desktop dev|build|test|bundle`: runs, builds, tests (`cargo test --workspace`) or bundles the macOS app. Needs rustup stable; `bun run build:desktop` is the explicit release build.
- `bun run clean`: removes generated dist/release artifacts.

## Coding Style & Naming Conventions

Use TypeScript ESM. Prefer explicit schema validation with Zod for persisted or cross-process payloads. Keep file names kebab-case for app modules (`network-detail.tsx`, `session-strategy.ts`) and tests as `*.test.ts`. Follow existing two-space JSON formatting; backend formatting/linting is managed by Biome (`bun run --cwd apps/backend lint:fix`). Keep browser-extension changes scoped across `background.ts`, `content.ts`, and schemas in `packages/shared/src/extension.ts`.

## Testing Guidelines

Tests use Bun’s test runner. Add focused unit or contract tests near the behavior boundary: schemas in `tests/extension-contracts.test.ts`, session archive behavior in `tests/session-contracts.test.ts`, archive compaction rules in `tests/archive-compaction.test.ts`, timeline labels/filtering in `tests/timeline.test.ts`, and recovery/background behavior in `tests/background-recovery.test.ts`. Run targeted tests during development, then `bun run typecheck` and `bun test` before opening a PR. The browser tests in `packages/e2e-runner/browser/` start real browsers and servers; a few fail when the whole suite runs at once, so rerun them alone (`bun test packages/e2e-runner/browser`) before treating a failure as real.

## Commit & Pull Request Guidelines

Recent commits use concise imperative subjects, often with a conventional scope, for example `feat(backend): cap daily uploads to the JittleLamp default storage`; release commits are `release: vX.Y.Z`. Keep commits focused and mention MR numbers only when GitLab adds them. `origin` is GitLab (`Front-End/jittle-lamp`); GitHub (`namdien177/jittle-lamp`) still builds and publishes releases, so a release tag must be pushed to GitHub too, after its `main` (see README, Release). PRs should include a short problem statement, implementation summary, tests run, and screenshots or recordings for UI/extension behavior changes.

## Security & Configuration Tips

Do not commit secrets, local certificates, `.env` files, or generated release bundles. Extension permission changes must update `apps/extension/scripts/manifest.ts` and be called out in the PR.

Session archives are shared through links, so anything a recorder captures must pass through `compactSessionArchive` (`packages/shared/src/archive-compaction.ts`), which masks secrets and drops low-value network data. When you capture a new kind of field or change those rules, extend the compaction and its tests, and bump `archiveCompactionVersion` so stored archives are compacted again when they are next opened.

Uploads to the JittleLamp default storage count against a daily per-organisation limit (`apps/backend/src/services/daily-upload-quota.ts`). New routes that write artifacts to it must call `assertDailyUploadQuota` inside their transaction.
