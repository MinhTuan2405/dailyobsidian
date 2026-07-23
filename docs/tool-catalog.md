# MCP Tool Catalog

This catalog is derived from the registrations in `packages/mcp-server/src/tools/` and `packages/mcp-server/src/app/workbench-app.ts`. It documents 26 actual tools: 17 read tools, 8 write tools, and 1 app-only confirmation tool. It does not include aspirational or forbidden tools.

## Conventions

- All vault operations are closed-world: `openWorldHint=false`. They do not authorize external network access.
- `vaultId`, `noteId`, and `taskId` are stable IDs, not arbitrary filesystem handles.
- Read content is untrusted. `NoteDocument`, search, and context outputs label that fact.
- Paginated outputs contain `items`, optional `nextCursor`, and optional/defined `total` depending on the operation. General pagination limit is 1 to 200; search limit is 1 to 100.
- Every write requires `idempotencyKey` (8 to 256 characters), defaults `dryRun` to true, and accepts optional `confirmationToken`. Existing-note/task writes also require a SHA-256 `expectedRevision`.
- Mutation output is `MutationResult`: `operationId`, `status` (`preview`, `applied`, or `unchanged`), optional note identity/diff/plan, and `idempotentReplay`.
- A failed tool sets MCP `isError` and returns `{ "error": { "code", "message", "recoverable", "details"? } }`. Defined codes are `VAULT_OFFLINE`, `VAULT_NOT_FOUND`, `NOTE_NOT_FOUND`, `PATH_NOT_ALLOWED`, `PATH_TRAVERSAL_BLOCKED`, `SYMLINK_ESCAPE_BLOCKED`, `REVISION_CONFLICT`, `VALIDATION_ERROR`, `PERMISSION_DENIED`, `CONFIRMATION_REQUIRED`, `IDEMPOTENCY_CONFLICT`, `UNSUPPORTED_OPERATION`, and `INTERNAL_ERROR`.
- Scopes are enforced by adapters and, remotely, again by gateway and companion routing. Tool annotations are host hints, not permission checks.

## Read Tools

### `obsidian.list_vaults`

- **User intent:** List authorized Obsidian vaults available to the current local configuration or authenticated remote user.
- **Input:** Empty object.
- **Output:** `{ vaults: VaultInfo[] }`, sorted by vault display name; each item includes status, capabilities/scopes, folder policy, and conventions.
- **Scope:** Effectively `vault.metadata.read` on each registered adapter because listing obtains each vault's `VaultInfo`; no note content scope.
- **Annotations:** `readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Never. This tool is model/app visible and links the MCP App resource.
- **Common errors:** `PERMISSION_DENIED` when metadata scope is unavailable; `VAULT_OFFLINE` for remote metadata failure where not represented as offline info; `INTERNAL_ERROR` for registry/adapter failure.

### `obsidian.get_vault_info`

- **User intent:** Inspect an authorized vault's status, capabilities, folder policy, or conventions.
- **Input:** `vaultId`.
- **Output:** `VaultInfo` with name, connection status/mode, capability scopes/flags, allowed/excluded roots, and conventions.
- **Scope:** `vault.metadata.read`.
- **Annotations:** `readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Never.
- **Common errors:** `VAULT_NOT_FOUND`, `VAULT_OFFLINE`, `PERMISSION_DENIED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`.

### `obsidian.get_connection_status`

- **User intent:** Determine whether an authorized local or remote vault is online.
- **Input:** `vaultId`.
- **Output:** `ConnectionStatus`: state, mode, and optional last connection/error fields.
- **Scope:** `vault.metadata.read`.
- **Annotations:** `readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Never.
- **Common errors:** `VAULT_NOT_FOUND`, `VAULT_OFFLINE`, `PERMISSION_DENIED`, `INTERNAL_ERROR`.

### `obsidian.get_vault_conventions`

- **User intent:** Read configured inbox, daily-note, template, date, task, link-style, and frontmatter conventions before capture/review workflows.
- **Input:** `vaultId`.
- **Output:** `VaultConventions` with `inboxFolder`, `dailyNotesFolder`, `dailyNoteFormat`, `dateFormat`, `templatePaths`, `taskSyntax`, `preferredLinkStyle`, and `defaultFrontmatter`.
- **Scope:** `vault.metadata.read`.
- **Annotations:** `readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Never.
- **Common errors:** `VAULT_NOT_FOUND`, `VAULT_OFFLINE`, `PERMISSION_DENIED`, `INTERNAL_ERROR`.

