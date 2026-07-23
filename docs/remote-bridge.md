# Remote Bridge Deployment and Configuration

## Status

The remote bridge is **not a production-ready standalone service**. `@obsidian-workbench/remote-gateway` exports tested building blocks, and `@obsidian-workbench/mcp-server` exports `RemoteVaultAdapter`, but this repository does not include:

- A gateway executable or environment loader.
- A production `AuthProvider` or account/login system.
- A durable `GatewayRepository` implementation/migrations.
- A remote MCP HTTP endpoint and its user authentication/session integration.
- Account/device management, account deletion, support/admin tooling, or key rotation.
- A production `GatewayEventSink` implementation or MCP cache-invalidation subscription.
- Production monitoring, rate limiting, deployment manifests, legal policy, or SLA.

Do not deploy `InMemoryAuthProvider` or `InMemoryGatewayRepository` for real users. Both are test doubles and lose state at process exit.

## Required Topology

```text
MCP client / ChatGPT
  -> authenticated remote MCP endpoint (operator supplied)
  -> per-user RemoteVaultAdapter registry
  -> RequestRoutingService
  -> GatewaySessionRegistry
  -> private Node HTTP listener behind trusted TLS proxy
  -> WSS /v1/gateway
  -> outbound Obsidian companion connection
  -> permission-scoped Obsidian APIs

Account UI/API
  -> AuthProvider
  -> POST /v1/pairing/create
  -> device inventory/revocation/deletion (operator must add)

Durable database
  <- GatewayRepository metadata only
```

The current gateway HTTP boundary exposes `POST /v1/pairing/create`, `POST /v1/pairing/exchange`, `POST /v1/devices/revoke`, and `GET /health`. Request routing is an in-process service used by the remote MCP adapter; it is not exposed as a public generic HTTP route.

## Production Dependencies

An operator must provide:

1. An `AuthProvider` that validates opaque account sessions and returns bounded `UserSession` values.
2. A durable `GatewayRepository` with tenant-isolated queries, atomic `completePairing`, lifecycle/revocation timestamps, backup/deletion behavior, and no note payload storage.
3. Independent random secrets of at least 32 bytes for token signing and pairing-code HMAC, loaded from a secret manager.
4. Stable token issuer/audience values and a documented key-rotation process.
5. A trusted TLS reverse proxy/network boundary. The Node listener must be unreachable directly when trusting `X-Forwarded-Proto`.
6. An authenticated remote MCP layer that creates user-specific `RemoteVaultAdapter` descriptors and never accepts caller-supplied user identity as truth.
7. Exact browser CORS origins only if browser access is needed. Native companion connections have no `Origin` header. Wildcards are rejected.
8. Distributed rate limiting, abuse controls, logs/metrics with payload redaction, backups, incident response, and deletion/retention jobs.

## Integration Configuration

The package has no environment-variable loader. The following names are a suggested contract for the operator's host application, not variables consumed by the library:

| Suggested setting             | Requirement                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `GATEWAY_PUBLIC_WSS_URL`      | Public `wss://.../v1/gateway` URL shown to the companion.                      |
| `GATEWAY_LISTEN_HOST`         | Private listener, normally loopback or a private container interface.          |
| `GATEWAY_LISTEN_PORT`         | Operator-selected port.                                                        |
| `GATEWAY_TOKEN_SIGNING_KEY`   | Secret-manager reference/value, at least 32 random bytes; never commit.        |
| `GATEWAY_PAIRING_HMAC_KEY`    | Independent secret, at least 32 random bytes; never commit.                    |
| `GATEWAY_TOKEN_ISSUER`        | Stable deployment issuer.                                                      |
| `GATEWAY_TOKEN_AUDIENCE`      | Stable companion/gateway audience.                                             |
| `GATEWAY_CORS_ORIGINS`        | Exact HTTPS origins, empty unless a browser caller is required.                |
| `GATEWAY_TRUST_PROXY_TLS`     | Enable only behind a controlled TLS terminator with no direct listener access. |
| `GATEWAY_DEVICE_TOKEN_TTL_MS` | Optional; implementation default is 90 days, minimum 1 minute.                 |
| `GATEWAY_VAULT_TOKEN_TTL_MS`  | Optional; implementation default is 30 days, minimum 1 minute.                 |
| `GATEWAY_PAIRING_TTL_MS`      | Per request; default 5 minutes, allowed 30 seconds to 10 minutes.              |
| `GATEWAY_REQUEST_TIMEOUT_MS`  | Optional; session default 20 seconds.                                          |

