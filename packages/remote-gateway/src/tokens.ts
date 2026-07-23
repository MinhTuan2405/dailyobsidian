import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { PermissionScopeSchema } from "@obsidian-workbench/shared";
import { z } from "zod";

import { GatewayError } from "./errors.js";
import type {
  GatewayTokenClaims,
  GatewayTokenType,
  TokenMetadataRecord,
} from "./models.js";
import type { GatewayRepository } from "./repository.js";

const TokenHeaderSchema = z
  .object({ alg: z.literal("HS256"), typ: z.literal("JWT") })
  .strict();

const TokenClaimsSchema = z
  .object({
    iss: z.string().min(1).max(256),
    aud: z.string().min(1).max(256),
    type: z.enum(["device_identity", "vault_authorization"]),
    id: z.string().min(1).max(256),
    user: z.string().min(1).max(256),
    vault: z.string().min(1).max(256),
    scopes: z
      .array(PermissionScopeSchema)
      .max(PermissionScopeSchema.options.length)
      .refine((scopes) => new Set(scopes).size === scopes.length),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    jti: z.string().min(16).max(256),
  })
  .strict();

export interface TokenServiceOptions {
  repository: GatewayRepository;
  signingKey: string | Buffer;
  issuer: string;
  audience: string;
  now?: () => number;
  newJti?: () => string;
}

export interface PrepareTokenInput {
  type: GatewayTokenType;
  id: string;
  userId: string;
  vaultId: string;
  scopes: readonly z.infer<typeof PermissionScopeSchema>[];
  ttlMs: number;
}

export interface PreparedToken {
  token: string;
  claims: GatewayTokenClaims;
  metadata: TokenMetadataRecord;
}

export class TokenService {
  readonly #repository: GatewayRepository;
  readonly #key: Buffer;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #now: () => number;
  readonly #newJti: () => string;

  constructor(options: TokenServiceOptions) {
    const key = Buffer.isBuffer(options.signingKey)
      ? Buffer.from(options.signingKey)
      : Buffer.from(options.signingKey, "utf8");
    if (key.length < 32) {
      throw new TypeError(
        "The HMAC signing key must contain at least 32 bytes.",
      );
    }
    if (options.issuer.length === 0 || options.audience.length === 0) {
      throw new TypeError("Token issuer and audience are required.");
    }
    this.#repository = options.repository;
    this.#key = key;
    this.#issuer = options.issuer;
    this.#audience = options.audience;
    this.#now = options.now ?? Date.now;
    this.#newJti = options.newJti ?? randomUUID;
  }

  prepare(input: PrepareTokenInput): PreparedToken {
    if (input.ttlMs < 1_000) {
      throw new TypeError("Token lifetime must be at least one second.");
    }
    const now = this.#now();
    const scopes = PermissionScopeSchema.array().parse([...input.scopes]);
    if (new Set(scopes).size !== scopes.length) {
      throw new TypeError("Token scopes must be unique.");
    }
    const claims = TokenClaimsSchema.parse({
      iss: this.#issuer,
      aud: this.#audience,
      type: input.type,
      id: input.id,
      user: input.userId,
      vault: input.vaultId,
      scopes,
      iat: Math.floor(now / 1000),
      exp: Math.ceil((now + input.ttlMs) / 1000),
      jti: this.#newJti(),
    });
    const metadata: TokenMetadataRecord = {
      jti: claims.jti,
      type: claims.type,
      id: claims.id,
      userId: claims.user,
      vaultId: claims.vault,
      scopes: [...claims.scopes],
      issuedAt: now,
      expiresAt: now + input.ttlMs,
    };
    return {
      token: this.#serialize(claims),
      claims: { ...claims, scopes: [...claims.scopes] },
      metadata,
    };
  }

  async issue(input: PrepareTokenInput): Promise<PreparedToken> {
    const prepared = this.prepare(input);
    await this.#repository.saveTokenMetadata(prepared.metadata);
    return prepared;
  }

  async verify(
    token: string,
    expectedType: GatewayTokenType,
  ): Promise<GatewayTokenClaims> {
    const claims = this.#verifySignatureAndClaims(token);
    if (claims.type !== expectedType) {
      throw invalidToken();
    }
    const now = this.#now();
    if (claims.exp * 1000 <= now || claims.iat * 1000 > now + 30_000) {
      throw invalidToken();
    }
    const metadata = await this.#repository.getTokenMetadata(claims.jti);
    if (
      metadata === undefined ||
      metadata.revokedAt !== undefined ||
      metadata.expiresAt <= now ||
      metadata.type !== claims.type ||
      metadata.id !== claims.id ||
      metadata.userId !== claims.user ||
      metadata.vaultId !== claims.vault ||
      !sameScopes(metadata.scopes, claims.scopes)
    ) {
      throw invalidToken();
    }
    return { ...claims, scopes: [...claims.scopes] };
  }

  async revoke(jti: string): Promise<boolean> {
    return await this.#repository.revokeToken(jti, this.#now());
  }

  #serialize(claims: GatewayTokenClaims): string {
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
      "utf8",
    ).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
      "base64url",
    );
    const input = `${header}.${payload}`;
    const signature = createHmac("sha256", this.#key)
      .update(input, "ascii")
      .digest("base64url");
    return `${input}.${signature}`;
  }

  #verifySignatureAndClaims(token: string): GatewayTokenClaims {
    if (token.length < 16 || token.length > 8192) throw invalidToken();
    const parts = token.split(".");
    if (parts.length !== 3) throw invalidToken();
    const [headerPart, payloadPart, signaturePart] = parts;
    if (
      headerPart === undefined ||
      payloadPart === undefined ||
      signaturePart === undefined
    ) {
      throw invalidToken();
    }
    const input = `${headerPart}.${payloadPart}`;
    const expected = createHmac("sha256", this.#key)
      .update(input, "ascii")
      .digest();
    const supplied = decodeCanonicalBase64Url(signaturePart);
    if (
      supplied === undefined ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw invalidToken();
    }
    const header = parseEncodedJson(headerPart);
    const payload = parseEncodedJson(payloadPart);
    if (!TokenHeaderSchema.safeParse(header).success) throw invalidToken();
    const parsed = TokenClaimsSchema.safeParse(payload);
    if (
      !parsed.success ||
      parsed.data.iss !== this.#issuer ||
      parsed.data.aud !== this.#audience
    ) {
      throw invalidToken();
    }
    return parsed.data;
  }
}

function parseEncodedJson(value: string): unknown {
  const decoded = decodeCanonicalBase64Url(value);
  if (decoded === undefined || decoded.length > 16 * 1024) return undefined;
  try {
    return JSON.parse(decoded.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function decodeCanonicalBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function sameScopes(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length && left.every((scope) => right.includes(scope))
  );
}

function invalidToken(): GatewayError {
  return new GatewayError(
    "AUTHENTICATION_REQUIRED",
    "The supplied credential is invalid or expired.",
    401,
  );
}
