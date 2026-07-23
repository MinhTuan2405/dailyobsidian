import {
  AppendToNoteInputSchema,
  CreateNoteInputSchema,
  CreateTaskInputSchema,
  DailyNoteInputSchema,
  GetBacklinksInputSchema,
  GetOutlinksInputSchema,
  GraphNeighborhoodInputSchema,
  ListNotesInputSchema,
  ListTasksInputSchema,
  MoveNoteInputSchema,
  ProtocolRequestSchema,
  ProtocolResponseSchema,
  ReadNoteInputSchema,
  RecentNotesInputSchema,
  SearchNotesInputSchema,
  SetFrontmatterInputSchema,
  TrashNoteInputSchema,
  UpdateNoteInputSchema,
  UpdateTaskInputSchema,
  VaultTargetSchema,
  type PermissionScope,
  type ProtocolRequest,
  type ProtocolResponse,
} from "@obsidian-workbench/shared";
import type { VaultAdapter } from "@obsidian-workbench/vault-core";

import type { AuditLog } from "./audit.js";
import { errorCode, sanitizeError, workbenchError } from "./errors.js";

export interface RouterIdentity {
  deviceId: string;
  userId: string;
  vaultId: string;
  scopes: readonly PermissionScope[];
}

export interface RequestRouterOptions {
  adapter: VaultAdapter;
  audit: AuditLog;
  identity(): RouterIdentity | undefined;
  enabledScopes(): readonly PermissionScope[];
  now?: () => number;
  maxNonceAgeMs?: number;
}

interface MethodPolicy {
  scope: PermissionScope;
  mutation: boolean;
}