Store only secret-manager references in deployment manifests. Never put real keys, account sessions, pairing codes, or signed tokens in environment examples, CI output, screenshots, or support logs.

## Composition Sketch

The operator's TypeScript service must instantiate and share these objects. This sketch omits framework-specific auth, database, shutdown, and error handling:

```ts
const tokens = new TokenService({
  repository,
  signingKey: secretManager.tokenSigningKey,
  issuer: "operator-approved-issuer",
  audience: "operator-approved-audience",
});

const pairing = new PairingService({
  repository,
  tokens,
  codeHmacKey: secretManager.pairingHmacKey,
});

const sessions = new GatewaySessionRegistry({
  repository,
  tokens,
  eventSink: productionEventSink,
});
const routing = new RequestRoutingService({ repository, sessions });
const gateway = createGatewayServer({
  auth: productionAuthProvider,
  pairing,
  sessions,
  trustProxyTlsHeader: true,
  corsAllowedOrigins: [],
});
gateway.httpServer.listen(privatePort, privateHost);
```

For each authenticated MCP user session, the MCP-facing service builds a `RemoteVaultAdapter` registry with descriptors sourced from server-side authorization records. It passes the same `routing` instance and the authenticated `UserSession`. Do not trust a client-provided descriptor, user ID, vault ownership claim, scope set, or expiry.

## TLS and Proxy Rules

`createGatewayServer` rejects plaintext by default. Because it creates a Node HTTP server, the expected production deployment is a private listener behind a TLS-terminating proxy:

- Set `trustProxyTlsHeader: true` only when the proxy overwrites `X-Forwarded-Proto` and direct client access to the listener is blocked.
- Forward WebSocket upgrades for the exact configured path, default `/v1/gateway`.
- Set request/body/timeouts at both proxy and Node layers.
- Disable proxy request/response body logging.
- Do not use `allowInsecureHttpForDevelopment` outside isolated local integration tests.
- Do not use wildcard CORS. Keep CORS empty for native-only clients.

The companion requires `wss://`; its pairing client converts that origin to `https://` for pairing/revocation endpoints and rejects redirects.

## Pairing and Separate Credentials

1. An authenticated account creates a one-time code for one vault ID and requested scopes.
2. The repository stores only the code's HMAC digest and metadata.
3. The companion sends the code, its vault ID/name, and a subset of requested scopes to the exchange endpoint.
4. Atomic exchange consumes the code and creates a device record, vault authorization, device token metadata, and vault token metadata.
5. The response contains two signed credentials:

| Credential                                   | Purpose                           | Scopes            | Default expiry |
| -------------------------------------------- | --------------------------------- | ----------------- | -------------- |
| `device_identity` (`deviceToken` wire field) | Identifies/revokes the device     | Empty             | 90 days        |
| `vault_authorization` (`vaultToken`)         | Authorizes this device/user/vault | Exact granted set | 30 days        |

The WebSocket hello must present both. The gateway verifies signatures, issuer/audience/type/JTI/expiry, persisted metadata, account/device/authorization state, IDs, and exact scopes.

If either credential expires, the companion refuses to connect and prompts for re-pairing. There is no refresh or silent renewal. A new code creates a new device record; operators should expose device inventory so users can remove the old record. Expired device credentials cannot use the current self-revocation endpoint, so account-side revocation is mandatory for production.

## Request and Write Flow

