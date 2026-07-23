import { z } from "zod";

import { PermissionScopeSchema } from "../schemas/vault.js";

export const ProtocolRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
  userId: z.string().min(1),
  deviceId: z.string().min(1),
  vaultId: z.string().min(1),
  scopes: z.array(PermissionScopeSchema),
  issuedAt: z.iso.datetime({ offset: true }),
  nonce: z.string().min(16),
});
export type ProtocolRequest = z.infer<typeof ProtocolRequestSchema>;

export const ProtocolResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string().min(1),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      data: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});
export type ProtocolResponse = z.infer<typeof ProtocolResponseSchema>;

export const GatewayReadySchema = z
  .object({
    type: z.literal("ready"),
    protocolVersion: z.literal(1),
    deviceId: z.string().min(1).max(256),
    vaultId: z.string().min(1).max(256),
  })
  .strict();
export type GatewayReady = z.infer<typeof GatewayReadySchema>;

export const VaultEventSchema = z.object({
  type: z.enum([
    "vault.connected",
    "vault.disconnected",
    "note.created",
    "note.modified",
    "note.renamed",
    "note.deleted",
    "metadata.changed",
    "active_note.changed",
  ]),
  vaultId: z.string().min(1),
  noteId: z.string().optional(),
  path: z.string().optional(),
  occurredAt: z.iso.datetime({ offset: true }),
});
export type VaultEvent = z.infer<typeof VaultEventSchema>;