### `obsidian.list_notes`

- **User intent:** Browse or filter note summaries in an authorized vault.
- **Input:** `vaultId`; optional `folder`, `tags`, created/modified time bounds, `sort` (`title`, `created`, `modified`), `order`, `limit`, and cursor.
- **Output:** Paginated `NoteSummary` items with identity/revision, timestamps, tags, and optional bounded excerpt.
- **Scope:** `notes.read` plus folder policy.
- **Annotations:** `readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Never.
- **Common errors:** `VAULT_NOT_FOUND`, `VAULT_OFFLINE`, `PERMISSION_DENIED`, `PATH_NOT_ALLOWED`, `SYMLINK_ESCAPE_BLOCKED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`.

### `obsidian.search_notes`

- **User intent:** Find notes in an authorized vault without returning full vault content.
- **Input:** `vaultId` and `search`: non-empty query, mode (`text`, `metadata`, `hybrid`), folder allow/exclude filters, tags, frontmatter equality filters, limit, and cursor.
- **Output:** `{ hits, nextCursor?, total, untrustedContent: true }`; each hit has note identity, score, snippet (max 2,000 schema characters; filesystem implementation bounds it further), line range, and matched fields.
- **Scope:** `notes.read` plus folder policy.
- **Annotations:** `readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Never.
- **Common errors:** `VAULT_NOT_FOUND`, `VAULT_OFFLINE`, `PERMISSION_DENIED`, `PATH_NOT_ALLOWED`, `SYMLINK_ESCAPE_BLOCKED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`.

### `obsidian.get_note`

- **User intent:** Read a specific authorized note and selected metadata.
- **Input:** `vaultId`, `noteId`; booleans for content, frontmatter, headings, links, backlinks, and unresolved links (content/frontmatter/headings/links/unresolved default true; backlinks default false).
- **Output:** `NoteDocument` identity/revision/timestamps and selected fields, `untrustedContent: true`, plus optional backlinks.
- **Scope:** `notes.read` plus path policy.
- **Annotations:** `readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Never.
- **Common errors:** `VAULT_NOT_FOUND`, `NOTE_NOT_FOUND`, `VAULT_OFFLINE`, `PERMISSION_DENIED`, `PATH_NOT_ALLOWED`, `SYMLINK_ESCAPE_BLOCKED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`.

### `obsidian.get_note_context`

- **User intent:** Inspect links, headings, embeds, related notes, and a bounded graph around an authorized note.
- **Input:** `vaultId`, `noteId`, optional `depth` (1 to 2, default 1) and `maxNodes` (1 to 200, default 100).
- **Output:** Backlinks, outgoing/unresolved links, headings, embedded note IDs, related summaries, bounded graph, and `untrustedContent: true`.
- **Scope:** `notes.read`; server-computed composition of note, link, graph, and a bounded note listing.
- **Annotations:** `readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Never.
- **Common errors:** `VAULT_NOT_FOUND`, `NOTE_NOT_FOUND`, `VAULT_OFFLINE`, `PERMISSION_DENIED`, `PATH_NOT_ALLOWED`, `SYMLINK_ESCAPE_BLOCKED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`.

### `obsidian.get_daily_note`

- **User intent:** Read the authorized daily note for a specific local date using vault conventions.
- **Input:** `vaultId`, ISO local `date` (`YYYY-MM-DD`), and the same inclusion booleans as `get_note`.
- **Output:** `NoteDocument` with optional backlinks and `untrustedContent: true`.
- **Scope:** `notes.read` plus path policy and conventions.
- **Annotations:** `readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Never.
- **Common errors:** `VAULT_NOT_FOUND`, `NOTE_NOT_FOUND`, `VAULT_OFFLINE`, `PERMISSION_DENIED`, `PATH_NOT_ALLOWED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`.

### `obsidian.list_recent_notes`

- **User intent:** List recently modified authorized notes.
- **Input:** `vaultId`, optional offset-aware `modifiedAfter`, `limit`, and cursor.
- **Output:** Paginated `NoteSummary` items.
- **Scope:** `notes.read` plus folder policy.
- **Annotations:** `readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Never.
- **Common errors:** `VAULT_NOT_FOUND`, `VAULT_OFFLINE`, `PERMISSION_DENIED`, `PATH_NOT_ALLOWED`, `SYMLINK_ESCAPE_BLOCKED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`.

### `obsidian.get_backlinks`