- The remote MCP adapter chooses one method and required scope.
- Routing verifies account, vault authorization, method policy, requested scope, online session, and parameter `vaultId`.
- Writes must contain an idempotency key. Duplicate in-flight keys for user/vault/method are rejected.
- The protocol adds request ID, device/vault/user identity, timestamp, and nonce.
- The companion repeats identity, age, nonce, method, paired-scope, enabled-scope, schema, and path checks.
- Offline companions return `VAULT_OFFLINE`; requests, especially writes, are not queued.
- Full-document replace, move, and trash require dry-run plans and exact confirmation in the remote adapter flow.

## Persistence and Retention

The durable repository may store only the fields in `MetadataInventory`: accounts, devices, vault authorizations, pairing-code digests/metadata, and token metadata. It must not store protocol parameters/results, note content, diffs, raw account sessions, raw codes, or signed tokens.

Production cleanup periods, backup retention, account deletion, and legal holds are not defined. Implement approved cleanup/deletion jobs before production. See [Privacy placeholder](privacy.md).

## Events

The companion produces metadata-only vault/note/active-note events. `GatewaySessionRegistry` validates each event separately from protocol responses, requires its vault ID to match the authenticated session, and passes it to an optional typed `GatewayEventSink`. With no sink, events are validated and discarded; the gateway does not persist them.

Production hosts must provide bounded dispatch, cache invalidation or client notification semantics, backpressure, and observability without note content. Event delivery is transient and has no durable queue.

## Deployment Validation

Before accepting users:

```shell
pnpm --filter @obsidian-workbench/remote-gateway typecheck
pnpm --filter @obsidian-workbench/remote-gateway test
pnpm --filter @obsidian-workbench/remote-gateway build
pnpm --filter @obsidian-workbench/mcp-server test
pnpm verify:release
```

Also run integration/security tests against the actual auth, database, proxy, secrets, and remote MCP layer. Test cross-user/cross-vault denial, atomic code exchange, revocation during active sessions, expired tokens, key rotation, offline writes, replay, payload limits, CORS/origin behavior, direct-listener isolation, deletion, and redaction.

## Troubleshooting

### `426 TLS is required`

The request reached the Node listener as plaintext without a trusted TLS indication. Use a TLS proxy and enable `trustProxyTlsHeader` only behind that proxy. Do not enable insecure development mode in production.

### WebSocket closes with authentication failure

- Verify both token types, issuer/audience, signing key, JTI metadata, and expiry.
- Verify account/device/authorization records are active and all user/device/vault IDs agree.
- Verify hello scopes exactly equal the vault token and authorization scopes.
- Re-pair if either credential expired; there is no refresh.
- Confirm the repository used by pairing is the same repository used by sessions.

### Pairing code is invalid, expired, or used

Generate a new code. Check clock synchronization and atomic `completePairing`. Never log the raw code to diagnose it. Ensure the companion's vault ID matches the code's vault ID and requested scopes are a subset of the grant.

### `VAULT_OFFLINE`

Confirm Obsidian is open, the plugin is enabled, auto-connect/current connection is active, the gateway URL/path is correct, and a matching device/vault session exists. The gateway intentionally does not queue the request.

### `PERMISSION_DENIED`

Compare four layers: account authorization record, vault token scopes, companion paired scopes, and currently enabled companion scopes. The required operation scope must be present everywhere. Also verify `params.vaultId` matches the route vault.

### `IDEMPOTENCY_CONFLICT`

Do not reuse an idempotency key for different mutation content. Wait for a legitimately identical in-flight operation or issue a new key for a new user action.

### Timeouts/capacity errors

Inspect aggregate timing and connection health without logging payloads. Default session request timeout is 20 seconds, max in-flight requests is 32, max message size is 1 MiB, and buffered output is bounded. Scale with per-user isolation and rate limits rather than removing limits.

### Browser CORS/origin rejection

Add the exact HTTPS origin to `corsAllowedOrigins`. Wildcards are rejected. Native companion connections normally omit `Origin`; do not fabricate one.

### Companion remains in `connecting`

The companion reports `online` only after the gateway verifies both credentials and sends a matching authenticated `ready` acknowledgement. Check token expiry, issuer/audience, persisted metadata, proxy WebSocket forwarding, and the gateway logs without recording credentials.
