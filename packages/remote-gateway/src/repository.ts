import type {
  AccountRecord,
  DeviceRecord,
  MetadataInventory,
  PairingCodeRecord,
  PairingCompletion,
  PairingCompletionResult,
  TokenMetadataRecord,
  VaultAuthorizationRecord,
} from "./models.js";

/**
 * Metadata-only persistence boundary. Implementations must make
 * completePairing atomic: consume the code and insert all supplied records, or
 * perform no writes.
 */
export interface GatewayRepository {
  saveAccount(account: AccountRecord): Promise<void>;
  getAccount(accountId: string): Promise<AccountRecord | undefined>;

  createPairingCode(record: PairingCodeRecord): Promise<void>;
  getPairingCode(pairingId: string): Promise<PairingCodeRecord | undefined>;
  completePairing(
    completion: PairingCompletion,
  ): Promise<PairingCompletionResult | undefined>;

  getDevice(deviceId: string): Promise<DeviceRecord | undefined>;
  getVaultAuthorization(
    deviceId: string,
    vaultId: string,
  ): Promise<VaultAuthorizationRecord | undefined>;
  listVaultAuthorizations(
    userId: string,
    vaultId: string,
  ): Promise<readonly VaultAuthorizationRecord[]>;

  saveTokenMetadata(record: TokenMetadataRecord): Promise<void>;
  getTokenMetadata(jti: string): Promise<TokenMetadataRecord | undefined>;
  revokeToken(jti: string, revokedAt: number): Promise<boolean>;
  revokeDevice(
    userId: string,
    deviceId: string,
    revokedAt: number,
  ): Promise<boolean>;

  metadataInventory(): Promise<MetadataInventory>;
}
