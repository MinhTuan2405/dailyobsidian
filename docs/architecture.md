# Architecture

Obsidian Workbench is a local-first TypeScript suite built around one `VaultAdapter` interface. MCP tools depend on that interface rather than direct filesystem, Obsidian, or network access. The original Python/FastMCP greeting server remains a separate deployed prototype and is outside all vault data flows described here.

## Modes

### Local filesystem mode

```text
MCP host
  | STDIO (default) or loopback Streamable HTTP
  v
@obsidian-workbench/mcp-server
  | validated tool input
  v
VaultRegistry -> FilesystemVaultAdapter -> PathSecurity -> test/user vault
  |                     |
  |                     +-> revisions / search / Markdown / mutation safety
  v
structured MCP result + optional embedded MCP App resource
```

The executable loads `OBSIDIAN_VAULT_PATH` or `OBSIDIAN_VAULTS_JSON`. Filesystem mode has no companion or account authentication. The MCP process and its client are inside the local user trust domain; path policy and scopes constrain what that process can request. STDIO avoids a listening socket. HTTP defaults to `127.0.0.1` and must not be exposed because it has no application authentication.

### Remote companion mode

```text
authenticated MCP-facing service
  | authenticated user session + selected vault descriptor
  v
RemoteVaultAdapter
  | exact method + one required scope + user/vault binding
  v
RequestRoutingService -> GatewaySessionRegistry
  |                         |
  | metadata repository     +-> timeout / replay / capacity checks
  v
TLS WebSocket gateway
  ^ outbound connection + device identity + vault authorization
  |
Obsidian companion RequestRouter
  | device/user/vault/scopes + path policy + schema validation
  v
Obsidian Vault / MetadataCache / FileManager APIs
```

`@obsidian-workbench/remote-gateway` and `RemoteVaultAdapter` implement the integration boundaries, but no production service composition is shipped. A deployment must supply a real `AuthProvider`, durable atomic `GatewayRepository`, remote MCP authentication/transport, TLS, secrets, account lifecycle, and operational controls. The in-memory implementations are test doubles only.

## Package Boundaries

| Package                               | Owns                                                                                                                                                    | Must not own or bypass                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `@obsidian-workbench/shared`          | Zod schemas, inferred types, safe errors, scopes, JSON-RPC-style protocol envelopes                                                                     | Filesystem, network, Obsidian runtime, UI state                            |
| `@obsidian-workbench/vault-core`      | `VaultAdapter`, filesystem implementation, path authorization, Markdown/search/link/task semantics, revisions, idempotency, plans, diffs, confirmations | MCP transport, remote account authentication, UI                           |
| `@obsidian-workbench/mcp-server`      | Tool/resource registration, result mapping, vault registry, STDIO/HTTP transports, remote adapter                                                       | Direct note I/O outside an adapter                                         |
| `@obsidian-workbench/mcp-app`         | Typed MCP bridge and focused UI state/screens                                                                                                           | Raw filesystem/network access, direct transport calls, credential storage  |
| `@obsidian-workbench/obsidian-plugin` | Obsidian API adapter, local permissions, pairing client, outbound WebSocket, event production, local audit                                              | Inbound public listener, generic command execution, account authentication |
| `@obsidian-workbench/remote-gateway`  | Pairing, token verification, metadata interfaces, session limits, routing authorization                                                                 | Vault mounting, note persistence, production account/database policy       |
| `skills/`                             | User-facing multi-step workflows and prompt-injection safety rules                                                                                      | New tool implementations or implicit destructive authority                 |

The MCP App is bundled into one HTML file. The MCP server registers it as `ui://obsidian-workbench/index.html` with empty external connection/resource domain lists. UI components call only the schema-validating bridge.

## Local Data Flow

1. The MCP host starts the server and passes vault configuration through process environment variables.
2. `VaultRegistry` parses configuration and constructs one `FilesystemVaultAdapter` per vault.
3. The server validates MCP input against a shared Zod schema and resolves only the requested `vaultId`.
4. The adapter checks the required scope, vault ID, folder policy, normalized path, `.obsidian/` block, and symlink containment before file access.
5. Markdown parsing/search creates bounded schema outputs. Search emits snippets rather than full vault dumps; note documents and search/context outputs are marked `untrustedContent: true`.
6. The tool wrapper validates the output schema and returns both text JSON and `structuredContent`. Errors are mapped to the stable `ToolError` shape without raw exception details.

No server-side cloud index is used. The local MCP host receives whichever note data the user asks the tool to return and may have its own retention behavior outside this repository.

## Remote Data Flow

1. A production account system authenticates a user and supplies a bounded `UserSession` to the MCP-facing service.
2. `RemoteVaultAdapter` selects one exact gateway method and one required scope for each adapter call.
3. `RequestRoutingService` verifies the account, user/vault mapping, requested scope, method allowlist, and active authorization record.
4. `GatewaySessionRegistry` chooses an authenticated online device/vault session and enforces message, buffer, in-flight, request-ID, and timeout limits.
5. The gateway forwards the schema-bound request in memory over the companion's outbound TLS WebSocket. It does not queue an offline request.
6. The companion verifies device, user, vault, timestamp, nonce, paired scopes, currently enabled scopes, and method policy again.
7. The Obsidian adapter applies path/scoping controls and calls official Obsidian APIs. Its schema-validated response returns through the same path.
8. The remote adapter validates the protocol response and tool output. Unknown remote errors and invalid shapes become non-sensitive internal errors.

