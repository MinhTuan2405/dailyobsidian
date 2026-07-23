# Threat Model

This document models the implemented Obsidian Workbench TypeScript suite. The preserved public Python/FastMCP greeting prototype has no vault access and is outside the vault-specific threats below.

## Security Objectives

- Only an authorized user, device, vault, folder, method, and permission scope can expose or mutate vault data.
- Note content remains data and cannot change authority or agent instructions.
- Mutations are explicit, reviewable, revision-safe, idempotent, and recoverable where practical.
- Secrets and note bodies do not enter Workbench-controlled logs or gateway metadata storage.
- A remote failure is bounded, timely, revocable, and does not silently queue a destructive action.

## Protected Assets

- Markdown note bodies, frontmatter, links, tasks, attachments, paths, titles, and graph relationships.
- Integrity and availability of vault files, link structure, task state, and Obsidian configuration.
- Vault roots, allowed/excluded folder policy, stable note IDs, and conventions.
- Account sessions, one-time pairing codes, device-identity credentials, vault-authorization credentials, confirmation tokens, idempotency records, and signing/HMAC keys.
- Account/device/vault authorization metadata, local audit records, and operational logs/backups.
- MCP App integrity, package/release artifacts, dependency chain, and repository credentials.

## Actors

- A legitimate local user and vault owner.
- A legitimate MCP host/model operating under user instructions.
- A remote account owner and service operator.
- An attacker who controls text inside a note or imported Markdown.
- A malicious or compromised MCP host, model session, browser host, Obsidian plugin, local process, device, account, gateway, database, reverse proxy, dependency, or CI environment.
- Another legitimate tenant/device attempting cross-user or cross-vault access because of a routing or persistence defect.

## Trust Boundaries

- **Note content to agent:** note text, frontmatter, links, embeds, and task text are untrusted.
- **MCP host to server:** the host can request exposed tools; annotations inform behavior but do not authenticate callers.
- **Server to vault adapter:** schemas, vault IDs, scopes, and write-safety fields must be validated before adapter calls.
- **Vault adapter to filesystem/Obsidian:** paths and revisions cross into stateful local storage.
- **MCP App to host bridge:** the app can call only host-exposed tools, but the host controls the bridge and rendered environment.
- **Companion to gateway:** an outbound TLS WebSocket crosses an untrusted network and presents two scoped credentials.
- **Gateway to auth/repository:** external implementations determine account identity, atomic pairing, revocation, and metadata isolation.
- **Operator infrastructure:** proxy, logs, metrics, databases, backups, secret manager, and incident response are outside this codebase.
- **Legacy deployment:** the Python greeting endpoint is separate and must never be assumed to authenticate or proxy Workbench requests.

## Threats and Controls

### Prompt injection in vault content

**Threat:** A note says to ignore instructions, upload a vault, call a URL, reveal secrets, run a command, or delete notes. Linked/embedded content can carry the same payload.

**Mitigations:** Note and search/context schemas mark returned content as `untrustedContent: true`; tool descriptions are intent-specific; there is no shell, JavaScript, generic execute, raw filesystem, plugin-management, configuration-write, or hard-delete tool. Skills instruct the agent not to treat note content as authority. Writes still require schemas, scopes, write-safety fields, and confirmation when the plan requires it.

**Residual risk:** MCP hosts and models enforce instruction hierarchy. A compromised or poorly behaved host may ignore labels, request broad reads, or socially engineer a user into confirming a harmful diff. Workbench cannot prevent a user from intentionally authorizing harmful content.

### Path traversal and absolute-path access

**Threat:** Inputs such as `../secret.md`, absolute/UNC/drive paths, mixed separators, encoded-looking traversal, or move destinations escape the vault or folder policy.

**Mitigations:** Dedicated path policy normalizes relative paths, rejects absolute and traversal forms, resolves against a canonical vault root, blocks `.obsidian/`, enforces allowed/excluded roots, and validates both move endpoints. Tools operate on stable note IDs where possible rather than arbitrary paths.

**Residual risk:** Filesystem semantics differ by OS and mounted filesystem. Newly discovered normalization, case-folding, junction, network filesystem, or race behavior may require additional tests. The companion relies on Obsidian's abstract vault paths and official APIs rather than OS sandboxing.

### Symlink or junction escape