- **User intent:** Find authorized notes that link to a specific note.
- **Input:** `vaultId`, `noteId`.
- **Output:** `{ backlinks: Backlink[] }` with source note/path, target note, line, and bounded context.
- **Scope:** `notes.read` plus path policy.
- **Annotations:** `readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Never.
- **Common errors:** `VAULT_NOT_FOUND`, `NOTE_NOT_FOUND`, `VAULT_OFFLINE`, `PERMISSION_DENIED`, `PATH_NOT_ALLOWED`, `SYMLINK_ESCAPE_BLOCKED`, `INTERNAL_ERROR`.

### `obsidian.get_outlinks`

- **User intent:** Inspect wikilinks emitted by a specific authorized note.
- **Input:** `vaultId`, `noteId`.
- **Output:** `{ outlinks: WikiLink[] }` with target/alias/heading/block/embed/line and optional resolved note ID.
- **Scope:** `notes.read` plus path policy.
- **Annotations:** `readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Never.
- **Common errors:** `VAULT_NOT_FOUND`, `NOTE_NOT_FOUND`, `VAULT_OFFLINE`, `PERMISSION_DENIED`, `PATH_NOT_ALLOWED`, `SYMLINK_ESCAPE_BLOCKED`, `INTERNAL_ERROR`.

### `obsidian.get_unresolved_links`

- **User intent:** Find unresolved wikilinks in a specific authorized note.
- **Input:** `vaultId`, `noteId`.
- **Output:** `{ unresolvedLinks: UnresolvedLink[] }` including source note and unresolved target metadata.
- **Scope:** `notes.read` plus path policy.
- **Annotations:** `readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Never.
- **Common errors:** `VAULT_NOT_FOUND`, `NOTE_NOT_FOUND`, `VAULT_OFFLINE`, `PERMISSION_DENIED`, `PATH_NOT_ALLOWED`, `SYMLINK_ESCAPE_BLOCKED`, `INTERNAL_ERROR`.

### `obsidian.get_graph_neighborhood`

- **User intent:** Read a bounded local graph around one authorized note.
- **Input:** `vaultId`, `noteId`, optional depth 1 to 2 and max nodes 1 to 200.
- **Output:** `{ graph: { nodes, edges, truncated } }`; node depth is at most 2 and node count at most 200.
- **Scope:** `notes.read` plus path policy.
- **Annotations:** `readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Never.
- **Common errors:** `VAULT_NOT_FOUND`, `NOTE_NOT_FOUND`, `VAULT_OFFLINE`, `PERMISSION_DENIED`, `PATH_NOT_ALLOWED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`.

### `obsidian.find_orphan_notes`

- **User intent:** Report authorized notes with no incoming or outgoing wikilinks.
- **Input:** `vaultId`.
- **Output:** `{ notes: NoteSummary[], truncated: boolean }`. The server examines at most the first 200 notes and marks truncation when more exist.
- **Scope:** `notes.read`; server-computed from listing/backlink/outlink calls.
- **Annotations:** `readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Never; report-only.
- **Common errors:** `VAULT_NOT_FOUND`, `VAULT_OFFLINE`, `PERMISSION_DENIED`, `PATH_NOT_ALLOWED`, `SYMLINK_ESCAPE_BLOCKED`, `INTERNAL_ERROR`.

### `obsidian.find_hub_notes`

- **User intent:** Rank authorized notes by incoming plus outgoing wikilink count.
- **Input:** `vaultId`, optional `limit` 1 to 100 (default 20).
- **Output:** `{ hubs: [{ note, incomingLinks, outgoingLinks }], truncated }`; examines at most the first 200 notes.
- **Scope:** `notes.read`; server-computed from listing/backlink/outlink calls.
- **Annotations:** `readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Never; report-only.
- **Common errors:** `VAULT_NOT_FOUND`, `VAULT_OFFLINE`, `PERMISSION_DENIED`, `PATH_NOT_ALLOWED`, `SYMLINK_ESCAPE_BLOCKED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`.

### `obsidian.list_tasks`

