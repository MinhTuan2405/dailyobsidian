import {
  PermissionScopeSchema,
  type PermissionScope,
} from "@obsidian-workbench/shared";

import type { AuditEntry } from "./audit.js";
import { randomId } from "./hash.js";

export const ALL_SCOPES = PermissionScopeSchema.options;

export interface PairedDevice {
  deviceId: string;
  userId: string;
  vaultId: string;
  deviceToken: string;
  deviceTokenExpiresAt: number;
  vaultToken: string;
  vaultTokenExpiresAt: number;
  scopes: PermissionScope[];
  pairedAt: string;
}

export interface PluginSettingsData {
  gatewayUrl: string;
  autoConnect: boolean;
  vaultId: string;
  allowedRoots: string[];
  excludedRoots: string[];
  enabledScopes: PermissionScope[];
  device?: PairedDevice;
  noteIds: Record<string, string>;
  auditEntries: AuditEntry[];
  auditRetention: number;
}

export function defaultSettings(): PluginSettingsData {
  return {
    gatewayUrl: "",
    autoConnect: true,
    vaultId: randomId("vault"),
    allowedRoots: ["."],
    excludedRoots: [],
    enabledScopes: [
      "vault.metadata.read",
      "notes.read",
      "tasks.read",
      "attachments.read",
    ],
    noteIds: {},
    auditEntries: [],
    auditRetention: 200,
  };
}

function strings(value: unknown, fallback: string[], max = 200): string[] {
  if (!Array.isArray(value)) return fallback;
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length <= 4096)
    .slice(0, max);
}

function pairedDevice(value: unknown): PairedDevice | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const input = value as Partial<PairedDevice>;
  if (
    typeof input.deviceId !== "string" ||
    typeof input.userId !== "string" ||
    typeof input.vaultId !== "string" ||
    typeof input.deviceToken !== "string" ||
    input.deviceToken.length < 16 ||
    input.deviceToken.length > 8192 ||
    typeof input.deviceTokenExpiresAt !== "number" ||
    !Number.isFinite(input.deviceTokenExpiresAt) ||
    typeof input.vaultToken !== "string" ||
    input.vaultToken.length < 16 ||
    input.vaultToken.length > 8192 ||
    typeof input.vaultTokenExpiresAt !== "number" ||
    !Number.isFinite(input.vaultTokenExpiresAt)
  ) {
    return undefined;
  }
  const scopes = PermissionScopeSchema.array().safeParse(input.scopes);
  if (!scopes.success) return undefined;
  return {
    deviceId: input.deviceId.slice(0, 256),
    userId: input.userId.slice(0, 256),
    vaultId: input.vaultId.slice(0, 256),
    deviceToken: input.deviceToken,
    deviceTokenExpiresAt: input.deviceTokenExpiresAt,
    vaultToken: input.vaultToken,
    vaultTokenExpiresAt: input.vaultTokenExpiresAt,
    scopes: [...new Set(scopes.data)],
    pairedAt:
      typeof input.pairedAt === "string" &&
      Number.isFinite(Date.parse(input.pairedAt))
        ? new Date(input.pairedAt).toISOString()
        : new Date(0).toISOString(),
  };
}

export function loadSettings(value: unknown): PluginSettingsData {
  const defaults = defaultSettings();
  if (value === null || typeof value !== "object") return defaults;
  const input = value as Partial<PluginSettingsData>;
  const scopes = PermissionScopeSchema.array().safeParse(input.enabledScopes);
  const noteIds: Record<string, string> = {};
  if (input.noteIds !== null && typeof input.noteIds === "object") {
    for (const [path, noteId] of Object.entries(input.noteIds).slice(
      0,
      100_000,
    )) {
      if (
        path.length <= 4096 &&
        typeof noteId === "string" &&
        noteId.length <= 256
      ) {
        noteIds[path] = noteId;
      }
    }
  }
  const device = pairedDevice(input.device);
  return {
    gatewayUrl:
      typeof input.gatewayUrl === "string"
        ? input.gatewayUrl.trim().slice(0, 2048)
        : "",
    autoConnect: input.autoConnect ?? defaults.autoConnect,
    vaultId:
      typeof input.vaultId === "string" && input.vaultId.length > 0
        ? input.vaultId.slice(0, 256)
        : defaults.vaultId,
    allowedRoots: strings(input.allowedRoots, defaults.allowedRoots),
    excludedRoots: strings(input.excludedRoots, defaults.excludedRoots),
    enabledScopes: scopes.success
      ? [...new Set(scopes.data)]
      : defaults.enabledScopes,
    ...(device === undefined ? {} : { device }),
    noteIds,
    auditEntries: Array.isArray(input.auditEntries)
      ? input.auditEntries.slice(0, 1000)
      : [],
    auditRetention:
      typeof input.auditRetention === "number" &&
      Number.isFinite(input.auditRetention)
        ? Math.max(10, Math.min(1000, Math.floor(input.auditRetention)))
        : defaults.auditRetention,
  };
}
