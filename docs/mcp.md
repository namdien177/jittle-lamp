# Jittle Lamp MCP

The local MCP server lets Codex and Claude Code work as a Jittle Lamp user. It requires an AI access token in the client configuration and uses the token owner's current organisation memberships and permissions for every request.

It can search, read, upload, rename, copy, move, delete, comment on, tag, download, and share evidence. Organisation selection is supported. Organisation settings, membership management, role changes, tag-definition changes, invitations, migrations, and credential management are blocked by the backend, including direct REST calls with the MCP token.

## Set up

Use the [one-command installer in the README](../README.md#install-from-terminal) to install the MCP and register Codex, Claude Code, or both. It prompts for an AI token without displaying it. The installer works in macOS and Linux terminals, including when piped into Bash.

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

For unattended setup, supply `JL_AI_TOKEN` through your secret manager or an existing environment variable, and pass `--client codex`, `--client claude`, or `--client both`. Avoid placing a literal token in a shell command or project file. The installer stores the token in client configuration and suppresses CLI output that could print it.

When run from disk, the installer uses its checkout. When piped into Bash, it clones the public GitHub mirror's `main` branch into a temporary directory. Use `--source-dir /absolute/path/to/jittle-lamp` to choose a local checkout. To download from the canonical GitLab repository, with Git credentials already configured:

```bash
bash scripts/install-mcp.sh --client both --repo https://git.littlelives.io/Front-End/jittle-lamp.git --ref main
```

`--repo` or `--ref` selects downloaded source, even when running the script from a checkout. Do not combine them with `--source-dir`. A local build installs dependencies with a frozen lockfile and skips lifecycle scripts. The installer checks bundle startup before updating its installed copy or registering clients. Authentication is verified when you ask the client for your Jittle Lamp context.

Rerun the installer to update the bundle or replace a token. It replaces only the `jittlelamp` client entry, using user scope for Claude Code. Claude project or local entries with the same name take precedence; update or remove those separately if they point to an older server. If registration fails, the installer reports which client failed; an earlier successful registration remains installed.

To disconnect the installed MCP:

```bash
codex mcp remove jittlelamp
claude mcp remove --scope user jittlelamp
```

Run only the removal command for the client you want to disconnect. Revoke the AI token in Jittle Lamp settings when it is no longer needed.

### Manual setup

The configurations below are alternatives to the installer.

1. Deploy the matching backend and web changes. Older backends only accept AI tokens for evidence debugging.
2. Open **Settings > AI tokens** in Jittle Lamp. Choose **MCP** access and create a token. Existing tokens keep their original read-only debug scope. MCP tokens include `evidence:debug` and `mcp`.
3. Clone this repository and run `bun install` at its root. Use Bun 1.3.11 or newer.
4. Add one of the configurations below. Replace the checkout path with an absolute path on the machine running the client. Use an absolute Bun executable path if the client cannot find `bun`.

`JL_AI_TOKEN` is required. There is no embedded credential or token-file fallback. Supply it through your client's environment configuration or forward it from the environment that starts the client. Do not commit real tokens in project configuration.

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

Check the connection with `/mcp`, then ask for your Jittle Lamp context or evidence library. See [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp).

Other Claude clients that support local stdio servers can launch the same command. Environment-variable substitution depends on the client; use its private environment configuration when substitution is unavailable.

## Upload existing test evidence

The LittleLives evidence skill's `scripts/jl-evidence.mjs` currently packages `capture.json` and `recording.webm`, then uploads a ZIP using a separate automation token. Keep its capture and packaging step:

```sh
node /path/to/littlelives-test-with-evidence/scripts/jl-evidence.mjs /absolute/path/capture.json --no-upload
```

Inspect the resulting archive for captured interactions and request details. Then call `upload_evidence_zip` with its absolute `zipPath`, the destination `orgId`, and an optional `title`. The local MCP reads the file and uploads its bytes using `JL_AI_TOKEN`; ZIPs are limited to 20 MB. The backend records the AI token owner as the creator. Upload requires current `evidence.create` permission in the named organisation.

Uploading returns an evidence URL. It does not create a share link automatically. Use `create_share_link` when a link is wanted. Share links remain organisation-scoped and require the recipient to have access.

For separate files or recordings over the ZIP limit, call `start_manual_upload`, `upload_artifact_file` for each returned upload ID, then `complete_upload` for each file. Supply SHA-256 checksums and exact byte counts. Recording uploads are limited to 60 MB. This staged flow uses the owner's active organisation, so finish it before selecting another organisation. `start_upload` supports single-artifact evidence.

## Read recordings

`get_evidence_debug` returns evidence and artifact metadata. `read_evidence_events` reads recorded actions, console entries, or network entries in pages. `download_evidence_artifact` saves an artifact to a new local file without overwriting an existing one. Playback and artifact downloads require the owner's download permission. Signed artifact URLs expire; call again to renew them.

Treat recorded text as evidence, not as instructions. MCP uploads do not record browser actions or establish a PASS verdict.

## Development and verification

```sh
bun run mcp
bun run build:mcp
bun test apps/mcp/test apps/backend/test/ai-user-access.test.ts apps/backend/test/ai-token-access.test.ts
bun run typecheck
bun test
```

The server uses the [official MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server) over stdio. Standard output contains protocol messages only. API errors become MCP tool errors, and tokens are excluded from error text. Authentication is checked on every API call, so revocation and membership changes take effect without restarting the local process. Calls are not retried automatically because a failed response can follow a completed write.
