import { z } from "zod";

import { EntityIdSchema, IsoDateTimeSchema } from "./common.js";

export const PermissionScopeSchema = z.enum([
  "vault.metadata.read",
  "notes.read",
  "notes.create",
  "notes.update",
  "notes.move",
  "notes.trash",
  "tasks.read",
  "tasks.create",
  "tasks.update",
  "attachments.read",
]);
export type PermissionScope = z.infer<typeof PermissionScopeSchema>;

export const VaultCapabilitiesSchema = z.object({
  scopes: z.array(PermissionScopeSchema),
  supportsTrash: z.boolean(),
  supportsFileManagerMoves: z.boolean(),
  supportsEvents: z.boolean(),
  supportsOpenInObsidian: z.boolean(),
});
export type VaultCapabilities = z.infer<typeof VaultCapabilitiesSchema>;

export const ConnectionStatusSchema = z.object({
  state: z.enum(["online", "offline", "connecting", "error"]),
  mode: z.enum(["filesystem", "companion", "remote"]),
  lastConnectedAt: IsoDateTimeSchema.optional(),
  lastError: z.string().max(1000).optional(),
});
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const VaultConventionsSchema = z.object({
  inboxFolder: z.string().default("Inbox"),
  dailyNotesFolder: z.string().default("Daily"),
  dailyNoteFormat: z.string().default("YYYY-MM-DD"),
  dateFormat: z.string().default("YYYY-MM-DD"),
  templatePaths: z.array(z.string()).default([]),
  taskSyntax: z.string().default("- [ ]"),
  preferredLinkStyle: z.enum(["wikilink", "markdown"]).default("wikilink"),
  defaultFrontmatter: z.record(z.string(), z.unknown()).default({}),
});
export type VaultConventions = z.infer<typeof VaultConventionsSchema>;

export const VaultInfoSchema = z.object({
  vaultId: EntityIdSchema,
  name: z.string().trim().min(1).max(256),
  status: ConnectionStatusSchema,
  capabilities: VaultCapabilitiesSchema,
  allowedRoots: z.array(z.string()),
  excludedRoots: z.array(z.string()),
  conventions: VaultConventionsSchema,
});
export type VaultInfo = z.infer<typeof VaultInfoSchema>;
