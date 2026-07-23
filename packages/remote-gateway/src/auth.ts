import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { UserSession } from "./models.js";

export interface AuthenticationRequest {
  sessionToken: string;
  now: number;
}

export interface AuthProvider {
  authenticate(
    request: AuthenticationRequest,
  ): Promise<UserSession | undefined>;
}

interface StoredSession extends UserSession {
  tokenDigest: Buffer;
  revokedAt?: number;
}

export interface CreatedTestSession {
  session: UserSession;
  sessionToken: string;
}

/** In-memory account-session provider intended for isolated tests. */
export class InMemoryAuthProvider implements AuthProvider {
  readonly #sessions = new Map<string, StoredSession>();

  createSession(
    userId: string,
    now: number,
    ttlMs = 60 * 60 * 1000,
  ): CreatedTestSession {
    if (userId.length === 0 || ttlMs <= 0) {
      throw new TypeError(
        "A user ID and positive session lifetime are required.",
      );
    }
    const sessionToken = randomBytes(32).toString("base64url");
    const tokenDigest = digestToken(sessionToken);
    const session: UserSession = {
      sessionId: randomUUID(),
      userId,
      authenticatedAt: now,
      expiresAt: now + ttlMs,
    };
    this.#sessions.set(tokenDigest.toString("base64url"), {
      ...session,
      tokenDigest,
    });
    return { session: { ...session }, sessionToken };
  }

  async authenticate(
    request: AuthenticationRequest,
  ): Promise<UserSession | undefined> {
    if (
      request.sessionToken.length < 16 ||
      request.sessionToken.length > 8192
    ) {
      return undefined;
    }
    const suppliedDigest = digestToken(request.sessionToken);
    const stored = this.#sessions.get(suppliedDigest.toString("base64url"));
    if (
      stored === undefined ||
      stored.revokedAt !== undefined ||
      stored.expiresAt <= request.now ||
      stored.tokenDigest.length !== suppliedDigest.length ||
      !timingSafeEqual(stored.tokenDigest, suppliedDigest)
    ) {
      return undefined;
    }
    return {
      sessionId: stored.sessionId,
      userId: stored.userId,
      authenticatedAt: stored.authenticatedAt,
      expiresAt: stored.expiresAt,
    };
  }

  revokeSession(sessionId: string, revokedAt: number): boolean {
    for (const [digest, session] of this.#sessions) {
      if (session.sessionId === sessionId && session.revokedAt === undefined) {
        this.#sessions.set(digest, { ...session, revokedAt });
        return true;
      }
    }
    return false;
  }
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
