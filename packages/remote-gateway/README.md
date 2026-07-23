# Obsidian Workbench Remote Gateway

`@obsidian-workbench/remote-gateway` is a composable TypeScript library for pairing, scoped credentials, authenticated companion WebSocket sessions, and request routing. It brokers explicitly allowlisted Obsidian protocol methods and never mounts a vault or exposes shell, JavaScript, arbitrary methods, plugin management, config writes, or hard delete.

It is not a standalone production service. It has no executable, environment loader, production account provider, durable repository, remote MCP endpoint, account/deletion UI, or event consumer. `InMemoryAuthProvider` and `InMemoryGatewayRepository` are test doubles only.

## Exported Boundaries

- `AuthProvider`: validates an opaque account session and returns a bounded user session.
- `GatewayRepository`: metadata-only persistence with atomic pairing completion and revocation.
- `TokenService`: HMAC-signed, typed, expiring, JTI-tracked credentials.
- `PairingService`: one-time code creation/exchange and device revocation.
- `GatewaySessionRegistry`: authenticated bounded WebSocket sessions and request/response correlation.
- `RequestRoutingService`: account/user/vault/scope/method authorization and online-session routing.
- `createGatewayServer`: pairing/revocation/health HTTP boundary plus WSS upgrade handling.

The production host supplies concrete auth/database implementations, TLS proxying, independent secrets, remote MCP authentication, account lifecycle, rate limiting, redacted operations, and retention/deletion policy.

## Separate Credential Flow

Account login, device identity, and vault authorization are separate authorities:

1. The account session may create a one-time pairing code. It is not sent in the companion WebSocket hello and is not a device credential.
2. Pairing creates a revocable device record and issues a `device_identity` credential. It carries no operation scopes and defaults to 90 days.
3. Pairing separately creates one device/user/vault authorization and issues a `vault_authorization` credential with exact scopes. It defaults to 30 days.
4. The companion wire fields are `deviceToken` and `vaultToken`. Both are required during hello.
5. Session authentication verifies both signatures, issuer/audience/type/JTI/expiry, token metadata, active account/device/authorization records, IDs, and exact scopes.

Pairing codes contain 100 random bits in `XXXXXXXX-XXXX-XXXX-XXXX` form, default to five minutes (request range 30 seconds to ten minutes), are stored only as HMAC digests, and are atomically consumed.

There is no credential refresh. If either credential expires, the companion must re-pair. Re-pairing creates a new device. Production account tooling must list/remove old, expired, or lost devices because an expired device credential cannot call self-revocation.

Device revocation revokes the device, all its vault mappings, all token metadata for that device/user, and active sessions. Raw account sessions, pairing codes, and signed vault/device credentials are not repository fields and must never be logged.

## Session and Routing Security

- TLS is required. `createGatewayServer` rejects plaintext unless `allowInsecureHttpForDevelopment` is explicitly set.
- Behind a TLS proxy, `trustProxyTlsHeader` is safe only when direct listener access and header injection are blocked.
- CORS is empty by default; exact origins are supported and wildcard origins are rejected. WebSocket browser origins use the same allowlist.
- One current connection is retained per device/vault; a newer valid connection replaces the previous one.
- Hello, request, message, buffer, in-flight, completed-ID, nonce, and timeout state are bounded.
- Requests bind account, device, vault, exact method, one required scope, timestamp, nonce, and unique ID.
- Writes require an idempotency key and duplicate in-flight user/vault/method/key combinations are rejected.
- Offline requests fail immediately with `VAULT_OFFLINE`; nothing is queued.
- Companion responses and remote adapter outputs are schema-validated.

## HTTP and WebSocket Boundary

- `POST /v1/pairing/create`: account bearer session; body `{ vaultId, scopes, ttlMs? }`.
- `POST /v1/pairing/exchange`: one-time code; body `{ code, vaultId, vaultName, scopes }`.
- `POST /v1/devices/revoke`: device-identity bearer token; body `{ deviceId }`.
- `GET /health`: liveness only.
- `WSS /v1/gateway`: companion WebSocket and authenticated hello.

Request routing is intentionally an in-process service, not an arbitrary HTTP method proxy. The authenticated MCP-facing service invokes it through `RemoteVaultAdapter` using server-derived user and vault descriptors.

## Persisted Metadata Inventory

The `GatewayRepository` boundary persists only:

- Account IDs and lifecycle timestamps.
- Device IDs, owning user IDs, and lifecycle timestamps.
- Device/user/vault mappings, display-only vault names, granted scopes, and lifecycle timestamps.
- Pairing IDs, HMAC code digests, selected user/vault/scopes, expiry, and use timestamps.
- Token JTI/type/device/user/vault/scopes and issue/expiry/revocation timestamps.

It does not persist note bodies, tool request parameters, protocol responses, diffs, raw pairing codes, account-session secrets, or signed tokens. A production implementation must preserve this inventory, tenant isolation, and atomic `completePairing`. Retention and account deletion are external policy/implementation decisions documented as unresolved in [privacy.md](../../docs/privacy.md).

## Events Limitation

The companion can emit metadata-only vault events, but `GatewaySessionRegistry` currently handles protocol responses only and exports no event sink. Do not claim remote event support until a schema-valid, tenant-bound, bounded event path and tests are added.

## Development

```shell
pnpm --filter @obsidian-workbench/remote-gateway typecheck
pnpm --filter @obsidian-workbench/remote-gateway test
pnpm --filter @obsidian-workbench/remote-gateway build
```

Deployment composition, operator configuration, TLS rules, and troubleshooting are in [Remote bridge deployment](../../docs/remote-bridge.md). Public-release gates are in the [release checklist](../../docs/release-checklist.md).
