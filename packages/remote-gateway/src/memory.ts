import { timingSafeEqual } from "node:crypto";

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
import type { GatewayRepository } from "./repository.js";

function copyAccount(record: AccountRecord): AccountRecord {
  return { ...record };
}

function copyDevice(record: DeviceRecord): DeviceRecord {
  return { ...record };
}

function copyAuthorization(
  record: VaultAuthorizationRecord,
): VaultAuthorizationRecord {
  return { ...record, scopes: [...record.scopes] };
}

function copyPairing(record: PairingCodeRecord): PairingCodeRecord {
  return { ...record, scopes: [...record.scopes] };
}

function copyToken(record: TokenMetadataRecord): TokenMetadataRecord {
  return { ...record, scopes: [...record.scopes] };
}

function authorizationKey(deviceId: string, vaultId: string): string {
  return `${deviceId}\0${vaultId}`;
}

function equalDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "base64url");
  const rightBytes = Buffer.from(right, "base64url");
  return (
    leftBytes.length === rightBytes.length &&
    leftBytes.length > 0 &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function sameScopes(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length && left.every((scope) => right.includes(scope))
  );
}

/**
 * Metadata-only, defensive-copying repository for tests. It never stores raw
 * pairing codes, session secrets, signed tokens, request payloads, or results.
 */
export class InMemoryGatewayRepository implements GatewayRepository {
  readonly #accounts = new Map<string, AccountRecord>();
  readonly #devices = new Map<string, DeviceRecord>();
  readonly #authorizations = new Map<string, VaultAuthorizationRecord>();
  readonly #pairings = new Map<string, PairingCodeRecord>();
  readonly #tokens = new Map<string, TokenMetadataRecord>();

  async saveAccount(account: AccountRecord): Promise<void> {
    this.#accounts.set(account.id, copyAccount(account));
  }

  async getAccount(accountId: string): Promise<AccountRecord | undefined> {
    const record = this.#accounts.get(accountId);
    return record === undefined ? undefined : copyAccount(record);
  }

  async createPairingCode(record: PairingCodeRecord): Promise<void> {
    if (this.#pairings.has(record.id)) {
      throw new Error("Pairing identifier collision.");
    }
    this.#pairings.set(record.id, copyPairing(record));
  }

  async getPairingCode(
    pairingId: string,
  ): Promise<PairingCodeRecord | undefined> {
    const record = this.#pairings.get(pairingId);
    return record === undefined ? undefined : copyPairing(record);
  }

