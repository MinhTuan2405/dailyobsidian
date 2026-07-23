import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  PaginationCursorSchema,
  WorkbenchError,
  type PaginationCursor,
} from "@obsidian-workbench/shared";

interface CursorPayload {
  v: 1;
  operation: string;
  fingerprint: string;
  offset: number;
}

function validationError(): WorkbenchError {
  return new WorkbenchError({
    code: "VALIDATION_ERROR",
    message: "The pagination cursor is invalid or does not match this request.",
    recoverable: true,
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry) => entry[1] !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function requestFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

export class CursorCodec {
  readonly #key: Buffer;

  constructor(secret?: string | Uint8Array) {
    this.#key = secret
      ? createHash("sha256").update(secret).digest()
      : randomBytes(32);
  }

  encode(
    operation: string,
    fingerprint: string,
    offset: number,
  ): PaginationCursor {
    const payload: CursorPayload = { v: 1, operation, fingerprint, offset };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url",
    );
    const signature = this.#sign(encoded);
    return PaginationCursorSchema.parse(`${encoded}.${signature}`);
  }

  decode(
    cursor: PaginationCursor | undefined,
    operation: string,
    fingerprint: string,
  ): number {
    if (cursor === undefined) {
      return 0;
    }

    try {
      const separator = cursor.indexOf(".");
      if (separator <= 0 || separator !== cursor.lastIndexOf(".")) {
        throw validationError();
      }
      const encoded = cursor.slice(0, separator);
      const suppliedSignature = Buffer.from(
        cursor.slice(separator + 1),
        "base64url",
      );
      const expectedSignature = Buffer.from(this.#sign(encoded), "base64url");
      if (
        suppliedSignature.length !== expectedSignature.length ||
        !timingSafeEqual(suppliedSignature, expectedSignature)
      ) {
        throw validationError();
      }

      const parsed: unknown = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      );
      if (!this.#isPayload(parsed)) {
        throw validationError();
      }
      if (
        parsed.operation !== operation ||
        parsed.fingerprint !== fingerprint
      ) {
        throw validationError();
      }
      return parsed.offset;
    } catch (error) {
      if (error instanceof WorkbenchError) {
        throw error;
      }
      throw validationError();
    }
  }

  #sign(encoded: string): string {
    return createHmac("sha256", this.#key)
      .update(encoded, "utf8")
      .digest("base64url");
  }

  #isPayload(value: unknown): value is CursorPayload {
    if (value === null || typeof value !== "object") {
      return false;
    }
    const payload = value as Partial<CursorPayload>;
    return (
      payload.v === 1 &&
      typeof payload.operation === "string" &&
      typeof payload.fingerprint === "string" &&
      typeof payload.offset === "number" &&
      Number.isSafeInteger(payload.offset) &&
      payload.offset >= 0
    );
  }
}
