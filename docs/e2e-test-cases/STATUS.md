# AI-driven E2E test cases: delivery status

Single progress log for `feat/e2e-test-cases`. One row per unit from handover §5, plus phase 2 (design.md §12) and ops units. `commit` is the last commit of the unit.

Status values: `todo`, `in progress`, `done`, `blocked: model key`, `blocked: <reason>`.

| Unit | Scope | Status | Commit | Notes |
| --- | --- | --- | --- | --- |
| 0.1 | Transcript schema and parser (`packages/shared/src/test-case.ts`) | done | 77f9a77 | `tests/test-case-contracts.test.ts` (33 tests): grammar, multi-case + dataset, stable ids, lossless round trip, 13 lint rules as data with fixes, macro expansion with version in key. Review pass: 12 findings fixed in 77f9a77. |
| 0.2 | Archive v4 + viewer-core step filter | done | 02684b3 | v3 upgraded on parse, extension writes v3 via `toExtensionWireArchive`; step chips + filter + seek in desktop and web; `PARITY-STEP-01` in parity checklist and `tests/review-e2e-parity.test.ts`. Review pass: 8 findings fixed in 02684b3. UI screenshot recorded with real runner evidence in 0.5. |
| 0.3 | Runner package skeleton, config chain, `mock:` provider | done | 4d00742 | `packages/e2e-runner`: plan → generated `case.e2e.ts`/`e2e.config.ts` (names only), `jl-e2e run/config/cache`, provider by id prefix incl. `mock:` and a claude-code bridge. Tests: `packages/e2e-runner/test` (28). Review pass: 13 findings fixed in 4d00742. |
| 0.4 | Cache store and reporter | done | 4d00742 | File `cache.store` in `.e2e/cache` with step mapping and rendered Playwright; progress reporter; run report from `report.json` + `ai-trace.json`. Browser test asserts run 2 replays all acts with 0 act calls. |
| 0.5 | Trace → archive v4 and upload | done | 4d00742 | Archive v4 with step annotations/tags, `--upload` to `/automation/evidences/zip`. Evidence: `evidence/0.5-web-viewer-steps-2.png` (step filter + seek in web viewer). Secret-leak grep in `browser/run-e2e.browser.test.ts`. run-report.json is not in the upload ZIP (endpoint accepts two files); it attaches in 1a.6. |
| 0.6 | Spike run against UAT, gate decision | done | (this commit) | PCF UAT, `claude-code/sonnet`: run 1 passed agent-driven, run 2 passed with 4/4 acts replayed and 0 act model calls; tokens and cost per step. Reports and screenshots in `docs/e2e-test-cases/evidence/0.6-*`. Gate: keep e2e (design §14, ADR 10). |
| 1a.1 | Backend tables and migration | todo | | |
| 1a.2 | Permissions and policy | todo | | |
| 1a.3 | Secrets service | todo | | |
| 1a.4 | Routes | todo | | |
| 1a.5 | Queue and worker contract | todo | | |
| 1a.6 | Run finalisation | todo | | |
| 1a.7 | Notifications (in-app) | todo | | |
| 1b.1 | Runner daemon | todo | | |
| 1b.2 | Backend-backed cache store | todo | | |
| 1b.3 | CLI extras (`env pull`, `export`, `push`, `--suite --wait --junit`) | todo | | |
| 1c.1 | Web: list and detail | todo | | |
| 1c.2 | Web: structured step editor | todo | | |
| 1c.3 | Web: run detail | todo | | |
| 1c.4 | Web: import, review queue, duplicate | todo | | |
| 1c.5 | Web: settings | todo | | |
| 1d.1 | Desktop queue client + `jittle-lamp://run` | todo | | |
| 1d.2 | MCP tools | todo | | |
| 1e | Docs (`docs/mcp.md`, runner setup, `.env.sample`) | todo | | |
| 2.1 | GitLab and GitHub webhooks with status reporting (§10c) | todo | | |
| 2.2 | Slack notification channel (§10b) | todo | | |
| 2.3 | Live view of cloud runs with take-over (§5.4) | todo | | |
| 2.4 | Agent notes per organisation | todo | | |
| 2.5 | GitHub Actions and GitLab CI templates | todo | | |
| ops.1 | Dockerfile and compose for the cloud runner pool | todo | | |
| ops.2 | systemd unit and `runner-setup.md` | todo | | |
| ops.3 | Evidence retention job running | todo | | |
| ops.4 | Model cost per organisation in the UI | todo | | |
| ops.5 | `docs/mcp.md` updated | todo | | |
| ops.6 | QA engineer onboarding guide | todo | | |
| ops.7 | `.env.sample` updated | todo | | |

## ADR amendments

None yet.

## Log

- 2026-10-03: phase 0 done. 0.3 to 0.5 in `packages/e2e-runner`; review found 13 issues (secret params in labels, JSON redaction, claude-code tools, exit-code and cancel mapping, built CLI paths), all fixed with tests. 0.6 spike on PCF UAT passed both runs; the example transcript needed two corrections for an HQ admin (recorded in design §14). Gate: keep Tester Army e2e.

- 2026-10-03: 0.1 done. Parser, serializer, lint and macros in `packages/shared/src/test-case.ts`; independent review found Vietnamese word-boundary, secret-scan and round-trip gaps, all fixed with regression tests.
- 2026-10-03: 0.2 done. Archive v4 (`recorder.kind`, `step` annotations, step tags on console/network). Review found a broken manual-upload path, lost step tags in the desktop catalog and a desktop highlight bug; fixed with tests.
- 2026-10-03: branch `feat/e2e-test-cases` created from `origin/feat/e2e-test-cases-design` (5214921). Baseline: typecheck, root tests (248), backend tests (85), MCP tests (27), backend lint and version check green. Dev-auth backend env generated with `bun run dev:test-auth:setup`.
