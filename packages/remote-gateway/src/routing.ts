import { randomBytes, randomUUID } from "node:crypto";

import {
  PermissionScopeSchema,
  ProtocolRequestSchema,
  ProtocolResponseSchema,
  type PermissionScope,
  type ProtocolResponse,
} from "@obsidian-workbench/shared";

import { GatewayError } from "./errors.js";
import type { UserSession } from "./models.js";
import type { GatewayRepository } from "./repository.js";
import type {
  GatewayOutboundSession,
  GatewaySessionRegistry,
} from "./sessions.js";

interface MethodPolicy {
  scope: PermissionScope;
  mutation: boolean;
}

export const GATEWAY_METHOD_POLICY: Readonly<Record<string, MethodPolicy>> = {
  "obsidian.get_vault_info": {
    scope: "vault.metadata.read",
    mutation: false,
  },
  "obsidian.get_connection_status": {
    scope: "vault.metadata.read",
    mutation: false,
  },
  "obsidian.get_vault_conventions": {
    scope: "vault.metadata.read",
    mutation: false,
  },
  "obsidian.list_notes": { scope: "notes.read", mutation: false },
  "obsidian.search_notes": { scope: "notes.read", mutation: false },
  "obsidian.get_note": { scope: "notes.read", mutation: false },
  "obsidian.get_backlinks": { scope: "notes.read", mutation: false },
  "obsidian.get_outlinks": { scope: "notes.read", mutation: false },
  "obsidian.get_unresolved_links": { scope: "notes.read", mutation: false },
  "obsidian.get_graph_neighborhood": { scope: "notes.read", mutation: false },
  "obsidian.list_recent_notes": { scope: "notes.read", mutation: false },
  "obsidian.get_daily_note": { scope: "notes.read", mutation: false },
  "obsidian.list_tasks": { scope: "tasks.read", mutation: false },
  "obsidian.create_note": { scope: "notes.create", mutation: true },
  "obsidian.update_note": { scope: "notes.update", mutation: true },
  "obsidian.append_to_note": { scope: "notes.update", mutation: true },
  "obsidian.set_frontmatter": { scope: "notes.update", mutation: true },
  "obsidian.move_note": { scope: "notes.move", mutation: true },
  "obsidian.trash_note": { scope: "notes.trash", mutation: true },
  "obsidian.create_task": { scope: "tasks.create", mutation: true },
  "obsidian.update_task": { scope: "tasks.update", mutation: true },
};

export interface RouteRequest {
  user: UserSession;
  vaultId: string;
  method: string;
  params?: unknown;
  scopes: readonly PermissionScope[];
}

export interface RequestRoutingServiceOptions {
  repository: GatewayRepository;
  sessions: GatewaySessionRegistry;
  now?: () => number;
  newRequestId?: () => string;
  newNonce?: () => string;
}

export class RequestRoutingService {
  readonly #repository: GatewayRepository;
  readonly #sessions: GatewaySessionRegistry;
  readonly #now: () => number;
  readonly #newRequestId: () => string;
  readonly #newNonce: () => string;
  readonly #inflightMutations = new Set<string>();
  readonly #recentNonces = new Set<string>();
  readonly #nonceOrder: string[] = [];

  constructor(options: RequestRoutingServiceOptions) {
    this.#repository = options.repository;
    this.#sessions = options.sessions;
    this.#now = options.now ?? Date.now;
    this.#newRequestId = options.newRequestId ?? randomUUID;
    this.#newNonce =
      options.newNonce ?? (() => randomBytes(18).toString("base64url"));
  }

