# Privacy Notice Placeholder

> **Not an approved privacy notice.** This document is an engineering inventory of current data flows plus explicit policy placeholders. It must not be presented as a legal promise or public privacy policy until the product owner, service operator, and qualified legal reviewer supply and approve every item marked **OWNER/LEGAL DECISION REQUIRED**.

## Product Boundary

Obsidian Workbench has two materially different modes:

- **Local filesystem mode:** a user-controlled Node process reads an explicitly configured vault and communicates with a local MCP host over STDIO or loopback HTTP.
- **Remote companion mode:** a separately operated MCP/account service routes requested operations through a gateway to an Obsidian companion over an outbound TLS WebSocket.

The repository also deploys a separate Python/FastMCP greeting prototype. That endpoint exposes only greeting components and is not a Workbench data processor.

## Data Processed Locally

Depending on tools used, the local MCP server or companion may process:

- Vault names/IDs, allowed and excluded roots, capability scopes, and conventions.
- Note paths, IDs, titles, timestamps, bodies, frontmatter, headings, tags, links, backlinks, unresolved links, graph relationships, and search snippets.
- Task text/status/dates/tags/priority/location.
- Proposed content, revisions, mutation hashes, diffs, idempotency keys, and confirmation tokens.
- Companion device/vault settings, stable note-ID mappings, and bounded audit entries.

Filesystem mode does not include a Workbench cloud upload. The selected MCP host still receives tool results and may independently transmit, retain, or train on them under that host's policy. Users must review the MCP host's privacy controls.

## Data Sent Remotely

Remote mode sends only data needed for the requested operation and connection lifecycle, but that can include full note content or diffs when the user invokes a corresponding tool:

- Account session context at the MCP/service boundary.
- Account/device/vault IDs, display-only vault name, granted/requested scopes, timestamps, request IDs, nonces, method name, and method parameters.
- Tool responses, which may contain note/task content, metadata, search snippets, mutation plans, or errors.
- Companion events with event type, vault ID, occurrence time, and optional authorized path/note ID. Events do not include note bodies.
- One-time pairing code during exchange and signed device/vault credentials during authenticated connection.

Traffic must use HTTPS/WSS. There is no application-level end-to-end encryption beyond TLS; endpoint processes can see request and response payloads in memory.

## Stored Data

### Local filesystem mode

The MCP server does not implement a durable note index. It reads the source vault directly. Its idempotency and confirmation stores are in process memory and are lost on restart.

### Companion plugin data

Obsidian plugin data stores:

- Gateway URL, auto-connect choice, generated vault ID, roots, and enabled scopes.
- Device ID, user ID, paired vault ID, separate signed device-identity and vault-authorization credentials, their expiry timestamps, granted scopes, and pairing time.
- Stable path-to-note-ID mappings.
- Local audit entries: timestamp, operation ID, method, bounded target path/note/task ID, result code, duration, and whether confirmation was used.

The default audit limit is 200 entries and is configurable from 10 to 1,000. This is count-based, not time-based retention. The settings UI supports clearing the audit. Plugin data may be included in Obsidian Sync, third-party sync, backups, or device backups based on user configuration.

### Remote gateway repository boundary

The repository interface stores only:

- Account ID and lifecycle timestamps.
- Device ID, owning user ID, and lifecycle timestamps.
- Device/user/vault mapping, display vault name, granted scopes, and lifecycle timestamps.
- Pairing identifier, HMAC code digest, user/vault/scopes, expiry, and use timestamps.
- Token JTI/type/device/user/vault/scopes and issue/expiry/revocation timestamps.

The gateway repository contract does not store note bodies, tool request parameters, tool responses, raw pairing codes, raw account sessions, or signed device/vault tokens. Production implementations must preserve that constraint and make pairing completion atomic.

## Data Not Stored by Default

- No Workbench cloud search or embeddings index is implemented.
- The gateway's defined persistence boundary excludes note bodies, note results, requests, responses, and signed credentials.
- Companion audit entries exclude note bodies, diffs, and credentials.
- Pairing codes are stored only as HMAC digests and become unusable after exchange/expiry.

"Not stored by default" does not cover MCP host history, model-provider retention, reverse-proxy access logs, APM/tracing, crash reports, platform logs, database backups, or custom production code. Operators must document and configure those systems separately.

## Retention

Implemented technical behavior:

- Pairing codes expire in 5 minutes by default; creation accepts 30 seconds through 10 minutes.
- Device-identity credentials expire after 90 days by default.
- Vault-authorization credentials expire after 30 days by default.
- The test-only in-memory account session defaults to 1 hour; production session lifetime belongs to the external `AuthProvider`.
- Local companion audit retention is count-based, default 200 entries.
- No automatic deletion schedule is implemented for expired/revoked gateway metadata records.

**OWNER/LEGAL DECISION REQUIRED:** define production log, pairing metadata, device record, authorization record, token metadata, account record, audit, backup, disaster-recovery, support, and security-event retention periods. Define deletion from primary stores and backups, legal holds, and regional requirements. Until approved and implemented, no time-based production retention promise may be made.

## Token and Secret Handling

- Account sessions, device identity, and vault authorization are separate credentials.
- Device identity carries no operation scopes; vault authorization is bound to one user/device/vault and exact scopes.
- Device/vault tokens include issuer, audience, type, IDs, scopes, issued/expiry times, and JTI; HMAC signing keys must be at least 32 bytes.
- Pairing-code and token-signing HMAC keys must be independent and loaded from a production secret manager.
- The companion stores both signed credentials in Obsidian plugin data. This is not hardware-backed secret storage.
- Credentials must not appear in source, committed config, logs, analytics, screenshots, support tickets, or release artifacts.

**OWNER/SECURITY DECISION REQUIRED:** choose secret manager, key rotation/overlap/revocation strategy, access controls, incident response, and whether stronger platform credential storage is required.

## Expiry, Re-Pairing, Revocation, and Device Removal

- The companion checks both stored expiry timestamps before connecting. If either credential expires, it asks the user to pair the vault again. No refresh flow exists.
- Re-pairing creates a new device identity and vault authorization; it is not silent renewal.
- Device revocation with a valid device-identity credential revokes the device, all its vault mappings, all token metadata, and active sessions.
- The companion removes local credentials even if its remote revocation request fails. In that failure case, the user must use an operator/account-side revocation path.
- Disconnect and emergency disconnect stop the current connection but are not equivalent to server-side revocation.

**OWNER/PRODUCT DECISION REQUIRED:** implement and document account-side device listing/revocation, lost-device recovery, expired-device removal, per-vault authorization removal, and confirmation that revocation propagated. The current repository has no account UI/API for these actions.

## Account Deletion

No production account deletion workflow is implemented.

**OWNER/LEGAL DECISION REQUIRED:** define identity verification, self-service/support process, deletion scope, grace period, security/legal exceptions, propagation to accounts/devices/authorizations/token metadata/pairing metadata/logs/backups, completion notice, and target timeline. Implement and test it before collecting production account data. Do not advertise an account-deletion SLA until approved.

## User Controls

Implemented controls include local-only mode, per-vault roots/scopes, read-only defaults, connect/disconnect, emergency disconnect, local audit clearing, device revocation attempt, credential expiry, dry-run diffs, and write confirmation.

Production service controls such as data export, account deletion, device inventory, consent records, support contact, and privacy requests are not included.

## Production Notice Placeholders

Every item below blocks publication of a legal privacy notice:

- **OWNER/LEGAL DECISION REQUIRED:** legal entity/data controller and postal/contact details.
- **OWNER/LEGAL DECISION REQUIRED:** jurisdictions, lawful bases, purposes, and categories of data subjects/data.
- **OWNER/LEGAL DECISION REQUIRED:** model/MCP providers, cloud/hosting/database/monitoring/support subprocessors and links to their terms.
- **OWNER/LEGAL DECISION REQUIRED:** data residency and international transfer mechanisms.
- **OWNER/LEGAL DECISION REQUIRED:** exact retention schedule and backup deletion.
- **OWNER/LEGAL DECISION REQUIRED:** user rights/request process, identity verification, appeal/complaint process, and regulator details.
- **OWNER/LEGAL DECISION REQUIRED:** children/age policy, cookies/browser storage, analytics, marketing, and sale/share disclosures where applicable.
- **OWNER/LEGAL DECISION REQUIRED:** security-contact and breach-notification process.
- **OWNER/LEGAL DECISION REQUIRED:** effective date, versioning, and change-notice process.

Related placeholder: [Terms of service](terms-placeholder.md). Engineering review: [Threat model](threat-model.md).
