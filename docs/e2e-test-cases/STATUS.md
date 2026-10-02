# AI-driven E2E test cases: delivery status

Single progress log for `feat/e2e-test-cases`. One row per unit from handover §5, plus phase 2 (design.md §12) and ops units. `commit` is the last commit of the unit.

Status values: `todo`, `in progress`, `done`, `blocked: model key`, `blocked: <reason>`.

| Unit | Scope | Status | Commit | Notes |
| --- | --- | --- | --- | --- |
| 0.1 | Transcript schema and parser (`packages/shared/src/test-case.ts`) | todo | | |
| 0.2 | Archive v4 + viewer-core step filter | todo | | |
| 0.3 | Runner package skeleton, config chain, `mock:` provider | todo | | |
| 0.4 | Cache store and reporter | todo | | |
| 0.5 | Trace → archive v4 and upload | todo | | |
| 0.6 | Spike run against UAT, gate decision | todo | | |
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

- 2026-10-03: branch `feat/e2e-test-cases` created from `origin/feat/e2e-test-cases-design` (5214921). Baseline: typecheck, root tests (248), backend tests (85), MCP tests (27), backend lint and version check green. Dev-auth backend env generated with `bun run dev:test-auth:setup`.