**Threat:** An allowed in-vault path points outside the vault through a symlink/junction, including a parent introduced after validation.

**Mitigations:** Filesystem path authorization resolves real paths and rejects symlink escape; destination and source are checked repeatedly around writes; writes use file handles and identity/revision checks.

**Residual risk:** There is no OS-level sandbox. A privileged local attacker able to race filesystem metadata may still create platform-specific time-of-check/time-of-use conditions. Do not run the server with elevated privileges.

### Stale or conflicting writes

**Threat:** A note changes after it is read, causing silent overwrite or a task update at the wrong location.

**Mitigations:** Existing-note mutations require a deterministic SHA-256 `expectedRevision`; content is checked through an open handle and again immediately before mutation. Conflicts return `REVISION_CONFLICT` with expected/current revisions. Task identity includes block ID or fingerprint/location data. The system does not silently retry on newer content.

**Residual risk:** Create operations have no prior revision and can race for a destination; exclusive creation prevents overwrite but returns an error. Obsidian or filesystem crashes can still interrupt an underlying operation. Users need normal vault backup/versioning.

### Replay and duplicate mutation

**Threat:** An attacker reuses a confirmation, protocol request, response ID, nonce, pairing code, or idempotency key.

**Mitigations:** Pairing codes are single-use and stored as HMAC digests. Confirmation tokens are short-lived, exact-mutation-bound, and single-use. Idempotency binds tool/key/request hash and rejects changed payloads. Remote requests have unique IDs, timestamps, nonces, bounded replay sets, and duplicate in-flight mutation rejection. Unknown/replayed response IDs close the session.

**Residual risk:** Several replay/idempotency stores are in memory and bounded. Restart clears local mutation history and old nonce state; sufficiently old entries age out. A production repository must atomically consume pairing codes and preserve token/revocation metadata across restarts.

### Cross-user access

**Threat:** One tenant routes a request to another tenant's device or receives another tenant's vault response.

**Mitigations:** The route requires a valid user session and matching account, authorization `userId`, vault ID, scope, online session identity, and request parameters. Device and vault credentials carry the same user identity and are checked against persisted records. The companion verifies `userId` again.

**Residual risk:** Isolation depends on the production `AuthProvider` and `GatewayRepository`, neither of which is shipped. A query/transaction bug, operator privilege, or compromised signing key can defeat application checks. Independent multi-tenant review and tests are required before hosting.

### Cross-vault access

**Threat:** A valid account/device uses one vault authorization to read or mutate another vault.

**Mitigations:** Vault authorization is bound to user, device, vault, and exact scopes. MCP parameters, remote descriptor, route input, session identity, authorization record, token claims, companion settings, and adapter all compare `vaultId`. Each local registry adapter is selected by exact ID.

**Residual risk:** Stable vault IDs are application identifiers, not cryptographic proof of vault contents. Reusing/migrating plugin data or misconfiguring a production repository can bind an ID to the wrong physical vault. Re-pair after cloning or moving identity-bearing plugin data.

### Mass deletion or destructive automation

**Threat:** A model, malicious note, compromised host, or user mistake trashes many notes.

**Mitigations:** There is no hard-delete tool. `obsidian.trash_note` is the only tool annotated destructive, requires `notes.trash`, expected revision, idempotency, dry-run plan, and exact confirmation. Move is also high-risk and confirmation-required. Skills cannot implicitly perform destructive workflows.

**Residual risk:** There is no batch quota, velocity limit, global kill switch in local filesystem mode, or automatic restore. A caller can repeatedly obtain confirmations. Companion emergency disconnect limits remote activity but does not repair prior mutations. Maintain independent backups and review each target.

### Token theft

**Threat:** Malware, sync/backup leakage, logs, browser storage, or a compromised gateway steals account, device, vault, pairing, or confirmation credentials.

**Mitigations:** Signed tokens are bounded, typed, scoped, expiring, revocable, and tracked by JTI metadata. Device identity has no operation scopes; vault authorization is separate. Raw gateway tokens and pairing codes are not repository fields or intended log fields. Plugin settings do not display tokens. TLS is required remotely. Device revocation closes sessions and revokes all device token metadata/mappings.

