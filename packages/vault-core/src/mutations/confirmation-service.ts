import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  MutationPlanSchema,
  WorkbenchError,
  type MutationPlan,
} from "@obsidian-workbench/shared";

export interface ConfirmationBinding {
  userId: string;
  vaultId: string;
  targetPath: string;
  mutationHash: string;
}

export interface ConfirmationServiceOptions {
  secret?: string | Uint8Array;
  now?: () => number;
  defaultLifetimeMs?: number;
}

interface ConfirmationPayload extends ConfirmationBinding {
  v: 1;
  tokenId: string;
  expiresAt: number;
}

function confirmationError(): WorkbenchError {
  return new WorkbenchError({
    code: "CONFIRMATION_REQUIRED",
    message: "A valid confirmation is required for this mutation.",
    recoverable: true,
  });
}

export class ConfirmationService {
  readonly #key: Buffer;
  readonly #now: () => number;
  readonly #defaultLifetimeMs: number;
  readonly #consumed = new Map<string, number>();

  constructor(options: ConfirmationServiceOptions = {}) {
    const lifetime = options.defaultLifetimeMs ?? 5 * 60 * 1000;
    if (!Number.isSafeInteger(lifetime) || lifetime < 1) {
      throw new WorkbenchError({
        code: "VALIDATION_ERROR",
        message: "The confirmation lifetime is invalid.",
        recoverable: true,
      });
    }
    this.#key = options.secret
      ? createHash("sha256").update(options.secret).digest()
      : randomBytes(32);
    this.#now = options.now ?? Date.now;
    this.#defaultLifetimeMs = lifetime;
  }

  issueFromPlan(
    input: MutationPlan,
    userId: string,
    expiresInMs = this.#defaultLifetimeMs,
  ): string {
    let plan: MutationPlan;
    try {
      plan = MutationPlanSchema.parse(input);
    } catch {
      throw confirmationError();
    }
    const now = this.#now();
    if (
      userId.length === 0 ||
      !Number.isSafeInteger(expiresInMs) ||
      expiresInMs < 1
    ) {
      throw confirmationError();
    }
    const expiresAt = Math.min(Date.parse(plan.expiresAt), now + expiresInMs);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      throw confirmationError();
    }
    const payload: ConfirmationPayload = {
      v: 1,
      tokenId: randomBytes(18).toString("base64url"),
      userId,
      vaultId: plan.vaultId,
      targetPath: plan.targetPath,
      mutationHash: plan.mutationHash,
      expiresAt,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url",
    );
    return `${encoded}.${this.#sign(encoded)}`;
  }

  consume(token: string, binding: ConfirmationBinding): void {
    try {
      if (token.length > 8192) throw confirmationError();
      const separator = token.indexOf(".");
      if (separator <= 0 || separator !== token.lastIndexOf(".")) {
        throw confirmationError();
      }
      const encoded = token.slice(0, separator);
      const supplied = Buffer.from(token.slice(separator + 1), "base64url");
      const expected = Buffer.from(this.#sign(encoded), "base64url");
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        throw confirmationError();
      }
      const parsed: unknown = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      );
      if (!this.#isPayload(parsed)) throw confirmationError();
      const now = this.#now();
      this.#pruneConsumed(now);
      if (
        parsed.expiresAt <= now ||
        parsed.userId !== binding.userId ||
        parsed.vaultId !== binding.vaultId ||
        parsed.targetPath !== binding.targetPath ||
        parsed.mutationHash !== binding.mutationHash ||
        this.#consumed.has(parsed.tokenId)
      ) {
        throw confirmationError();
      }
      this.#consumed.set(parsed.tokenId, parsed.expiresAt);
    } catch (error) {
      if (error instanceof WorkbenchError) throw error;
      throw confirmationError();
    }
  }

  #sign(encoded: string): string {
    return createHmac("sha256", this.#key)
      .update(encoded, "utf8")
      .digest("base64url");
  }

  #pruneConsumed(now: number): void {
    for (const [tokenId, expiresAt] of this.#consumed) {
      if (expiresAt <= now) this.#consumed.delete(tokenId);
    }
  }

  #isPayload(value: unknown): value is ConfirmationPayload {
    if (value === null || typeof value !== "object") return false;
    const payload = value as Partial<ConfirmationPayload>;
    return (
      payload.v === 1 &&
      typeof payload.tokenId === "string" &&
      payload.tokenId.length >= 16 &&
      typeof payload.userId === "string" &&
      payload.userId.length > 0 &&
      typeof payload.vaultId === "string" &&
      payload.vaultId.length > 0 &&
      typeof payload.targetPath === "string" &&
      typeof payload.mutationHash === "string" &&
      typeof payload.expiresAt === "number" &&
      Number.isSafeInteger(payload.expiresAt)
    );
  }
}
