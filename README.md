# Obsidian Workbench

Obsidian Workbench is a local-first TypeScript suite that gives MCP clients guarded access to authorized Obsidian vaults. It includes an MCP server, a single-file MCP App, shared contracts, a filesystem vault adapter, Codex skills, an Obsidian companion plugin, and remote-gateway integration boundaries.

The default local configuration is read-only. Write tools use explicit permission scopes, content revisions, idempotency keys, dry-run diffs, and short-lived confirmation tokens for high-risk mutations. Note content is returned as untrusted data and cannot grant permissions or authorize a write.

> **Release status:** The local suite is implemented and tested. The remote bridge is an integration library, not a deployable hosted service: production authentication, durable metadata storage, account lifecycle, event consumption, legal policies, and production brand assets remain release blockers. See [Current limitations](#current-limitations) and the [release checklist](docs/release-checklist.md).

## Components

| Component      | Package/path               | Responsibility                                                                                                                |
| -------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| MCP server     | `packages/mcp-server`      | Registers the explicit tool catalog, serves STDIO or loopback Streamable HTTP, and embeds the MCP App resource.               |
| MCP App        | `packages/mcp-app`         | Browsing, note editing, capture, tasks, maintenance reporting, diff review, and confirmation through a typed bridge.          |
| Vault core     | `packages/vault-core`      | Filesystem adapter, Markdown semantics, path policy, search, revisions, idempotency, mutation plans, and confirmations.       |
| Shared         | `packages/shared`          | Zod schemas, errors, permission scopes, and companion protocol contracts.                                                     |
| Companion      | `packages/obsidian-plugin` | Permission-scoped Obsidian API adapter, outbound gateway connection, pairing, events, and local audit log.                    |
| Remote gateway | `packages/remote-gateway`  | Authentication/persistence interfaces, pairing, scoped credentials, WebSocket sessions, replay controls, and request routing. |
| Skills         | `skills`                   | Capture, research synthesis, daily review, note refactor, and vault maintenance workflows.                                    |

Detailed flows and trust boundaries are in [Architecture](docs/architecture.md). Every registered MCP tool is documented in the [Tool catalog](docs/tool-catalog.md).

## Requirements

- Node.js 22 or newer. Release CI uses Node.js 24.
- pnpm 10.33.2, as declared by `packageManager`.
- For the preserved Python prototype only: Python 3.12 and [uv](https://docs.astral.sh/uv/).
- Obsidian 1.5.0 or newer for the companion plugin.

## Fresh Clone

Install the TypeScript workspace and the preserved Python environment:

```shell
pnpm install --frozen-lockfile
uv sync --all-groups --locked
```

Build all TypeScript packages:

```shell
pnpm build
```

The MCP App build emits `packages/mcp-app/dist/index.html`. The companion build emits `packages/obsidian-plugin/main.js`.

## Test Vault

Use a disposable vault containing no sensitive notes. Do not initially point development clients at a primary vault.

Create a directory outside the repository or an ignored local directory, add a few Markdown files, and set one of these configurations:

- `OBSIDIAN_VAULT_PATH`: one filesystem vault; defaults to ID `local-vault` and read-only scopes `vault.metadata.read`, `notes.read`, and `tasks.read`.
- `OBSIDIAN_VAULTS_JSON`: an array of vault definitions with `vaultId`, `rootPath`, optional `name`, `allowedRoots`, `excludedRoots`, `scopes`, and partial `conventions`.

PowerShell read-only example:

```powershell
$env:OBSIDIAN_VAULT_PATH = ".\path\to\test-vault"
$env:OBSIDIAN_VAULT_ID = "workbench-test"
$env:OBSIDIAN_VAULT_NAME = "Workbench Test Vault"
```

Writes must be granted explicitly. This development-only example allows note and task mutations while retaining folder policy:

```powershell
$env:OBSIDIAN_VAULTS_JSON = '[{"vaultId":"workbench-test","rootPath":"./path/to/test-vault","name":"Workbench Test Vault","allowedRoots":["Inbox","Projects","Daily"],"excludedRoots":["Private"],"scopes":["vault.metadata.read","notes.read","notes.create","notes.update","notes.move","notes.trash","tasks.read","tasks.create","tasks.update"]}]'
```

`.obsidian/` remains blocked. Relative examples assume the server starts with the repository root as its working directory. See [Local development](docs/local-development.md) for test-vault setup and troubleshooting.

## Local MCP Server

### STDIO

STDIO is the default transport:

```shell
pnpm --filter @obsidian-workbench/mcp-server start
```

`config/mcp.local.example.json` is a secret-free MCP client template. It assumes `pnpm build` has completed and that the MCP process starts from this repository root. If a client requires absolute paths, put those paths in the client's untracked user configuration, never in a committed example.

### Streamable HTTP

The HTTP transport has no application authentication and must remain loopback-only for local development:

```powershell
$env:MCP_TRANSPORT = "http"
$env:MCP_HOST = "127.0.0.1"
$env:PORT = "8000"
pnpm --filter @obsidian-workbench/mcp-server start
```

- MCP endpoint: `http://127.0.0.1:8000/mcp`
- Health endpoint: `http://127.0.0.1:8000/health`
- Optional `MCP_ALLOWED_HOSTS`: comma-separated host allowlist.

Do not bind this server to a LAN or public interface. Use the authenticated remote architecture instead.

## MCP App

Build the single-file app before starting the MCP server:

```shell
pnpm --filter @obsidian-workbench/mcp-app build
pnpm --filter @obsidian-workbench/mcp-server build
```

The server registers `ui://obsidian-workbench/index.html` with no external connect or resource domains. Hosts that support MCP Apps can open it from `obsidian.list_vaults`. `MCP_APP_HTML_PATH` can override the built HTML location for development.

`config/mcp-app.example.json` records the release resource metadata and points to the local MCP example. It is a repository deployment descriptor, not a portable client standard; runtime registration in `packages/mcp-server/src/app/workbench-app.ts` is authoritative.

The app never auto-saves. Its write path is edit, dry-run, inspect diff, confirm when required, then apply. The app-only `obsidian.ui.confirm_mutation` tool binds a short-lived token to the exact mutation plan.

## Companion Installation

Build the plugin and install its three deployables into a development vault:

```shell
pnpm --filter @obsidian-workbench/obsidian-plugin build
```

1. Create `<test-vault>/.obsidian/plugins/obsidian-workbench/`.
2. Copy `packages/obsidian-plugin/main.js`, `manifest.json`, and `styles.css` into it.
3. In Obsidian, enable **Community plugins**, then enable **Obsidian Workbench Companion**.
4. Configure allowed/excluded roots and the minimum required scopes before pairing.
5. Enter the secure `wss://` gateway URL and a one-time pairing code.

Pairing stores separate device-identity and vault-authorization credentials in Obsidian plugin data. The default lifetimes are 90 days and 30 days respectively; if either expires, the plugin refuses to connect and the vault must be paired again. There is no refresh flow. Review the [companion README](packages/obsidian-plugin/README.md) before using real vaults.

## Remote Bridge

The implemented remote flow is:

```text
authenticated MCP host -> RemoteVaultAdapter -> RequestRoutingService
  -> authenticated WSS session -> companion -> authorized Obsidian APIs
```

The gateway package does not provide a production executable, account system, database implementation, or remote MCP HTTP authentication layer. An operator must supply those boundaries, TLS, independent HMAC secrets from a secret manager, operational retention rules, and account/device management. Never use the in-memory auth or repository classes in production.

See [Remote bridge deployment](docs/remote-bridge.md) for required composition, suggested operator configuration, credential expiry/re-pair behavior, and troubleshooting.

## Checks and Builds

Targeted TypeScript commands:

```shell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm verify:release
```

`pnpm verify` runs the complete recursive sequence. `pnpm verify:release` is the fast metadata-only release check: it validates versions, manifests, configs, documentation/tool coverage, asset placeholder state, deployable declarations, and obvious credentials in non-test source/config files.

Preserved Python checks and build:

```shell
uv run ruff check .
uv run pytest
uv build
```

## Security Model

- Vault content is untrusted data, including quoted, linked, and embedded notes.
- Filesystem paths are normalized and constrained to configured roots; absolute paths, traversal, `.obsidian/`, excluded roots, and symlink escape are rejected.
- Scopes are operation-specific. Local single-vault configuration defaults to read-only.
- Existing-note writes require the expected SHA-256 revision. All writes require an idempotency key and default to dry-run.
- Full-document replacement, move, and trash require a reviewed plan and single-use confirmation. Trash moves notes to a Workbench trash location rather than hard deleting.
- Remote routing binds account, device, vault, and scope; offline writes are not queued.
- Tool errors and audit records avoid note bodies, credentials, and internal exception detail.

These controls reduce risk but do not make an untrusted MCP host, compromised local account, malicious Obsidian plugin, or compromised remote operator safe. Read the complete [Threat model](docs/threat-model.md), [Privacy placeholder](docs/privacy.md), and [Terms placeholder](docs/terms-placeholder.md).

## Current Limitations

- Production remote deployment is incomplete: no durable `GatewayRepository`, production `AuthProvider`, service bootstrap, account UI/API, account deletion workflow, key rotation procedure, or remote MCP authentication endpoint is included.
- Companion events are schema-validated and vault-bound through `GatewayEventSink`, but no production sink or MCP App cache-invalidation subscription is composed. Remote event delivery remains an operator integration step.
- Local idempotency and confirmation state is in memory and resets when the MCP server restarts.
- Local Streamable HTTP has no user authentication and is suitable only on loopback.
- Search is bounded lexical/metadata search; there is no semantic index or cloud index.
- Orphan/hub analysis inspects at most the first 200 notes and reports truncation.
- The MCP App is intentionally focused. It does not replace Obsidian, auto-save, or expose every registered tool.
- Public privacy terms, service terms, operator identity/contact details, retention periods, account-deletion SLA, data residency/subprocessors, and production assets require owner/legal approval. Current documents are explicit placeholders, not legal promises.
- No repository license file is present. Public distribution terms require owner approval.

## Documentation

- [Architecture](docs/architecture.md)
- [Threat model](docs/threat-model.md)
- [Tool catalog](docs/tool-catalog.md)
- [Privacy placeholder](docs/privacy.md)
- [Terms placeholder](docs/terms-placeholder.md)
- [Local development](docs/local-development.md)
- [Remote bridge](docs/remote-bridge.md)
- [Release checklist](docs/release-checklist.md)
- [Production asset specifications](assets/README.md)

## Preserved Python/FastMCP Prototype

This repository still contains the original `dailynotesmcp` Python 3.12/FastMCP greeting prototype. It exposes the `hello_mcp_world` prompt and read-only `say_hello_mcp_world` tool. It does **not** expose Obsidian Workbench vault tools or vault data.

The existing `.mcp.json`, `.codex-mcp.json`, `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/`, `api/index.py`, and `vercel.json` remain the legacy marketplace/deployment configuration for `https://dailynotesmcp.vercel.app/mcp`. They are intentionally distinct from the Workbench examples under `config/`.

Run it locally with:

```shell
uv run dailynotesmcp
# HTTP MCP: http://localhost:8000/mcp
# Health:   http://localhost:8000/health
```

Or use the packaged STDIO entry point:

```shell
uv run dailynotesmcp-stdio
```

Vercel continues to deploy only this stateless Python prototype through `api/index.py`. Do not describe that public endpoint as an Obsidian Workbench remote bridge.

## Release

The TypeScript suite and Python prototype currently share one repository version/tag. Before tagging `vX.Y.Z`, update the root/workspace package versions, Obsidian companion manifest, Python project version, and preserved legacy plugin versions together. Then run both language check sets and complete [the public release checklist](docs/release-checklist.md).

The release workflow verifies both stacks, builds Python distributions and TypeScript artifacts, packages the Obsidian deployables and single-file MCP App, and creates a **draft** GitHub release. An owner must resolve all legal, privacy, security, asset, and operational placeholders before publishing it.