The gateway repository contract stores identity/authorization metadata, token metadata, and pairing-code digests. It does not include note bodies, request parameters, or responses. Note data still exists transiently in the companion, WebSocket process, routing process, MCP service, and MCP host while a request is handled.

## Write Flow

```text
read current note + revision
  -> submit write with idempotencyKey and dryRun=true
  -> adapter builds MutationPlan and unified diff
  -> MCP App renders vault, path, revisions, risk, additions/deletions
  -> user edits, cancels, or applies
  -> if confirmationRequired: app requests exact-plan confirmation token
  -> repeat same write with dryRun=false and token when required
  -> recheck scope/path/revision immediately before mutation
  -> consume confirmation, mutate, return resulting revision
```

All writes require an idempotency key of 8 to 256 characters. Existing-note writes also require `expectedRevision`. Dry-run defaults to true. Full-document replacement, move, and trash are high-risk and require confirmation in the filesystem implementation. Move and trash validate source and destination; local trash relocates to `.workbench-trash` under the authorized root. Other mutations still support preview but currently do not require a token unless their adapter-generated plan says so.

Confirmation tokens are short-lived, single-use, and bound to user, vault, target path, and mutation hash. A changed request cannot reuse the token. Idempotent replay returns the prior result; reuse of one key for different input returns `IDEMPOTENCY_CONFLICT`. Local confirmation and idempotency stores are in memory, so restart clears them.

In companion mode, move uses Obsidian `FileManager`; trash uses the adapter's guarded Obsidian behavior. The gateway also rejects duplicate in-flight mutation keys but durable write idempotency remains the adapter's responsibility.

## Pairing and Credential Flow

```text
account session --create--> one-time pairing code (digest stored, default 5 min)
pairing code --exchange once--> device record
                              + device_identity credential (default 90 days)
                              + vault_authorization credential (default 30 days)
```

The credentials are deliberately separate:

- `device_identity` identifies one revocable device and has no permission scopes. It is used for device authentication and device revocation.
- `vault_authorization` binds that device and user to one vault and an exact scope set. It authorizes the companion session for vault operations.

The gateway verifies both credentials, their persisted JTI metadata, the account/device/authorization lifecycle records, and exact scope equality during WebSocket hello. The companion stores both credentials and expiry timestamps in Obsidian plugin data. If either expires there is no refresh endpoint: connection stops and the user must create and exchange a new pairing code. Revoking the device revokes both credentials, every vault mapping for that device, and active sessions.

## Event Flow

The companion listens to Obsidian and creates these metadata-only events after folder-policy filtering:

```text
vault.connected       vault.disconnected
note.created          note.modified
note.renamed          note.deleted
metadata.changed      active_note.changed
```

Each event contains its type, vault ID, occurrence time, and optional allowed path/note ID. It contains no note body. Local filesystem mode advertises `supportsEvents: false`.

`GatewaySessionRegistry` parses events separately from responses, requires the event vault ID to match the authenticated session, and dispatches through the typed `GatewayEventSink` boundary. The default is validated, transient discard with no persistence. A production host must compose bounded cache invalidation or client notifications; no durable event stream or MCP App subscription is supplied.

## Trust Boundaries

1. **Vault content boundary:** all Markdown/frontmatter/link text is attacker-controlled data, not instructions or authorization.
2. **Path boundary:** a configured vault root and allowed/excluded roots separate accessible notes from the rest of the filesystem and `.obsidian/`.
3. **MCP host boundary:** the host can invoke every tool made visible to it and receives returned content. Tool annotations are hints, not an authorization mechanism.
4. **MCP App iframe boundary:** the app gets typed tool calls through the host bridge and has an empty external CSP allowlist.
5. **Obsidian plugin boundary:** a community plugin runs with Obsidian's local privileges. Workbench scopes constrain remote requests but cannot sandbox another malicious plugin or a compromised Obsidian process.
6. **Network/TLS boundary:** remote note data is plaintext inside trusted endpoint processes and TLS-protected in transit; there is no end-to-end payload encryption from MCP host to companion.
7. **Gateway account/device/vault boundary:** independent records and credentials must all agree before routing. Repository correctness is security-critical.
8. **Operator boundary:** production auth, persistence, logs, backups, keys, deletion, and legal policy are external responsibilities not implemented by this repository.
9. **Legacy prototype boundary:** the public Python greeting endpoint and marketplace manifests are independent of Workbench and have no vault adapter, pairing, or remote authorization.

## Deployment Boundaries

- Local mode is deployable from this repository after `pnpm build`, preferably over STDIO.
- The companion is deployable to a development vault as `main.js`, `manifest.json`, and `styles.css`; public Obsidian marketplace review is not complete.
- The MCP App is a single HTML artifact served as an MCP resource, not a standalone web application.
- The remote gateway is a library. See [Remote bridge](remote-bridge.md) for the missing production composition.
- Vercel deployment in this repository targets only the Python/FastMCP greeting prototype.