**Residual risk:** Obsidian plugin data is not hardware-backed and may be synced/backed up. Default device/vault lifetimes are 90/30 days. There is no refresh/rotation flow and no account-side device-management UI in this repository. An expired device identity cannot call the implemented self-revocation endpoint; account-side revocation must be supplied externally. Signing-key compromise enables forged credentials until key rotation and metadata remediation.

### Log or telemetry leakage

**Threat:** Note bodies, prompts, tokens, diffs, paths, or request parameters enter logs, metrics, crash reports, traces, or backups.

**Mitigations:** Tool failures return stable safe errors; server startup logs no configuration; companion audit records only time, operation/method, bounded target, result, duration, and confirmation use. The gateway repository excludes request parameters/results and raw credentials. HTTP responses use `no-store` at the gateway boundary.

**Residual risk:** MCP hosts, reverse proxies, cloud platforms, Obsidian, browser tools, and operator instrumentation can log payloads outside this code. Paths/titles can themselves be sensitive. Production logging/retention and redaction are unresolved owner/operator policy.

### Malicious or compromised companion

**Threat:** A modified companion lies about results, leaks content, replays responses, or invokes local Obsidian privileges outside Workbench policy.

**Mitigations:** Gateway requests are method-allowlisted and schema-bound; responses are schema-validated by the session and remote adapter; request IDs/timeouts limit confusion. Scope/vault records restrict what the service requests.

**Residual risk:** The gateway cannot attest companion code or prove that returned data came from the claimed vault. A malicious Obsidian plugin/process already has local vault access and can exfiltrate independently of Workbench. Install only reviewed builds and protect the device.

### Remote service compromise

**Threat:** A gateway/MCP service attacker reads transient note data, routes unauthorized operations, steals keys/metadata, disables revocation, or impersonates users/devices.

**Mitigations:** Least-privilege scopes, separate credentials, metadata-only repository contracts, outbound companion connection, explicit method policy, bounded messages/sessions, TLS, no offline queue, and local companion reauthorization reduce blast radius.

**Residual risk:** TLS terminates at operator infrastructure and payloads are not end-to-end encrypted. A service with account authority and signing keys can request any operation within active scopes and observe responses. Production hardening, network segmentation, key custody/rotation, audits, incident response, and external review are not provided.

### Local MCP endpoint exposure

**Threat:** Another local or network process invokes tools through unauthenticated HTTP.

**Mitigations:** STDIO is default; HTTP defaults to `127.0.0.1`; host allowlisting is available; documentation prohibits public/LAN binding.

**Residual risk:** Processes in the same user/session can often connect to loopback and may read inherited environment or vault files. There is no HTTP bearer authentication. Prefer STDIO and OS account isolation.

### Denial of service and resource exhaustion

**Threat:** Large notes, broad scans, message floods, connection churn, or slow companions consume CPU/memory/file descriptors.

**Mitigations:** File sizes, pagination, snippets, graph depth/nodes, JSON/WebSocket payloads, buffers, in-flight requests, completed IDs, nonces, timeouts, and reconnect behavior are bounded. Offline requests fail rather than queue.

**Residual risk:** Orphan/hub analysis can perform many link queries over up to 200 notes. Local authorized users can repeatedly scan. Distributed rate limiting and production capacity controls are external.

### Supply-chain and release compromise

**Threat:** A dependency, build host, artifact, or repository token injects malicious code or credentials.

**Mitigations:** Lockfiles, frozen installs in CI, static checks/tests/builds, package/version verification, credential scanning, minimal Obsidian deployables, and draft releases support review.

**Residual risk:** No artifact signing, provenance attestation, SBOM, dependency vulnerability gate, or reproducible-build proof is currently configured. Public release requires owner decisions and CI hardening.

## Security Assumptions

- The local OS account, Node/Python runtimes, Obsidian installation, and MCP host are not fully compromised.
- Production TLS and proxy configuration prevent header spoofing and direct access to an insecure listener.
- Production auth/repository implementations preserve user isolation, atomic pairing, revocation, and metadata constraints.
- Users select least-privilege roots/scopes, inspect high-risk diffs, and maintain backups.
- Tool annotations do not replace server-side permission checks.

## Required Pre-Release Work

The public release checklist tracks the unresolved controls. Highest-priority items are production remote composition and review, account/device deletion and revocation paths, event handling, legal/privacy approval, asset completion, dependency/security review, and artifact provenance/signing decisions.