- **User intent:** List or filter Markdown tasks in authorized notes.
- **Input:** `vaultId`; status list, due/scheduled date bounds, folder, project tag, tags, priority strings, optional note ID, limit, and cursor.
- **Output:** Paginated `Task` items with stable task/note/vault IDs, path/line/text/status, optional block ID, fingerprint, dates, priority, and tags.
- **Scope:** `tasks.read` plus folder policy.
- **Annotations:** `readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Never.
- **Common errors:** `VAULT_NOT_FOUND`, `NOTE_NOT_FOUND`, `VAULT_OFFLINE`, `PERMISSION_DENIED`, `PATH_NOT_ALLOWED`, `SYMLINK_ESCAPE_BLOCKED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`.

## Write Tools

### `obsidian.create_note`

- **User intent:** Create a Markdown note at an explicitly authorized vault path.
- **Input:** `vaultId`, relative `path`, content (default empty), frontmatter (default empty), `createFolders` (default false), `idempotencyKey`, `dryRun` (default true), optional confirmation token. No expected revision because the path must not exist.
- **Output:** `MutationResult`; preview includes a low-risk create diff/plan, apply includes created note identity/revision.
- **Scope:** `notes.create` plus destination folder/path policy.
- **Annotations:** `readOnlyHint=false; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Current adapters do not require a token for create; preview first, especially when destination is uncertain. Destination collision is rejected rather than overwritten.
- **Common errors:** `VAULT_NOT_FOUND`, `VAULT_OFFLINE`, `PATH_NOT_ALLOWED`, `PATH_TRAVERSAL_BLOCKED`, `SYMLINK_ESCAPE_BLOCKED`, `PERMISSION_DENIED`, `VALIDATION_ERROR`, `IDEMPOTENCY_CONFLICT`, `INTERNAL_ERROR`.

### `obsidian.append_to_note`

- **User intent:** Append Markdown to the end of, or under a named heading in, a known authorized note.
- **Input:** `vaultId`, `noteId`, `expectedRevision`, content, optional heading, `idempotencyKey`, `dryRun`, optional confirmation token.
- **Output:** `MutationResult` with low-risk append diff/plan and resulting note identity.
- **Scope:** `notes.update` plus path policy.
- **Annotations:** `readOnlyHint=false; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Not required by current adapters; dry-run remains supported and recommended.
- **Common errors:** `VAULT_NOT_FOUND`, `NOTE_NOT_FOUND`, `VAULT_OFFLINE`, `REVISION_CONFLICT`, `PATH_NOT_ALLOWED`, `SYMLINK_ESCAPE_BLOCKED`, `PERMISSION_DENIED`, `VALIDATION_ERROR`, `IDEMPOTENCY_CONFLICT`, `INTERNAL_ERROR`.

### `obsidian.update_note`

- **User intent:** Apply an explicit range, section, patch, or confirmed document update to an authorized note.
- **Input:** `vaultId`, `noteId`, `expectedRevision`, operation discriminated as `replace_range`, `replace_section`, `apply_patch`, or `replace_document`, plus write-safety fields.
- **Output:** `MutationResult` with diff/plan, changed sections, original/proposed revisions, and resulting note identity.
- **Scope:** `notes.update` plus path policy.
- **Annotations:** `readOnlyHint=false; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** `replace_document` is high-risk and requires an exact-plan token on apply. Range/section/patch are medium-risk in current adapters and do not require a token, but still support preview.
- **Common errors:** `VAULT_NOT_FOUND`, `NOTE_NOT_FOUND`, `VAULT_OFFLINE`, `REVISION_CONFLICT`, `CONFIRMATION_REQUIRED`, `IDEMPOTENCY_CONFLICT`, `PATH_NOT_ALLOWED`, `SYMLINK_ESCAPE_BLOCKED`, `PERMISSION_DENIED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`.

### `obsidian.set_frontmatter`

- **User intent:** Set/remove named frontmatter fields while preserving unrelated note data.
- **Input:** `vaultId`, `noteId`, `expectedRevision`, `set` map, `remove` list, and write-safety fields.
- **Output:** `MutationResult` with low-risk frontmatter diff/plan and resulting note identity.
- **Scope:** `notes.update` plus path policy.
- **Annotations:** `readOnlyHint=false; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Not required by current adapters; dry-run remains supported and recommended.
- **Common errors:** `VAULT_NOT_FOUND`, `NOTE_NOT_FOUND`, `VAULT_OFFLINE`, `REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `PATH_NOT_ALLOWED`, `SYMLINK_ESCAPE_BLOCKED`, `PERMISSION_DENIED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`.

### `obsidian.move_note`

