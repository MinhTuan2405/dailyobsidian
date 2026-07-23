import { createHmac, randomBytes, randomUUID } from "node:crypto";

import {
  PermissionScopeSchema,
  type PermissionScope,
} from "@obsidian-workbench/shared";
import { z } from "zod";

import { GatewayError } from "./errors.js";
import type { UserSession } from "./models.js";
import type { GatewayRepository } from "./repository.js";
import type { TokenService } from "./tokens.js";

const CreatePairingSchema = z
  .object({
    vaultId: z.string().min(1).max(256),
    scopes: z.array(PermissionScopeSchema).min(1),
    ttlMs: z
      .number()
      .int()
      .min(30_000)
      .max(10 * 60 * 1000)
      .optional(),
  })
  .strict();

const ExchangePairingSchema = z
  .object({
    code: z.string().trim().min(6).max(64),
    vaultId: z.string().min(1).max(256),
    vaultName: z.string().trim().min(1).max(256),
    scopes: z.array(PermissionScopeSchema).min(1),
  })
  .strict();

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_PATTERN =
  /^([A-Z2-9]{8})-([A-Z2-9]{4})-([A-Z2-9]{4})-([A-Z2-9]{4})$/;

export type CreatePairingInput = z.input<typeof CreatePairingSchema>;
export type ExchangePairingInput = z.input<typeof ExchangePairingSchema>;

export interface CreatedPairingCode {
  code: string;
  vaultId: string;
  scopes: PermissionScope[];
  expiresAt: number;
}

export interface PairingExchangeResult {
  deviceId: string;
  userId: string;
  vaultId: string;
  deviceToken: string;
  deviceTokenExpiresAt: number;
  vaultToken: string;
  vaultTokenExpiresAt: number;
  scopes: PermissionScope[];
}

export interface PairingServiceOptions {
  repository: GatewayRepository;
  tokens: TokenService;
  codeHmacKey: string | Buffer;
  now?: () => number;
  deviceTokenTtlMs?: number;
  vaultTokenTtlMs?: number;
  randomCodeBytes?: (size: number) => Buffer;
  newDeviceId?: () => string;
}

export class PairingService {
  readonly #repository: GatewayRepository;
  readonly #tokens: TokenService;
  readonly #codeKey: Buffer;
  readonly #now: () => number;
  readonly #deviceTokenTtlMs: number;
  readonly #vaultTokenTtlMs: number;
  readonly #randomCodeBytes: (size: number) => Buffer;
  readonly #newDeviceId: () => string;

