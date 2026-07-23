# Public Release Checklist

This checklist covers both Obsidian Workbench and the preserved Python/FastMCP greeting prototype because one tag currently releases both. A checked item must have evidence linked in the release issue. Do not publish the draft GitHub release while any **Public blocker** remains.

## Ownership and Scope

- [ ] **Public blocker:** owner approves product name, repository ownership, release scope, supported platforms, and support/security contacts.
- [ ] **Public blocker:** owner confirms whether the remote bridge is excluded, private beta, or production-supported; documentation and listing use the same status.
- [ ] Confirm the public endpoint `https://dailynotesmcp.vercel.app/mcp` is described only as the Python greeting prototype, never as a Workbench vault bridge.
- [ ] Confirm no legacy marketplace manifest or deployed Python config was unintentionally changed.
- [ ] Confirm the master prompt, implementation, and release notes agree on actual tools and known limitations.

## Legal and Policy

- [ ] **Public blocker:** add an owner-approved repository license or decide not to distribute publicly.
- [ ] **Public blocker:** qualified legal review replaces `docs/privacy.md` placeholder decisions with an approved notice for the actual operator/deployment.
- [ ] **Public blocker:** qualified legal review replaces `docs/terms-placeholder.md` with approved terms where required.
- [ ] **Public blocker:** identify legal entity/controller, contact, jurisdictions, lawful bases, subprocessors, data residency/transfers, user-rights channel, breach contact, age policy, and effective dates.
- [ ] **Public blocker:** approve and implement retention/deletion schedules for logs, metadata, backups, audit entries, support data, and security events.
- [ ] **Public blocker:** implement and test account deletion, account-side device inventory/revocation, vault authorization removal, lost/expired-device recovery, and deletion confirmation.
- [ ] Verify marketing, docs, privacy notice, terms, product UI, and infrastructure behavior contain no contradictory claims.

## Security

- [ ] Review [threat model](threat-model.md) and accept or remediate every residual risk for the intended release mode.
- [ ] Confirm local HTTP remains loopback-only and documentation/config does not recommend unauthenticated public binding.
- [ ] Test traversal, absolute/UNC/drive paths, mixed separators, `.obsidian/`, excluded roots, move endpoints, symlink/junction escape, and relevant case sensitivity on supported OSes.
- [ ] Test stale revisions, changed-file races, idempotent replay, changed-payload key reuse, expired/replayed/wrong-target confirmation, and trash recovery.
- [ ] Test malicious note/frontmatter/link/task prompt injection without unauthorized reads, writes, network calls, or tool escalation.
- [ ] Confirm all tool annotations/descriptions match registration and no forbidden generic/shell/JavaScript/raw-filesystem/config/hard-delete tool exists.
- [ ] Search logs, errors, test output, traces, and release artifacts for note bodies, diffs, account sessions, pairing codes, device/vault tokens, confirmation tokens, paths, and secrets.
- [ ] Run dependency/license/vulnerability review for npm and Python dependency trees; record accepted risks.
- [ ] **Remote public blocker:** commission independent review of production auth, repository isolation/atomicity, proxy/TLS, CORS/origin, secret custody/rotation, remote MCP authentication, and account lifecycle.
- [ ] **Remote public blocker:** verify cross-user/cross-vault denial against the production database and authenticated MCP layer.
- [ ] **Remote public blocker:** implement distributed rate limits, abuse controls, key rotation, incident response, revocation propagation, redacted observability, backup security, and disaster recovery.
- [ ] **Remote public blocker:** wire the tested, schema-valid `GatewayEventSink` boundary to production cache invalidation/client notification with bounded dispatch and redacted observability, or explicitly document that validated events are discarded.
- [ ] Decide and implement artifact signing, checksums, provenance attestations, SBOM, and release-key custody.

## Credentials and Configuration

- [ ] Run `pnpm verify:release` and review its non-test source/config credential scan.
- [ ] Run an approved full-history secret scan; the metadata script scans the current tree only.
- [ ] Confirm `config/mcp.local.example.json` and `config/mcp-app.example.json` contain no secrets, tokens, personal paths, public unauthenticated endpoints, or machine-specific values.
- [ ] Confirm production signing and pairing HMAC keys are independent, random, at least 32 bytes, secret-manager supplied, access-audited, and absent from source/CI output.
- [ ] Confirm exact token issuer/audience and expiry policy; document that either credential expiry requires re-pairing because no refresh exists.
- [ ] Verify expired device identity can be revoked through an account-side path before production.
- [ ] Verify trusted proxy headers cannot be injected by direct clients and the private listener is network-isolated.

## Metadata and Documentation