  async completePairing(
    completion: PairingCompletion,
  ): Promise<PairingCompletionResult | undefined> {
    // There are no awaits in this operation, so validation and all writes are
    // one atomic turn for this in-memory implementation.
    const pairing = this.#pairings.get(completion.pairingId);
    const account =
      pairing === undefined ? undefined : this.#accounts.get(pairing.userId);
    const grantedScopes = completion.authorization.scopes;
    if (
      pairing === undefined ||
      account === undefined ||
      account.disabledAt !== undefined ||
      pairing.usedAt !== undefined ||
      pairing.expiresAt <= completion.now ||
      !equalDigest(pairing.codeDigest, completion.codeDigest) ||
      completion.device.userId !== pairing.userId ||
      completion.authorization.userId !== pairing.userId ||
      completion.authorization.deviceId !== completion.device.id ||
      completion.authorization.vaultId !== pairing.vaultId ||
      completion.deviceToken.type !== "device_identity" ||
      completion.deviceToken.id !== completion.device.id ||
      completion.deviceToken.userId !== pairing.userId ||
      completion.deviceToken.vaultId !== pairing.vaultId ||
      completion.deviceToken.scopes.length !== 0 ||
      completion.vaultToken.type !== "vault_authorization" ||
      completion.vaultToken.id !== completion.device.id ||
      completion.vaultToken.userId !== pairing.userId ||
      completion.vaultToken.vaultId !== pairing.vaultId ||
      !sameScopes(completion.vaultToken.scopes, grantedScopes) ||
      grantedScopes.length === 0 ||
      grantedScopes.some((scope) => !pairing.scopes.includes(scope)) ||
      this.#devices.has(completion.device.id) ||
      completion.deviceToken.jti === completion.vaultToken.jti ||
      this.#tokens.has(completion.deviceToken.jti) ||
      this.#tokens.has(completion.vaultToken.jti)
    ) {
      return undefined;
    }

    const usedPairing: PairingCodeRecord = {
      ...pairing,
      scopes: [...pairing.scopes],
      usedAt: completion.now,
    };
    const device = copyDevice(completion.device);
    const authorization = copyAuthorization(completion.authorization);
    const deviceToken = copyToken(completion.deviceToken);
    const vaultToken = copyToken(completion.vaultToken);
    this.#pairings.set(pairing.id, usedPairing);
    this.#devices.set(device.id, device);
    this.#authorizations.set(
      authorizationKey(authorization.deviceId, authorization.vaultId),
      authorization,
    );
    this.#tokens.set(deviceToken.jti, deviceToken);
    this.#tokens.set(vaultToken.jti, vaultToken);
    return {
      device: copyDevice(device),
      authorization: copyAuthorization(authorization),
      deviceToken: copyToken(deviceToken),
      vaultToken: copyToken(vaultToken),
    };
  }

  async getDevice(deviceId: string): Promise<DeviceRecord | undefined> {
    const record = this.#devices.get(deviceId);
    return record === undefined ? undefined : copyDevice(record);
  }

  async getVaultAuthorization(
    deviceId: string,
    vaultId: string,
  ): Promise<VaultAuthorizationRecord | undefined> {
    const record = this.#authorizations.get(
      authorizationKey(deviceId, vaultId),
    );
    return record === undefined ? undefined : copyAuthorization(record);
  }

  async listVaultAuthorizations(
    userId: string,
    vaultId: string,
  ): Promise<readonly VaultAuthorizationRecord[]> {
    const records: VaultAuthorizationRecord[] = [];
    for (const record of this.#authorizations.values()) {
      if (record.userId === userId && record.vaultId === vaultId) {
        records.push(copyAuthorization(record));
      }
    }
    return records;
  }

  async saveTokenMetadata(record: TokenMetadataRecord): Promise<void> {
    if (this.#tokens.has(record.jti)) {
      throw new Error("Token identifier collision.");
    }
    this.#tokens.set(record.jti, copyToken(record));
  }

  async getTokenMetadata(
    jti: string,
  ): Promise<TokenMetadataRecord | undefined> {
    const record = this.#tokens.get(jti);
    return record === undefined ? undefined : copyToken(record);
  }

  async revokeToken(jti: string, revokedAt: number): Promise<boolean> {
    const record = this.#tokens.get(jti);
    if (record === undefined || record.revokedAt !== undefined) return false;
    this.#tokens.set(jti, { ...record, revokedAt });
    return true;
  }

  async revokeDevice(
    userId: string,
    deviceId: string,
    revokedAt: number,
  ): Promise<boolean> {
    const device = this.#devices.get(deviceId);
    if (
      device === undefined ||
      device.userId !== userId ||
      device.revokedAt !== undefined
    ) {
      return false;
    }
    this.#devices.set(deviceId, { ...device, revokedAt });
    for (const [key, authorization] of this.#authorizations) {
      if (
        authorization.deviceId === deviceId &&
        authorization.userId === userId &&
        authorization.revokedAt === undefined
      ) {
        this.#authorizations.set(key, { ...authorization, revokedAt });
      }
    }
    for (const [jti, token] of this.#tokens) {
      if (
        token.id === deviceId &&
        token.userId === userId &&
        token.revokedAt === undefined
      ) {
        this.#tokens.set(jti, { ...token, revokedAt });
      }
    }
    return true;
  }

  async metadataInventory(): Promise<MetadataInventory> {
    return {
      accounts: [...this.#accounts.values()].map(copyAccount),
      devices: [...this.#devices.values()].map(copyDevice),
      vaultAuthorizations: [...this.#authorizations.values()].map(
        copyAuthorization,
      ),
      pairingCodes: [...this.#pairings.values()].map(copyPairing),
      tokens: [...this.#tokens.values()].map(copyToken),
    };
  }
}
