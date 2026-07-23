import type { PermissionScope } from "@obsidian-workbench/shared";

export interface UserSession {
  sessionId: string;
  userId: string;
  authenticatedAt: number;
  expiresAt: number;
}

export interface AccountRecord {
  id: string;
  createdAt: number;
  disabledAt?: number;
}

export interface DeviceRecord {
  id: string;
  userId: string;
  createdAt: number;
  revokedAt?: number;
}

export interface VaultAuthorizationRecord {
  deviceId: string;
  userId: string;
  vaultId: string;
  vaultName: string;
  scopes: readonly PermissionScope[];
  createdAt: number;
  revokedAt?: number;
}

export type GatewayTokenType = "device_identity" | "vault_authorization";

export interface GatewayTokenClaims {
  iss: string;
  aud: string;
  type: GatewayTokenType;
  id: string;
  user: string;
  vault: string;
  scopes: readonly PermissionScope[];
  iat: number;
  exp: number;
  jti: string;
}

export interface TokenMetadataRecord {
  jti: string;
  type: GatewayTokenType;
  id: string;
  userId: string;
  vaultId: string;
  scopes: readonly PermissionScope[];
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number;
}

export interface PairingCodeRecord {
  id: string;
  codeDigest: string;
  userId: string;
  vaultId: string;
  scopes: readonly PermissionScope[];
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
}

export interface PairingCompletion {
  pairingId: string;
  codeDigest: string;
  now: number;
  device: DeviceRecord;
  authorization: VaultAuthorizationRecord;
  deviceToken: TokenMetadataRecord;
  vaultToken: TokenMetadataRecord;
}

export interface PairingCompletionResult {
  device: DeviceRecord;
  authorization: VaultAuthorizationRecord;
  deviceToken: TokenMetadataRecord;
  vaultToken: TokenMetadataRecord;
}

export interface MetadataInventory {
  accounts: readonly AccountRecord[];
  devices: readonly DeviceRecord[];
  vaultAuthorizations: readonly VaultAuthorizationRecord[];
  pairingCodes: readonly PairingCodeRecord[];
  tokens: readonly TokenMetadataRecord[];
}