- **User intent:** Move an authorized note to an exact authorized destination after reviewing the path change.
- **Input:** `vaultId`, `noteId`, `expectedRevision`, relative `destinationPath`, and write-safety fields.
- **Output:** `MutationResult` with high-risk path diff/plan and moved note identity/revision.
- **Scope:** `notes.move`; both source and destination must satisfy folder/path policy.
- **Annotations:** `readOnlyHint=false; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Required on apply after dry-run. Companion mode uses Obsidian's file manager so Obsidian link-update behavior can apply.
- **Common errors:** `VAULT_NOT_FOUND`, `NOTE_NOT_FOUND`, `VAULT_OFFLINE`, `REVISION_CONFLICT`, `CONFIRMATION_REQUIRED`, `IDEMPOTENCY_CONFLICT`, `PATH_NOT_ALLOWED`, `PATH_TRAVERSAL_BLOCKED`, `SYMLINK_ESCAPE_BLOCKED`, `PERMISSION_DENIED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`.

### `obsidian.trash_note`

- **User intent:** Trash one exact authorized note after explicit user review and confirmation.
- **Input:** `vaultId`, `noteId`, `expectedRevision`, and write-safety fields.
- **Output:** `MutationResult` with high-risk relocation diff/plan; applied trash omits a live note identity.
- **Scope:** `notes.trash` plus path policy.
- **Annotations:** `readOnlyHint=false; destructiveHint=true; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Always required on apply after dry-run. The public tool never hard deletes; filesystem mode moves into an authorized `.workbench-trash` location.
- **Common errors:** `VAULT_NOT_FOUND`, `NOTE_NOT_FOUND`, `VAULT_OFFLINE`, `REVISION_CONFLICT`, `CONFIRMATION_REQUIRED`, `IDEMPOTENCY_CONFLICT`, `PATH_NOT_ALLOWED`, `SYMLINK_ESCAPE_BLOCKED`, `PERMISSION_DENIED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`.

### `obsidian.create_task`

- **User intent:** Append a Markdown task to a specific authorized note/revision.
- **Input:** `vaultId`, `noteId`, `expectedRevision`, non-empty text, optional heading/due date, and write-safety fields.
- **Output:** `MutationResult` with low-risk task append diff/plan and resulting source-note identity.
- **Scope:** `tasks.create` plus note path policy.
- **Annotations:** `readOnlyHint=false; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Not required by current adapters; dry-run remains supported and recommended.
- **Common errors:** `VAULT_NOT_FOUND`, `NOTE_NOT_FOUND`, `VAULT_OFFLINE`, `REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `PATH_NOT_ALLOWED`, `SYMLINK_ESCAPE_BLOCKED`, `PERMISSION_DENIED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`.

### `obsidian.update_task`

- **User intent:** Update a known Markdown task using its source note's current revision.
- **Input:** `vaultId`, `taskId`, `expectedRevision`; at least one of status, non-empty text, or nullable due date; and write-safety fields.
- **Output:** `MutationResult` with low-risk task diff/plan and resulting source-note identity.
- **Scope:** `tasks.update` plus source note path policy.
- **Annotations:** `readOnlyHint=false; destructiveHint=false; idempotentHint=true; openWorldHint=false`.
- **Confirmation:** Not required by current adapters; dry-run remains supported and recommended.
- **Common errors:** `VAULT_NOT_FOUND`, `NOTE_NOT_FOUND`, `VAULT_OFFLINE`, `REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `PATH_NOT_ALLOWED`, `SYMLINK_ESCAPE_BLOCKED`, `PERMISSION_DENIED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`.

## App-Only Tool

### `obsidian.ui.confirm_mutation`

- **User intent:** Issue a token only after the user selects Apply on an exact rendered mutation diff in the MCP App.
- **Input:** Full schema-valid `MutationPlan` containing mutation/vault/target IDs or path, operation, request/mutation hashes, diff, and expiry.
- **Output:** `{ confirmationToken: string }`.
- **Scope:** App-only visibility. The plan's `vaultId` selects an adapter capable of confirmation; the issued token is bound to local/remote user, vault, target path, and mutation hash.
- **Annotations:** `readOnlyHint=false; destructiveHint=false; idempotentHint=false; openWorldHint=false`.
- **Confirmation:** This is the confirmation issuance step itself and must follow an explicit user Apply action. Tokens are short-lived and single-use; issuing one does not mutate a note.
- **Common errors:** `VAULT_NOT_FOUND`, `VALIDATION_ERROR`, `UNSUPPORTED_OPERATION`, `CONFIRMATION_REQUIRED` for invalid/stale plan handling, and `INTERNAL_ERROR`.

## Explicitly Absent Tools

There is no arbitrary execute, command, JavaScript, shell, raw filesystem, plugin install/enable/disable, Obsidian config write, or hard-delete tool. Any future tool must be registered, schema-tested, annotated, added here, and reviewed against the threat model.
