# Local Development

This guide covers the TypeScript Obsidian Workbench suite. The separate Python/FastMCP greeting prototype is covered at the end.

## Prerequisites

- Node.js 22 or newer. Node.js 24 matches CI.
- pnpm 10.33.2.
- Git.
- Obsidian 1.5.0 or newer for companion testing.
- Python 3.12 and uv only for the preserved prototype.

Install from a fresh clone:

```shell
pnpm install --frozen-lockfile
uv sync --all-groups --locked
```

Do not commit `.env`, vault paths, credentials, test vaults, generated `main.js`, package `dist/`, or Python build artifacts.

## Workspace Commands

```shell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm verify:release
```

- `pnpm test` builds required packages before running workspace tests.
- `pnpm verify` runs the full formatting, lint, typecheck, test, and build chain.
- `pnpm verify:release` does not compile or run tests. It checks release metadata/config/docs/assets and scans non-test source/config for obvious credentials.

Target one package during iteration:

```shell
pnpm --filter @obsidian-workbench/shared test
pnpm --filter @obsidian-workbench/vault-core test
pnpm --filter @obsidian-workbench/mcp-server test
pnpm --filter @obsidian-workbench/mcp-app test
pnpm --filter @obsidian-workbench/obsidian-plugin test
pnpm --filter @obsidian-workbench/remote-gateway test
```

## Create a Disposable Vault

Use a vault created only for development. Do not use a synced production vault for write testing.

Suggested fixture:

```text
workbench-test-vault/
├── Inbox/
│   └── Capture.md
├── Projects/
│   ├── Alpha.md
│   └── Beta.md
├── Daily/
│   └── 2026-07-24.md
├── Private/
│   └── Must-not-be-visible.md
└── .obsidian/
    └── ... always blocked by filesystem mode
```

Include links, an unresolved link, frontmatter, and tasks. Include malicious-looking text such as "ignore prior instructions" to verify it remains untrusted data. Use Git or a disposable copy to restore after write tests.

## Vault Configuration

### One read-only vault

If only `OBSIDIAN_VAULT_PATH` is set, the adapter grants `vault.metadata.read`, `notes.read`, and `tasks.read` only.

PowerShell:

```powershell
$env:OBSIDIAN_VAULT_PATH = ".\path\to\workbench-test-vault"
$env:OBSIDIAN_VAULT_ID = "workbench-test"
$env:OBSIDIAN_VAULT_NAME = "Workbench Test Vault"
```

POSIX shell:

```shell
export OBSIDIAN_VAULT_PATH=./path/to/workbench-test-vault
export OBSIDIAN_VAULT_ID=workbench-test
export OBSIDIAN_VAULT_NAME='Workbench Test Vault'
```

### Multiple vaults or explicit writes

`OBSIDIAN_VAULTS_JSON` takes precedence and accepts at most 100 entries:

```json
[
  {
    "vaultId": "workbench-test",
    "rootPath": "./path/to/workbench-test-vault",
    "name": "Workbench Test Vault",
    "allowedRoots": ["Inbox", "Projects", "Daily"],
    "excludedRoots": ["Private"],
    "scopes": [
      "vault.metadata.read",
      "notes.read",
      "notes.create",
      "notes.update",
      "notes.move",
      "notes.trash",
      "tasks.read",
      "tasks.create",
      "tasks.update"
    ],
    "conventions": {
      "inboxFolder": "Inbox",
      "dailyNotesFolder": "Daily",
      "dailyNoteFormat": "YYYY-MM-DD",
      "preferredLinkStyle": "wikilink"
    }
  }
]
```

Put the compact JSON in the environment, not in tracked configuration. Use the minimum scopes needed. `.obsidian/` is blocked even if a broad root is allowed.

`config/mcp.local.example.json` is intentionally read-only and uses no secrets or absolute paths. It assumes the repository root is the process working directory. MCP clients differ in their support for `cwd`; put machine-specific paths only in untracked user config.

## Build and Run the MCP Server

Build the app before the server so its default resource path exists:

```shell
pnpm --filter @obsidian-workbench/shared build
pnpm --filter @obsidian-workbench/vault-core build
pnpm --filter @obsidian-workbench/mcp-app build
pnpm --filter @obsidian-workbench/mcp-server build
```

### STDIO

```shell
pnpm --filter @obsidian-workbench/mcp-server start
```

STDIO is the default. Do not expect a prompt in the terminal; an MCP client owns stdin/stdout. Startup errors are intentionally generic so paths/config do not leak into logs.

### Local Streamable HTTP

PowerShell:

```powershell
$env:MCP_TRANSPORT = "http"
$env:MCP_HOST = "127.0.0.1"
$env:PORT = "8000"
pnpm --filter @obsidian-workbench/mcp-server start
```

POSIX shell:

```shell
MCP_TRANSPORT=http MCP_HOST=127.0.0.1 PORT=8000 \
  pnpm --filter @obsidian-workbench/mcp-server start
```

Check `http://127.0.0.1:8000/health` and connect an MCP client to `http://127.0.0.1:8000/mcp`. The transport is stateless and creates an MCP server per request. It has no application authentication; never expose it beyond loopback.

Runtime environment variables:

