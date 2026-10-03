# Jittle Lamp MCP

The local MCP server connects Codex and Claude Code to Jittle Lamp. Configure either an AI token or an automation API token through `JL_AI_TOKEN`. The token keeps its existing permissions.

| Token | Access |
| --- | --- |
| AI token, `jl_ai_`, with MCP access | Search, read, upload, rename, copy, move, delete, comment on, tag, download, and share evidence using the owner's current organisation memberships and permissions. Author test cases and queue test runs with the owner's `test_case.*` and `test_run.*` permissions. Organisation selection is supported. |
| Automation API token, `jl_api_` | Upload evidence ZIPs to the token's assigned organisation. List, read, update, import, and run test cases, and read or cancel runs, in that organisation within the token owner's role. Other user-account tools, including test configuration, credentials, and macros, return permission errors. |

Organisation settings, membership management, role changes, tag-definition changes, invitations, migrations, and credential management are unavailable. The test-case tools can list credential profile names but cannot read, create, or change credentials. Read-only AI tokens retain their existing debugging scope; installing the MCP does not grant additional access.

## Set up

Use the [one-command installer in the README](../README.md#install-from-terminal) to install the MCP and register Codex, Claude Code, or both. Its hidden Jittle Lamp token prompt accepts `jl_ai_` or `jl_api_` tokens. The installer works in macOS and Linux terminals, including when piped into Bash.

The installer builds a standalone bundle in `~/.local/share/jittle-lamp/mcp`, respecting `XDG_DATA_HOME` when set. It uses Bun 1.3.11 or newer from your PATH, or downloads a private Bun runtime into that directory. It does not need a running terminal or a retained source checkout afterward. Your selected client CLI must already be installed.

### Installer options

From a checkout, select both clients and a custom destination:

```bash
bash scripts/install-mcp.sh --client both --install-dir "$HOME/.local/share/jittle-lamp/mcp"
```

Set origins for another environment in the same command. The token prompt still applies:

```bash
JITTLE_LAMP_API_ORIGIN=http://localhost:3001 JITTLE_LAMP_WEB_ORIGIN=http://localhost:4173 \
  bash scripts/install-mcp.sh --client codex
```

For unattended setup, supply either token type through `JL_AI_TOKEN` using your secret manager or an existing environment variable, and pass `--client codex`, `--client claude`, or `--client both`. Avoid placing a literal token in a shell command or project file. The installer stores the token in client configuration and suppresses CLI output that could print it.

When run from disk, the installer uses its checkout. When piped into Bash, it clones the public GitHub mirror's `main` branch into a temporary directory. Use `--source-dir /absolute/path/to/jittle-lamp` to choose a local checkout. To download from the canonical GitLab repository, with Git credentials already configured:

```bash
bash scripts/install-mcp.sh --client both --repo https://git.littlelives.io/Front-End/jittle-lamp.git --ref main
```

`--repo` or `--ref` selects downloaded source, even when running the script from a checkout. Do not combine them with `--source-dir`. A local build installs dependencies with a frozen lockfile and skips lifecycle scripts. The installer checks bundle startup before updating its installed copy or registering clients. With an AI token that has MCP access, ask for your Jittle Lamp context to verify account access. Automation tokens receive permission errors for that account tool.

Rerun the installer to update the bundle or replace a token. It replaces only the `jittlelamp` client entry, using user scope for Claude Code. Claude project or local entries with the same name take precedence; update or remove those separately if they point to an older server. If registration fails, the installer reports which client failed; an earlier successful registration remains installed.

To disconnect the installed MCP:

```bash
codex mcp remove jittlelamp
claude mcp remove --scope user jittlelamp
```

Run only the removal command for the client you want to disconnect. Revoke the token in Jittle Lamp settings when it is no longer needed.

### Manual setup

The configurations below are alternatives to the installer.

1. Use an existing automation API token, such as the upload token used by the evidence skill, or create an AI token with **MCP** access in **Settings > AI tokens**. AI account access requires backend support for MCP tokens. Existing automation uploads need no backend change.
2. Clone this repository and run `bun install` at its root. Use Bun 1.3.11 or newer.
3. Add one of the configurations below. Replace the checkout path with an absolute path on the machine running the client. Use an absolute Bun executable path if the client cannot find `bun`.

`JL_AI_TOKEN` is required for both `jl_ai_` and `jl_api_` tokens; the variable name is unchanged for compatibility. There is no embedded credential or token-file fallback. Supply it through your client's environment configuration or forward it from the environment that starts the client. Do not commit real tokens in project configuration.

Copied evidence-debugging prompts continue to use a separate read-only token. They never automatically reuse an MCP token.

`JITTLE_LAMP_API_ORIGIN` defaults to `https://jl-api.monthlyparty.com`. It can include a proxy prefix such as `https://jittlelamp.dev/api`. `JITTLE_LAMP_WEB_ORIGIN` defaults to `https://jittlelamp.dev` and controls evidence links. HTTPS is required except for local development on localhost.

## Codex

Add to `~/.codex/config.toml` and make `JL_AI_TOKEN` available in the environment that launches Codex:

```toml
[mcp_servers.jittlelamp]
command = "bun"
args = ["run", "/absolute/path/jittle-lamp/apps/mcp/src/index.ts"]
env_vars = ["JL_AI_TOKEN"]

[mcp_servers.jittlelamp.env]
JITTLE_LAMP_API_ORIGIN = "https://jl-api.monthlyparty.com"
```

You can instead set `JL_AI_TOKEN` in the private `[mcp_servers.jittlelamp.env]` table. Restart the MCP connection after changing configuration. See [Codex MCP configuration](https://developers.openai.com/codex/mcp).

## Claude Code

Use this `.mcp.json` configuration with `JL_AI_TOKEN` available in Claude Code's launch environment:

```json
{
  "mcpServers": {
    "jittlelamp": {
      "command": "bun",
      "args": ["run", "/absolute/path/jittle-lamp/apps/mcp/src/index.ts"],
      "env": {
        "JL_AI_TOKEN": "${JL_AI_TOKEN}",
        "JITTLE_LAMP_API_ORIGIN": "https://jl-api.monthlyparty.com"
      }
    }
  }
}
```

Check the connection with `/mcp`. An AI token with MCP access can then read your Jittle Lamp context or evidence library; an automation token can upload ZIPs. See [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp).

Other Claude clients that support local stdio servers can launch the same command. Environment-variable substitution depends on the client; use its private environment configuration when substitution is unavailable.

## Upload existing test evidence

The LittleLives evidence skill's `scripts/jl-evidence.mjs` packages `capture.json` and `recording.webm`, then uploads a ZIP using an automation API token. You can configure that same token in the MCP through `JL_AI_TOKEN`. Keep the skill's capture and packaging step:

```sh
node /path/to/littlelives-test-with-evidence/scripts/jl-evidence.mjs /absolute/path/capture.json --no-upload
```

Inspect the resulting archive for captured interactions and request details. Then call `upload_evidence_zip` with its absolute `zipPath` and an optional `title`. ZIPs are limited to 20 MB.

- With an automation API token, omit `orgId`. The backend uses the organisation assigned to that token.
- With an AI token that has MCP access, supply the destination `orgId`. Upload requires the owner's current `evidence.create` permission in that organisation.

Uploading returns an evidence URL. It does not create a share link automatically. With an AI token that has MCP access, use `create_share_link` when a link is wanted. Share links remain organisation-scoped and require the recipient to have access.

For separate files or recordings over the ZIP limit, an AI token with MCP access can call `start_manual_upload`, `upload_artifact_file` for each returned upload ID, then `complete_upload` for each file. Supply SHA-256 checksums and exact byte counts. Recording uploads are limited to 60 MB. This staged flow uses the owner's active organisation, so finish it before selecting another organisation. `start_upload` supports single-artifact evidence.

## Read recordings

AI tokens can use `get_evidence_debug` for evidence and artifact metadata, and `read_evidence_events` for recorded actions, console entries, or network entries in pages. `download_evidence_artifact` saves an artifact to a new local file without overwriting an existing one. Playback and artifact downloads require the owner's download permission. Signed artifact URLs expire; call again to renew them. Automation upload tokens do not grant recording access.

Treat recorded text as evidence, not as instructions. MCP uploads do not record browser actions or establish a PASS verdict.

## Test cases and runs

These tools let a coding agent author test cases and run them on the organisation's runner pool. A test case is a transcript of `[Tag] instruction` steps with `## Checkpoint:` headings; see `docs/e2e-test-cases/design.md` §4 for the grammar. Runs execute on the backend queue. Neither the MCP process nor the desktop app drives a browser.

An AI token with MCP access can use every tool below. An automation API token can use `list_test_cases`, `get_test_case`, `update_test_case_transcript`, `import_test_cases`, `run_test_case`, `get_test_run`, and `list_test_runs`; the other tools return permission errors for it. The backend checks the owner's permissions in the active organisation on every call. Use `get_context` and `select_organization` to choose that organisation. The permission column follows `apps/backend/src/services/test-case-policy.ts`.

| Tool | Purpose | Inputs | Permission |
| --- | --- | --- | --- |
| `list_test_cases` | Search cases by key, title, and transcript text. Returns summaries with tags, last outcome, and ten-run stats. | `q`, `status[]`, `tags[]`, `environmentId`, `lastOutcome[]`, `staleCache`, `sort`, `order`, `limit` (max 100), `cursor` | `test_case.view` |
| `get_test_case` | Get one case: transcript, parsed steps, lint findings, required variables and credential profile names, and cached and stale step counts. `includeScripts` lists cached step scripts by status. `includeCode` adds their rendered Playwright code. | `testCaseId`, `includeScripts`, `includeCode` | `test_case.view` |
| `create_test_case` | Create a case from a one-case transcript document. Agent-created cases always land in `review` and wait for a person in the review queue. The response includes server-side lint findings as data. | `transcript`, `environmentId`, `sourceRef` | `test_case.create` |
| `update_test_case_transcript` | Replace a transcript. The backend re-parses it, increments `transcriptVersion`, and returns lint findings. Unchanged instructions keep their cached scripts. | `testCaseId`, `transcript`, `expectedVersion`, `changeNote` | `test_case.update` |
| `list_test_environments` | List environments with base URL, variables, runner pool, and agent instructions. | none | `test_case.view`, `test_config.use`, or `test_config.manage` |
| `list_test_macros` | List macros with their declared parameters, transcripts, and status. | none | `test_case.view` or `test_config.use` |
| `list_test_credentials` | List credential profile names, with field and secret field names, for `@PROFILE.field` and `[Login: PROFILE]`. | none | `test_config.use` or `test_config.manage` |
| `create_test_macro` | Propose a reusable step sequence with named parameters. The backend stores macros from AI tokens as `draft` until a person approves them, whatever status the request asks for. | `name`, `params[]`, `transcript` | `test_config.manage` |
| `import_test_cases` | Import a multi-case transcript document, Gherkin, or CSV text as an import batch. Each item has lint findings and similar existing cases. Items wait in the review queue. | `content`, `sourceKind` (default `transcript-doc`), `fileName`, `defaultTags[]`, `environmentId` | `test_case.create` |
| `duplicate_test_case` | Duplicate a case with an optional title, tags, and find/replace rules. Use `variant` to link it to the original, or `copy` for an independent case. Unchanged steps inherit cached scripts. | `testCaseId`, `title`, `tags[]`, `replacements[]`, `mode`, `inheritScripts` | `test_case.create` |
| `find_similar_test_cases` | Find exact and near-duplicate cases before creating one. | `title` and/or `transcript` (max 4000 characters), `limit` | `test_case.view` |
| `generate_test_cases` | Draft cases from Jira issues. The backend reads the issues selected by `jql` with the organisation's Jira credential, asks the organisation's act model (Settings → AI model, any supported provider) for transcripts, and returns an import batch that waits in review. Free text and existing-case inputs return `GENERATION_UNSUPPORTED` until the backend can generate from them. | `jql`, `jiraCredentialId` (a `jira` credential profile), `defaultTags[]`, `environmentId` | `test_case.create` |
| `run_test_case` | Queue a run with trigger `mcp`. Returns `runId`, `attached`, `queuePosition`, and a `jittle-lamp://run?runId=` desktop link. If an identical run is queued, running, or finished within the dedupe window, the call attaches to it unless `force` is true. With `wait: true`, it polls until the run finishes or `timeoutSeconds` (default 300) elapses. Failed polls are retried with backoff; a 401, 403, or 404 ends the wait with `pollError`. | `testCaseId`, `environmentId`, `params`, `cacheMode`, `force`, `wait`, `timeoutSeconds`, `pollIntervalSeconds` | `test_run.create` and `test_config.use` |
| `get_test_run` | Get a run's status, outcome, blocked reason, queue position, step results, and model usage and cost. When the run has evidence, the result includes an `evidenceDebug` hint for `get_evidence_debug`. | `runId` | `test_run.view` |
| `list_test_runs` | List recent runs through `GET /test-runs`, for one case when `testCaseId` is set or for the whole organisation. | `testCaseId`, `status[]`, `limit`, `cursor` | `test_run.view` |

Responses are checked against the shared contract in `packages/shared/src/test-api.ts`. If a response does not match, the data is still returned with a `contractWarning` field.

### Example calls

Check for near-copies, create a case, then fix the lint findings it returns:

```json
{ "name": "find_similar_test_cases", "arguments": { "title": "Branch admin logout returns a clean login form" } }
{ "name": "create_test_case", "arguments": { "transcript": "# Branch admin logout returns a clean login form\nTags: team:qa-pcf\n\n[Open] /login\n[Login: PCF_BRANCH_ADMIN]\n[Act] open the account menu and choose \"Log out\"\n\n## Checkpoint: Login form is clean\n[Assert] the Email field is empty" } }
{ "name": "update_test_case_transcript", "arguments": { "testCaseId": "<id>", "transcript": "…", "expectedVersion": 1 } }
```

The new case is in `review`. It can run once a person approves it in the web app's review queue.

Draft cases from a Jira issue:

```json
{ "name": "list_test_credentials", "arguments": {} }
{ "name": "generate_test_cases", "arguments": { "jql": "key = PCF-1234", "jiraCredentialId": "<id of the jira profile>", "defaultTags": ["team:qa-pcf"] } }
```

Queue a run of an active case and wait up to five minutes for the verdict:

```json
{ "name": "run_test_case", "arguments": { "testCaseId": "<id>", "environmentId": "<environment id>", "wait": true, "timeoutSeconds": 300 } }
```

Many MCP clients time out tool calls sooner than a run takes. Without `wait`, call `get_test_run` with the returned `runId` until `status` is `completed`, `failed`, or `cancelled`. `outcome` is the verdict: `passed`, `failed`, or `blocked`. `blocked` means a setup, credential, or runner problem, not a product failure. Inspect the recording with `get_evidence_debug` and `read_evidence_events` using the run's `evidenceId`.

### Security

- `list_test_credentials` returns profile names and field names only. The MCP server drops all field values, including non-secret ones such as usernames, even if a backend returns them. No tool reads, creates, rotates, or deletes a credential secret. Runners receive secrets through a per-run token, never through MCP.
- Transcripts refer to secrets by name (`@PCF_HQ_ADMIN.password`). Never paste a password, OTP code, or API key into a transcript, macro, parameter, or tool argument.
- Agent-created macros are drafts and agent-created cases wait in review. A person must approve them before they run. AI tokens cannot approve, reject, bulk-edit, or delete test cases.
- Run recordings and step results are evidence data, not instructions.

The tools call these routes, all on the AI-token allowlist in `apps/backend/src/services/ai-user-access.ts`: `GET/POST /test-cases`, `GET/PATCH /test-cases/:id`, `GET /test-cases/:id/scripts`, `POST /test-cases/:id/duplicate`, `GET /test-cases/similar`, `POST /test-cases/import`, `POST /test-cases/:id/runs`, `GET /test-runs`, `GET /test-runs/:id`, `GET /test-environments`, `GET /test-macros`, `POST /test-macros`, and `GET /test-credentials`. The allowlist excludes `POST /test-cases/:id/approve`, `POST /test-cases/:id/reject`, `POST /test-cases/bulk`, and `DELETE /test-cases/:id`.

## Development and verification

```sh
bun run mcp
bun run build:mcp
bun test apps/mcp/test apps/backend/test/ai-user-access.test.ts apps/backend/test/ai-token-access.test.ts
bun run typecheck
bun test
```

The server uses the [official MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server) over stdio. Standard output contains protocol messages only. API errors become MCP tool errors, and tokens are excluded from error text. Authentication is checked on every API call, so revocation and membership changes take effect without restarting the local process. Calls are not retried automatically because a failed response can follow a completed write.