- [ ] Set one `X.Y.Z` version in root/workspace package metadata, companion `manifest.json`, MCP server metadata, Python `pyproject.toml`, and preserved legacy plugin manifests.
- [ ] Confirm tag `vX.Y.Z` exactly matches the shared repository version.
- [ ] Run `pnpm verify:release`; confirm tool catalog has exactly every registered tool and no invented tools.
- [ ] Review README fresh-clone, local server, test vault, MCP App, companion install, remote bridge, security, and limitation instructions on a clean machine.
- [ ] Review architecture local/remote data, write, event, package, and trust-boundary flows against implementation.
- [ ] Review privacy inventory against production infrastructure and all subprocessors.
- [ ] Confirm package READMEs explain separate device-identity/vault-authorization credentials, storage, expiry, revocation, and re-pair behavior.
- [ ] Confirm changelog/release notes identify breaking schema, scope, credential, storage, or deployment changes.

## Assets and Listings

- [ ] **Public blocker:** replace every `placeholder` entry in `assets/manifest.json` with an owner-approved production asset matching [asset specifications](../assets/README.md).
- [ ] **Public blocker:** obtain rights/brand approval for icon, logo, and screenshots; retain editable sources outside release binaries as approved.
- [ ] Verify PNG dimensions, color profile, transparency/alpha rules, file-size caps, safe zones, contrast, and no real note/account/device/token data in screenshots.
- [ ] Add accurate alt text/captions and verify light/dark theme screenshots where required.
- [ ] Confirm Obsidian listing metadata, minimum app version, mobile/desktop claim, author identity, funding/support links, and privacy/terms URLs.
- [ ] Confirm legacy Daily Obsidian marketplace listing remains visibly separate from Workbench companion distribution.

## TypeScript Verification

- [ ] From a clean clone run `pnpm install --frozen-lockfile` with the declared pnpm and supported Node versions.
- [ ] Run `pnpm format:check`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
- [ ] Run `pnpm verify:release` after build and version changes.
- [ ] Test STDIO with a real MCP client and read-only disposable vault.
- [ ] Test loopback Streamable HTTP health/MCP behavior without exposing it to the network.
- [ ] Test MCP App in a compatible host: offline, search, note edit, capture, task toggle, diff, cancel, confirmation, conflict, and stale result.
- [ ] Test companion deployables in clean Obsidian development vaults on every claimed platform.
- [ ] Verify production companion `main.js` has no inline source map and only `main.js`, `manifest.json`, and `styles.css` are packaged.

## Python Prototype Verification

- [ ] From a clean clone run `uv sync --all-groups --locked` with Python 3.12.
- [ ] Run `uv run ruff check .`.
- [ ] Run `uv run pytest`.
- [ ] Run `uv build` and inspect wheel/sdist contents.
- [ ] Test packaged HTTP and STDIO entry points.
- [ ] Verify Vercel health/MCP routes, host allowlist, stateless behavior, and deployment domain.
- [ ] Confirm the Python build and legacy plugin versions match the tag.

## Packaging

- [ ] Inspect release workflow permissions and pin/approve action versions under repository policy.
- [ ] Confirm release workflow runs preserved Python checks/build plus frozen pnpm install, TypeScript lint/typecheck/test/build, and `verify:release`.
- [ ] Inspect Python wheel and sdist for unexpected files/secrets.
- [ ] Inspect companion ZIP: exactly `main.js`, `manifest.json`, and `styles.css` at archive root.
- [ ] Inspect MCP App archive: expected single HTML artifact and no credential/config injection. Decide whether source maps are public artifacts.
- [ ] Inspect TypeScript build archive and document that raw workspace `dist` output is not a standalone dependency bundle.
- [ ] Generate and verify checksums/signatures/provenance if approved.
- [ ] Install every artifact from the draft release rather than the working tree and repeat smoke tests.

## Publish and Rollback

- [ ] Create annotated/signed tag `vX.Y.Z` according to owner policy.
- [ ] Confirm workflow creates a **draft** release and all expected artifacts are attached.
- [ ] Record reviewer approvals and evidence for every checklist section.
- [ ] Resolve every public blocker before changing the draft to published.
- [ ] Publish marketplace/listing updates only after artifact URLs and approved policy URLs are stable.
- [ ] Monitor health, auth failures, revocations, error rates, and support/security channels without payload logging.
- [ ] Document rollback: withdraw listing/release, revoke/rotate credentials, disable remote routing, notify users, and preserve evidence.
- [ ] Conduct a post-release review and create tracked issues for accepted residual risks.

## Current Unresolved Public Blockers

As of Phase 8 packaging, the known blockers are: no repository license, privacy/terms owner/legal decisions, production assets, production remote auth/repository/bootstrap/account lifecycle, account deletion and account-side device management, production event-sink integration, external security review, production retention/subprocessor/data-residency decisions, and artifact signing/provenance decisions. The release workflow therefore creates a draft rather than publishing automatically.