  constructor(options: PairingServiceOptions) {
    const key = Buffer.isBuffer(options.codeHmacKey)
      ? Buffer.from(options.codeHmacKey)
      : Buffer.from(options.codeHmacKey, "utf8");
    if (key.length < 32) {
      throw new TypeError(
        "The pairing HMAC key must contain at least 32 bytes.",
      );
    }
    this.#repository = options.repository;
    this.#tokens = options.tokens;
    this.#codeKey = key;
    this.#now = options.now ?? Date.now;
    this.#deviceTokenTtlMs =
      options.deviceTokenTtlMs ?? 90 * 24 * 60 * 60 * 1000;
    this.#vaultTokenTtlMs = options.vaultTokenTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    if (this.#deviceTokenTtlMs < 60_000 || this.#vaultTokenTtlMs < 60_000) {
      throw new TypeError("Token lifetimes must be at least one minute.");
    }
    this.#randomCodeBytes = options.randomCodeBytes ?? randomBytes;
    this.#newDeviceId = options.newDeviceId ?? randomUUID;
  }

  async createCode(
    session: UserSession,
    value: unknown,
  ): Promise<CreatedPairingCode> {
    const now = this.#now();
    if (session.expiresAt <= now) {
      throw new GatewayError(
        "AUTHENTICATION_REQUIRED",
        "An authenticated account session is required.",
        401,
      );
    }
    const account = await this.#repository.getAccount(session.userId);
    if (account === undefined || account.disabledAt !== undefined) {
      throw new GatewayError(
        "AUTHENTICATION_REQUIRED",
        "An authenticated account session is required.",
        401,
      );
    }
    const parsed = CreatePairingSchema.safeParse(value);
    if (!parsed.success) throw invalidPairingRequest();
    const input = parsed.data;
    const scopes = uniqueScopes(input.scopes);
    if (scopes.length !== input.scopes.length) {
      throw invalidPairingRequest();
    }
    const ttlMs = input.ttlMs ?? 5 * 60 * 1000;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const raw = randomCharacters(this.#randomCodeBytes(20), 20);
      const code = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}`;
      const id = raw.slice(0, 8);
      try {
        await this.#repository.createPairingCode({
          id,
          codeDigest: this.#digestCode(code),
          userId: session.userId,
          vaultId: input.vaultId,
          scopes,
          createdAt: now,
          expiresAt: now + ttlMs,
        });
        return {
          code,
          vaultId: input.vaultId,
          scopes: [...scopes],
          expiresAt: now + ttlMs,
        };
      } catch {
        // A generated identifier collision is retried without exposing storage.
      }
    }
    throw new GatewayError(
      "INTERNAL_ERROR",
      "The gateway could not create a pairing code.",
      500,
    );
  }

  async exchangeCode(value: unknown): Promise<PairingExchangeResult> {
    const parsed = ExchangePairingSchema.safeParse(value);
    if (!parsed.success) throw invalidPairing();
    const input = parsed.data;
    const normalizedCode = input.code.toUpperCase();
    const codeMatch = CODE_PATTERN.exec(normalizedCode);
    const pairingId = codeMatch?.[1];
    if (pairingId === undefined) throw invalidPairing();
    const pairing = await this.#repository.getPairingCode(pairingId);
    const now = this.#now();
    const scopes = uniqueScopes(input.scopes);
    if (
      pairing === undefined ||
      pairing.usedAt !== undefined ||
      pairing.expiresAt <= now ||
      pairing.vaultId !== input.vaultId ||
      scopes.length !== input.scopes.length ||
      scopes.some((scope) => !pairing.scopes.includes(scope))
    ) {
      throw invalidPairing();
    }

    const deviceId = this.#newDeviceId();
    const deviceToken = this.#tokens.prepare({
      type: "device_identity",
      id: deviceId,
      userId: pairing.userId,
      vaultId: pairing.vaultId,
      scopes: [],
      ttlMs: this.#deviceTokenTtlMs,
    });
    const vaultToken = this.#tokens.prepare({
      type: "vault_authorization",
      id: deviceId,
      userId: pairing.userId,
      vaultId: pairing.vaultId,
      scopes,
      ttlMs: this.#vaultTokenTtlMs,
    });
    const completion = await this.#repository.completePairing({
      pairingId,
      codeDigest: this.#digestCode(normalizedCode),
      now,
      device: { id: deviceId, userId: pairing.userId, createdAt: now },
      authorization: {
        deviceId,
        userId: pairing.userId,
        vaultId: pairing.vaultId,
        vaultName: input.vaultName,
        scopes,
        createdAt: now,
      },
      deviceToken: deviceToken.metadata,
      vaultToken: vaultToken.metadata,
    });
    if (completion === undefined) throw invalidPairing();
    return {
      deviceId,
      userId: pairing.userId,
      vaultId: pairing.vaultId,
      deviceToken: deviceToken.token,
      deviceTokenExpiresAt: deviceToken.metadata.expiresAt,
      vaultToken: vaultToken.token,
      vaultTokenExpiresAt: vaultToken.metadata.expiresAt,
      scopes: [...scopes],
    };
  }

  async revokeDevice(deviceToken: string, deviceId: string): Promise<void> {
    const claims = await this.#tokens.verify(deviceToken, "device_identity");
    if (claims.id !== deviceId) {
      throw new GatewayError(
        "PERMISSION_DENIED",
        "The device could not be revoked with this credential.",
        403,
      );
    }
    const revoked = await this.#repository.revokeDevice(
      claims.user,
      deviceId,
      this.#now(),
    );
    if (!revoked) {
      throw new GatewayError(
        "PERMISSION_DENIED",
        "The device could not be revoked with this credential.",
        403,
      );
    }
  }

  #digestCode(code: string): string {
    return createHmac("sha256", this.#codeKey)
      .update(code, "ascii")
      .digest("base64url");
  }
}

function randomCharacters(bytes: Buffer, count: number): string {
  if (bytes.length < count) {
    throw new TypeError("The random byte source returned too few bytes.");
  }
  let result = "";
  for (let index = 0; index < count; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) throw new TypeError("Random byte unavailable.");
    result += CODE_ALPHABET[byte & 31];
  }
  return result;
}

function uniqueScopes(scopes: readonly PermissionScope[]): PermissionScope[] {
  return [...new Set(scopes)];
}

function invalidPairing(): GatewayError {
  return new GatewayError(
    "PAIRING_INVALID",
    "The pairing code is invalid, expired, or already used.",
    403,
  );
}

function invalidPairingRequest(): GatewayError {
  return new GatewayError(
    "INVALID_REQUEST",
    "The pairing request is invalid.",
    400,
  );
}