  async route(input: RouteRequest): Promise<ProtocolResponse> {
    const now = this.#now();
    if (input.user.expiresAt <= now) {
      throw new GatewayError(
        "AUTHENTICATION_REQUIRED",
        "An authenticated account session is required.",
        401,
      );
    }
    const account = await this.#repository.getAccount(input.user.userId);
    if (account === undefined || account.disabledAt !== undefined) {
      throw new GatewayError(
        "AUTHENTICATION_REQUIRED",
        "An authenticated account session is required.",
        401,
      );
    }
    const policy = GATEWAY_METHOD_POLICY[input.method];
    if (policy === undefined) {
      throw new GatewayError(
        "PERMISSION_DENIED",
        "The requested method is not allowed by the remote gateway.",
        403,
      );
    }
    const parsedScopes = PermissionScopeSchema.array().safeParse([
      ...input.scopes,
    ]);
    if (!parsedScopes.success) throw permissionError();
    const scopes = parsedScopes.data;
    if (
      scopes.length === 0 ||
      new Set(scopes).size !== scopes.length ||
      !scopes.includes(policy.scope)
    ) {
      throw permissionError();
    }
    const params = objectValue(input.params);
    if (params.vaultId !== input.vaultId) throw permissionError();

    const authorizations = await this.#repository.listVaultAuthorizations(
      input.user.userId,
      input.vaultId,
    );
    const permitted = authorizations.filter(
      (authorization) =>
        authorization.revokedAt === undefined &&
        scopes.every((scope) => authorization.scopes.includes(scope)),
    );
    if (permitted.length === 0) throw permissionError();

    let session: GatewayOutboundSession | undefined;
    for (const authorization of permitted) {
      const candidate = this.#sessions.get(
        authorization.deviceId,
        authorization.vaultId,
      );
      if (
        candidate !== undefined &&
        candidate.identity.userId === input.user.userId &&
        scopes.every((scope) => candidate.identity.scopes.includes(scope)) &&
        (session === undefined || candidate.connectedAt > session.connectedAt)
      ) {
        session = candidate;
      }
    }
    if (session === undefined) throw offlineError();

    const mutationKey = policy.mutation
      ? mutationKeyFor(input.user.userId, input.vaultId, input.method, params)
      : undefined;
    if (mutationKey !== undefined && this.#inflightMutations.has(mutationKey)) {
      throw new GatewayError(
        "IDEMPOTENCY_CONFLICT",
        "A mutation with this idempotency key is already in flight.",
        409,
      );
    }
    if (mutationKey !== undefined) this.#inflightMutations.add(mutationKey);
    try {
      const request = ProtocolRequestSchema.parse({
        jsonrpc: "2.0",
        id: this.#newRequestId(),
        method: input.method,
        params: input.params,
        userId: input.user.userId,
        deviceId: session.identity.deviceId,
        vaultId: input.vaultId,
        scopes,
        issuedAt: new Date(now).toISOString(),
        nonce: this.#takeNonce(),
      });
      return ProtocolResponseSchema.parse(await session.request(request));
    } finally {
      if (mutationKey !== undefined)
        this.#inflightMutations.delete(mutationKey);
    }
  }

  #takeNonce(): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const nonce = this.#newNonce();
      if (nonce.length < 16 || this.#recentNonces.has(nonce)) continue;
      this.#recentNonces.add(nonce);
      this.#nonceOrder.push(nonce);
      if (this.#nonceOrder.length > 5_000) {
        const oldest = this.#nonceOrder.shift();
        if (oldest !== undefined) this.#recentNonces.delete(oldest);
      }
      return nonce;
    }
    throw new GatewayError(
      "INTERNAL_ERROR",
      "The gateway could not create a unique request nonce.",
      500,
    );
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function mutationKeyFor(
  userId: string,
  vaultId: string,
  method: string,
  params: Record<string, unknown>,
): string {
  const idempotencyKey = params.idempotencyKey;
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
    throw new GatewayError(
      "INVALID_REQUEST",
      "A mutation idempotency key is required.",
      400,
    );
  }
  return `${userId}\0${vaultId}\0${method}\0${idempotencyKey}`;
}

function permissionError(): GatewayError {
  return new GatewayError(
    "PERMISSION_DENIED",
    "The account is not authorized for this vault, method, and scope set.",
    403,
  );
}

function offlineError(): GatewayError {
  return new GatewayError(
    "VAULT_OFFLINE",
    "The vault companion is offline; the request was not queued.",
    503,
  );
}