const METHOD_POLICY: Readonly<Record<string, MethodPolicy>> = {
  "obsidian.get_vault_info": { scope: "vault.metadata.read", mutation: false },
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

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function auditTarget(params: unknown): string {
  const value = objectValue(params);
  for (const key of ["noteId", "taskId", "path", "destinationPath"]) {
    if (typeof value[key] === "string") return value[key].slice(0, 512);
  }
  return "";
}

export class RequestRouter {
  readonly #adapter: VaultAdapter;
  readonly #audit: AuditLog;
  readonly #identity: () => RouterIdentity | undefined;
  readonly #enabledScopes: () => readonly PermissionScope[];
  readonly #now: () => number;
  readonly #maxNonceAgeMs: number;
  readonly #nonces = new Map<string, number>();
  readonly #inflightMutations = new Set<string>();

  constructor(options: RequestRouterOptions) {
    this.#adapter = options.adapter;
    this.#audit = options.audit;
    this.#identity = options.identity;
    this.#enabledScopes = options.enabledScopes;
    this.#now = options.now ?? Date.now;
    this.#maxNonceAgeMs = options.maxNonceAgeMs ?? 2 * 60 * 1000;
  }

  async route(
    requestValue: ProtocolRequest,
    signal?: AbortSignal,
  ): Promise<ProtocolResponse> {
    const startedAt = this.#now();
    let requestId = "invalid";
    let method = "invalid";
    let target = "";
    let confirmationUsed = false;
    let resultCode = "INTERNAL_ERROR";
    try {
      const request = ProtocolRequestSchema.parse(requestValue);
      requestId = request.id;
      method = request.method;
      target = auditTarget(request.params);
      confirmationUsed =
        typeof objectValue(request.params).confirmationToken === "string";
      this.#authorize(request);
      if (signal?.aborted) {
        throw workbenchError(
          "VAULT_OFFLINE",
          "The request was cancelled before execution.",
        );
      }
      const policy = METHOD_POLICY[request.method];
      if (policy === undefined) {
        throw workbenchError(
          "UNSUPPORTED_OPERATION",
          "The requested companion method is not allowed.",
        );
      }
      this.#assertScope(request, policy.scope);
      const mutationKey = policy.mutation
        ? this.#mutationKey(request)
        : undefined;
      if (
        mutationKey !== undefined &&
        this.#inflightMutations.has(mutationKey)
      ) {
        throw workbenchError(
          "IDEMPOTENCY_CONFLICT",
          "A mutation with this idempotency key is already in flight.",
        );
      }
      if (mutationKey !== undefined) this.#inflightMutations.add(mutationKey);
      try {
        const result = await this.#dispatch(request);
        const operationId = objectValue(result).operationId;
        if (typeof operationId === "string") requestId = operationId;
        resultCode = "OK";
        return ProtocolResponseSchema.parse({
          jsonrpc: "2.0",
          id: request.id,
          result,
        });
      } finally {
        if (mutationKey !== undefined)
          this.#inflightMutations.delete(mutationKey);
      }
    } catch (error) {
      const safe = sanitizeError(error);
      resultCode = errorCode(safe);
      return ProtocolResponseSchema.parse({
        jsonrpc: "2.0",
        id: requestId,
        error: {
          code: safe.toolError.code,
          message: safe.toolError.message,
        },
      });
    } finally {
      this.#audit.record({
        operationId: requestId,
        method,
        target,
        resultCode,
        durationMs: this.#now() - startedAt,
        confirmationUsed,
      });
    }
  }

  #authorize(request: ProtocolRequest): void {
    const identity = this.#identity();
    const parameterVaultId = objectValue(request.params).vaultId;
    if (
      identity === undefined ||
      request.deviceId !== identity.deviceId ||
      request.userId !== identity.userId ||
      request.vaultId !== identity.vaultId ||
      parameterVaultId !== request.vaultId
    ) {
      throw workbenchError(
        "PERMISSION_DENIED",
        "The request is not authorized for this device and vault.",
      );
    }
    const issuedAt = Date.parse(request.issuedAt);
    const age = this.#now() - issuedAt;
    if (age > this.#maxNonceAgeMs || age < -30_000) {
      throw workbenchError(
        "PERMISSION_DENIED",
        "The request timestamp is outside the allowed window.",
      );
    }
    this.#purgeNonces();
    if (this.#nonces.has(request.nonce)) {
      throw workbenchError(
        "PERMISSION_DENIED",
        "The request nonce has already been used.",
      );
    }
    this.#nonces.set(request.nonce, this.#now() + this.#maxNonceAgeMs);
    if (this.#nonces.size > 5_000) {
      const oldest = this.#nonces.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#nonces.delete(oldest);
    }
  }

  #assertScope(request: ProtocolRequest, required: PermissionScope): void {
    const identity = this.#identity();
    if (identity === undefined) {
      throw workbenchError("PERMISSION_DENIED", "The device is not paired.");
    }
    const paired = new Set(identity.scopes);
    const enabled = new Set(this.#enabledScopes());
    if (
      !request.scopes.includes(required) ||
      !paired.has(required) ||
      !enabled.has(required) ||
      request.scopes.some((scope) => !paired.has(scope) || !enabled.has(scope))
    ) {
      throw workbenchError(
        "PERMISSION_DENIED",
        "The request contains an unauthorized permission scope.",
      );
    }
  }

  #mutationKey(request: ProtocolRequest): string {
    const key = objectValue(request.params).idempotencyKey;
    if (typeof key !== "string") {
      throw workbenchError(
        "VALIDATION_ERROR",
        "A mutation idempotency key is required.",
      );
    }
    return `${request.deviceId}\0${request.method}\0${key}`;
  }

  async #dispatch(request: ProtocolRequest): Promise<unknown> {
    switch (request.method) {
      case "obsidian.get_vault_info": {
        VaultTargetSchema.parse(request.params);
        return await this.#adapter.getVaultInfo();
      }
      case "obsidian.get_connection_status": {
        VaultTargetSchema.parse(request.params);
        return (await this.#adapter.getVaultInfo()).status;
      }
      case "obsidian.get_vault_conventions": {
        VaultTargetSchema.parse(request.params);
        return (await this.#adapter.getVaultInfo()).conventions;
      }
      case "obsidian.list_notes":
        return await this.#adapter.listNotes(
          ListNotesInputSchema.parse(request.params),
        );
      case "obsidian.search_notes":
        return await this.#adapter.searchNotes(
          SearchNotesInputSchema.parse(request.params),
        );
      case "obsidian.get_note":
        return await this.#adapter.readNote(
          ReadNoteInputSchema.parse(request.params),
        );
      case "obsidian.get_backlinks":
        return await this.#adapter.getBacklinks(
          GetBacklinksInputSchema.parse(request.params),
        );
      case "obsidian.get_outlinks":
        return await this.#adapter.getOutlinks(
          GetOutlinksInputSchema.parse(request.params),
        );
      case "obsidian.get_unresolved_links":
        return await this.#adapter.getUnresolvedLinks(
          GetOutlinksInputSchema.parse(request.params),
        );
      case "obsidian.get_graph_neighborhood":
        return await this.#adapter.getGraphNeighborhood(
          GraphNeighborhoodInputSchema.parse(request.params),
        );
      case "obsidian.list_recent_notes":
        return await this.#adapter.listRecentNotes(
          RecentNotesInputSchema.parse(request.params),
        );
      case "obsidian.get_daily_note":
        return await this.#adapter.getDailyNote(
          DailyNoteInputSchema.parse(request.params),
        );
      case "obsidian.list_tasks":
        return await this.#adapter.listTasks(
          ListTasksInputSchema.parse(request.params),
        );
      case "obsidian.create_note":
        return await this.#adapter.createNote(
          CreateNoteInputSchema.parse(request.params),
        );
      case "obsidian.update_note":
        return await this.#adapter.updateNote(
          UpdateNoteInputSchema.parse(request.params),
        );
      case "obsidian.append_to_note":
        return await this.#adapter.appendToNote(
          AppendToNoteInputSchema.parse(request.params),
        );
      case "obsidian.set_frontmatter":
        return await this.#adapter.setFrontmatter(
          SetFrontmatterInputSchema.parse(request.params),
        );
      case "obsidian.move_note":
        return await this.#adapter.moveNote(
          MoveNoteInputSchema.parse(request.params),
        );
      case "obsidian.trash_note":
        return await this.#adapter.trashNote(
          TrashNoteInputSchema.parse(request.params),
        );
      case "obsidian.create_task":
        return await this.#adapter.createTask(
          CreateTaskInputSchema.parse(request.params),
        );
      case "obsidian.update_task":
        return await this.#adapter.updateTask(
          UpdateTaskInputSchema.parse(request.params),
        );
      default:
        throw workbenchError(
          "UNSUPPORTED_OPERATION",
          "The requested companion method is not allowed.",
        );
    }
  }

  #purgeNonces(): void {
    const now = this.#now();
    for (const [nonce, expiresAt] of this.#nonces) {
      if (expiresAt <= now) this.#nonces.delete(nonce);
    }
  }
}
