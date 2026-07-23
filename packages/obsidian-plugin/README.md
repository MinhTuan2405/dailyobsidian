# Obsidian Workbench Companion

The companion exposes explicit, schema-validated Obsidian Workbench methods over an outbound authenticated WebSocket. Vault access uses Obsidian's `Vault`, `MetadataCache`, and `FileManager` APIs and is constrained by configured folders, paired scopes, currently enabled scopes, request identity, timestamps, and nonces.

It does not open an inbound listener or expose arbitrary commands, JavaScript, filesystem access, plugin management, configuration writes, or hard delete.

## Install in a Development Vault

From the repository root:

```shell
pnpm install --frozen-lockfile
pnpm --filter @obsidian-workbench/obsidian-plugin build
```

Copy exactly these deployables to `<vault>/.obsidian/plugins/obsidian-workbench/`:

```text
main.js
manifest.json
styles.css
```

Reload Obsidian, enable **Obsidian Workbench Companion**, then configure:

- A secure gateway URL using `wss://`.
- Allowed and excluded vault-relative roots. `.obsidian/` remains blocked.
- Minimum required scopes. Defaults are read-only metadata, note, task, and attachment reads.
- Auto-connect preference and local audit retention (10 to 1,000 entries, default 200).

Use only a disposable development vault until the remote operator has completed the production checklist.

## Pairing and Credentials

Pairing is account-initiated and vault-specific:

1. The signed-in user creates a short-lived code for one vault ID and scope set.
2. The user enters the code in this plugin.
3. The plugin sends the code, local vault ID/name, and currently enabled scopes to `POST /v1/pairing/exchange` over HTTPS derived from the WSS origin.
4. The gateway atomically consumes the code and returns two independent signed credentials.

| Stored credential   | Wire field    | Purpose                                   | Scopes           | Default expiry |
| ------------------- | ------------- | ----------------------------------------- | ---------------- | -------------- |
| Device identity     | `deviceToken` | Identifies and revokes one device         | None             | 90 days        |
| Vault authorization | `vaultToken`  | Authorizes that device/user for one vault | Exact paired set | 30 days        |

Both credentials, their expiry timestamps, device/user/vault IDs, scopes, and pairing time are stored in Obsidian plugin data. The authenticated WebSocket hello presents both credentials. The gateway requires their claims and persisted records to agree.

The device identity is not a vault permission token. The vault authorization cannot identify a different device/user/vault or add scopes. Changing currently enabled scopes can only reduce the active set; new scopes require new authorization/pairing.

## Expiry and Re-Pairing

Before connection, the plugin checks both expiry timestamps. If either credential has expired, it refuses to connect and displays **The gateway authorization expired. Pair this vault again.**

There is no refresh, renewal, or token rotation endpoint. Create a new one-time code and pair again. Re-pairing creates a new device identity; remove the previous device through the service account UI/API once the operator provides it. Re-pair after changing the vault identity or restoring plugin data into a different vault/device.

## Disconnect, Revocation, and Emergency Stop

- **Disconnect** stops reconnect attempts but retains credentials for a later connection.
- **Emergency disconnect** drops the active socket and in-memory connection credentials. It does not prove server-side revocation and does not remove stored plugin credentials.
- **Revoke device** calls `POST /v1/devices/revoke` with the device-identity credential, disconnects, and removes both local credentials. The gateway revokes the device, its vault mappings/token metadata, and active sessions.
- Local credentials are removed even if remote revocation fails. In that case, use the operator's account-side revocation path. That path is not implemented in this repository and is a production blocker.
- An expired device-identity credential cannot use the implemented self-revocation endpoint; account-side removal is therefore required for expired/lost devices.

## Token Storage Warning

Obsidian plugin data is not a hardware-backed secret store and may be included in Obsidian Sync, third-party sync, vault backups, or device backups. The settings screen never displays token values, but another process or plugin with local access may read them.

Protect the device and synced storage, do not paste plugin data into issues, and revoke a device after suspected exposure. Production operators must document key rotation, incident response, and account-side device management.

## Permission and Request Checks

Every remote request must match the paired device/user/vault, parameter vault ID, recent timestamp, unused nonce, allowed method, required paired scope, and currently enabled scope. Paths pass allowed/excluded root checks. Writes additionally require idempotency, expected revision where applicable, dry-run support, and confirmation for high-risk plans.

The local audit stores only timestamp, operation ID, method, bounded target, result code, duration, and whether confirmation was used. It does not store note bodies, diffs, or credentials. Users can clear it in settings.

## Events

The plugin produces metadata-only connection, note create/modify/rename/delete, metadata, and active-note events after folder-policy filtering. It does not include note bodies. The current remote gateway lacks an event consumer and may not safely accept these events; remote event support is not production-ready. See [remote bridge documentation](../../docs/remote-bridge.md).

## Development

```shell
pnpm --filter @obsidian-workbench/obsidian-plugin typecheck
pnpm --filter @obsidian-workbench/obsidian-plugin test
pnpm --filter @obsidian-workbench/obsidian-plugin build
```

`pnpm --filter @obsidian-workbench/obsidian-plugin dev` starts a watch build with an inline source map. The production build is minified without a source map and externalizes `obsidian`, Electron, CodeMirror, and Lezer host modules.

Public distribution remains blocked on owner/legal policy, license, production assets/listing review, remote service hardening, account lifecycle, and event handling. See the [release checklist](../../docs/release-checklist.md).