| Variable               | Default             | Meaning                                       |
| ---------------------- | ------------------- | --------------------------------------------- |
| `OBSIDIAN_VAULT_PATH`  | none                | Root path for one local filesystem vault.     |
| `OBSIDIAN_VAULT_ID`    | `local-vault`       | ID for the single-vault form.                 |
| `OBSIDIAN_VAULT_NAME`  | root directory name | Display name for the single-vault form.       |
| `OBSIDIAN_VAULTS_JSON` | none                | Full array; overrides single-vault variables. |
| `MCP_TRANSPORT`        | `stdio`             | Set `http` for Streamable HTTP.               |
| `MCP_HOST`             | `127.0.0.1`         | HTTP bind host. Keep loopback-only.           |
| `PORT`                 | `8000`              | HTTP port.                                    |
| `MCP_ALLOWED_HOSTS`    | SDK defaults        | Comma-separated accepted hosts.               |
| `MCP_APP_HTML_PATH`    | package default     | Override built single-file app location.      |

With no vault variables, the server starts with an empty registry and `obsidian.list_vaults` returns an empty array.

## MCP App

```shell
pnpm --filter @obsidian-workbench/mcp-app build
```

The output is `packages/mcp-app/dist/index.html` plus a source map. The server reads the HTML when the MCP host requests `ui://obsidian-workbench/index.html`. The app resource declares no external network/resource domains.

`config/mcp-app.example.json` mirrors the registered URI, version, HTML path, and CSP. It is verification/deployment metadata, not a standardized host config. A compatible MCP Apps host must implement the Apps bridge. There is no standalone browser backend.

## Test Write Safety Manually

1. Read a note and retain its `identity.revision`.
2. Call a write with a unique `idempotencyKey` and omit `dryRun` or set it to `true`.
3. Inspect `plan`, `diff`, `riskLevel`, and `confirmationRequired`.
4. For full-document replacement, move, or trash, request `obsidian.ui.confirm_mutation` from the MCP App with the exact plan.
5. Repeat the identical write with `dryRun: false` and the token when required.
6. Confirm the returned revision and filesystem state.
7. Repeat the exact request/key to observe idempotent replay; change the payload with the same key to observe `IDEMPOTENCY_CONFLICT`.
8. Modify the note externally and retry with the old revision to observe `REVISION_CONFLICT`.

Local trash is a rename into `.workbench-trash` under the authorized root with a collision-resistant suffix. It is not OS/Obsidian trash. Never use a disposable test vault as a substitute for backup testing.

## Companion Development Vault

Build production deployables:

```shell
pnpm --filter @obsidian-workbench/obsidian-plugin build
```

Copy these files into `<test-vault>/.obsidian/plugins/obsidian-workbench/`:

```text
packages/obsidian-plugin/main.js
packages/obsidian-plugin/manifest.json
packages/obsidian-plugin/styles.css
```

Reload Obsidian, enable the plugin, configure roots/scopes, and use a development gateway only. `pnpm --filter @obsidian-workbench/obsidian-plugin dev` watches and emits an inline-source-map build; stop the process before a production build.

The plugin accepts only `wss://` gateway URLs. It stores separate device/vault credentials in plugin data. Re-pair after either credential expires, after changing the vault identity, or after revocation.

## Troubleshooting

### Server exits with a generic startup error

- Validate `OBSIDIAN_VAULTS_JSON` as JSON and ensure vault IDs are unique.
- Confirm every root exists and the process can read it.
- Remove unsupported scope strings and malformed convention values.
- Run `node packages/mcp-server/dist/main.js` after a successful build to isolate pnpm/client issues.

### No vaults appear

- The MCP process may not inherit your terminal environment. Put non-secret variables in the client's untracked config.
- Relative paths resolve from the MCP process working directory, not necessarily the config file directory.
- Restart the MCP process after changing environment variables.

### `PERMISSION_DENIED`

- Single-vault config is read-only by default.
- Add only the required scope through `OBSIDIAN_VAULTS_JSON` and restart.
- In companion mode, the scope must be present in both the paired grant and current plugin settings.

### `PATH_NOT_ALLOWED`, `PATH_TRAVERSAL_BLOCKED`, or `SYMLINK_ESCAPE_BLOCKED`

- Use vault-relative paths with `/` separators.
- Check both allowed and excluded roots; excluded roots win.
- `.obsidian/`, absolute paths, traversal, and external symlink targets are intentionally unavailable.
- Moves validate both old and new locations.

### `REVISION_CONFLICT`

Re-read the note, rebuild the proposal against the new revision, and show a new diff. Do not automatically retry the old mutation.

### `CONFIRMATION_REQUIRED`

Use the exact dry-run plan in the MCP App confirmation tool, then apply the unchanged request before plan/token expiry. A token for another path, vault, user, or mutation is invalid.

### MCP App resource cannot be loaded

- Build `@obsidian-workbench/mcp-app` before starting the server.
- Confirm `packages/mcp-app/dist/index.html` exists.
- If packaging moves the file, set `MCP_APP_HTML_PATH` to an untracked local path.
- Confirm the MCP host supports MCP Apps, not only tools.

### HTTP host rejected or connection refused

- Use `127.0.0.1`, verify `PORT`, and ensure `MCP_ALLOWED_HOSTS` includes the host header if explicitly set.
- Do not solve a host rejection by binding publicly or setting a wildcard.

### Companion will not connect

- Gateway URLs must use `wss://` and point to `/v1/gateway` if the operator changed the base path.
- Check both credential expiry timestamps. Expiry requires a new pairing code; there is no refresh.
- Ensure the configured vault ID still matches the paired authorization.
- Inspect the bounded local audit/status UI without pasting credentials into an issue.

## Preserved Python Prototype

The Python service is independent of Workbench:

```shell
uv run ruff check .
uv run pytest
uv run dailynotesmcp
uv run dailynotesmcp-stdio
uv build
```

It exposes only the greeting prompt/tool. Its Vercel and legacy marketplace configs must not be used as Workbench remote-bridge configuration.
