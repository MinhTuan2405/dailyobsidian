import { z } from "zod";

import {
  AppendToNoteInputSchema,
  BacklinkSchema,
  CreateNoteInputSchema,
  CreateTaskInputSchema,
  DailyNoteInputSchema,
  GetBacklinksInputSchema,
  GetOutlinksInputSchema,
  GraphNeighborhoodInputSchema,
  GraphResultSchema,
  ListNotesInputSchema,
  ListTasksInputSchema,
  MoveNoteInputSchema,
  MutationPlanSchema,
  MutationResultSchema,
  NoteDocumentSchema,
  NoteSummarySchema,
  PermissionScopeSchema,
  ProtocolResponseSchema,
  ReadNoteInputSchema,
  RecentNotesInputSchema,
  RevisionSchema,
  SearchNotesInputSchema,
  SearchResultSchema,
  SetFrontmatterInputSchema,
  TaskSchema,
  ToolErrorCodeSchema,
  TrashNoteInputSchema,
  UnresolvedLinkSchema,
  UpdateNoteInputSchema,
  UpdateTaskInputSchema,
  VaultConventionsSchema,
  VaultInfoSchema,
  WikiLinkSchema,
  WorkbenchError,
  paginatedSchema,
  type AppendToNoteInput,
  type CreateNoteInput,
  type CreateTaskInput,
  type DailyNoteInput,
  type GetBacklinksInput,
  type GetOutlinksInput,
  type GraphNeighborhoodInput,
  type ListNotesInput,
  type ListTasksInput,
  type MoveNoteInput,
  type MutationPlan,
  type MutationResult,
  type PermissionScope,
  type ProtocolResponse,
  type ReadNoteInput,
  type RecentNotesInput,
  type SearchNotesInput,
  type SetFrontmatterInput,
  type ToolErrorCode,
  type TrashNoteInput,
  type UpdateNoteInput,
  type UpdateTaskInput,
  type VaultConventions,
  type VaultInfo,
} from "@obsidian-workbench/shared";
import {
  ConfirmationService,
  requestFingerprint,
  type ConfirmationServiceOptions,
  type VaultAdapter,
} from "@obsidian-workbench/vault-core";

import { createVaultRegistry, type VaultRegistry } from "./vault-registry.js";

const NotesPageSchema = paginatedSchema(NoteSummarySchema);
const TasksPageSchema = paginatedSchema(TaskSchema);
const ReadNoteDocumentSchema = NoteDocumentSchema.extend({
  backlinks: z.array(BacklinkSchema).optional(),
});
const UntrustedSearchResultSchema = SearchResultSchema.extend({
  untrustedContent: z.literal(true),
});
const RevisionConflictDetailsSchema = z.object({
  expectedRevision: RevisionSchema,
  currentRevision: RevisionSchema,
});

const RemoteUserSessionSchema = z.object({
  sessionId: z.string().min(1).max(256),
  userId: z.string().min(1).max(256),
  authenticatedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});

const RemoteVaultDescriptorSchema = z
  .object({
    vaultId: z.string().trim().min(1).max(256),
    name: z.string().trim().min(1).max(256),
    scopes: z.array(PermissionScopeSchema).min(1),
    allowedRoots: z.array(z.string()).default([]),
    excludedRoots: z.array(z.string()).default([]),
    conventions: VaultConventionsSchema.partial().optional(),
  })
  .superRefine((descriptor, context) => {
    if (new Set(descriptor.scopes).size !== descriptor.scopes.length) {
      context.addIssue({
        code: "custom",
        message: "Remote vault scopes must be unique.",
      });
    }
    if (!descriptor.scopes.includes("vault.metadata.read")) {
      context.addIssue({
        code: "custom",
        message: "Remote vault metadata scope is required.",
      });
    }
  });

export interface RemoteUserSession {
  sessionId: string;
  userId: string;
  authenticatedAt: number;
  expiresAt: number;
}

export interface RemoteVaultDescriptor {
  vaultId: string;
  name: string;
  scopes: readonly PermissionScope[];
  allowedRoots?: readonly string[];
  excludedRoots?: readonly string[];
  conventions?: Partial<VaultConventions>;
}

export interface RemoteVaultOperations {
  "obsidian.get_vault_info": { vaultId: string };
  "obsidian.list_notes": ListNotesInput;
  "obsidian.search_notes": SearchNotesInput;
  "obsidian.get_note": ReadNoteInput;
  "obsidian.get_backlinks": GetBacklinksInput;
  "obsidian.get_outlinks": GetOutlinksInput;
  "obsidian.get_unresolved_links": GetOutlinksInput;
  "obsidian.get_graph_neighborhood": GraphNeighborhoodInput;
  "obsidian.list_recent_notes": RecentNotesInput;
  "obsidian.get_daily_note": DailyNoteInput;
  "obsidian.list_tasks": ListTasksInput;
  "obsidian.create_note": CreateNoteInput;
  "obsidian.update_note": UpdateNoteInput;
  "obsidian.append_to_note": AppendToNoteInput;
  "obsidian.set_frontmatter": SetFrontmatterInput;
  "obsidian.move_note": MoveNoteInput;
  "obsidian.trash_note": TrashNoteInput;
  "obsidian.create_task": CreateTaskInput;
  "obsidian.update_task": UpdateTaskInput;
}

export type RemoteVaultMethod = keyof RemoteVaultOperations;

export type RemoteRouteRequest<
  Method extends RemoteVaultMethod = RemoteVaultMethod,
> = {
  [CurrentMethod in Method]: {
    user: RemoteUserSession;
    vaultId: string;
    method: CurrentMethod;
    params: RemoteVaultOperations[CurrentMethod];
    scopes: readonly PermissionScope[];
  };
}[Method];

/** Structurally implemented by the remote gateway's RequestRoutingService. */
export interface RemoteRoutingBoundary {
  route(input: RemoteRouteRequest): Promise<ProtocolResponse>;
}

export const REMOTE_VAULT_METHOD_SCOPES = {
  "obsidian.get_vault_info": "vault.metadata.read",
  "obsidian.list_notes": "notes.read",
  "obsidian.search_notes": "notes.read",
  "obsidian.get_note": "notes.read",
  "obsidian.get_backlinks": "notes.read",
  "obsidian.get_outlinks": "notes.read",
  "obsidian.get_unresolved_links": "notes.read",
  "obsidian.get_graph_neighborhood": "notes.read",
  "obsidian.list_recent_notes": "notes.read",
  "obsidian.get_daily_note": "notes.read",
  "obsidian.list_tasks": "tasks.read",
  "obsidian.create_note": "notes.create",
  "obsidian.update_note": "notes.update",
  "obsidian.append_to_note": "notes.update",
  "obsidian.set_frontmatter": "notes.update",
  "obsidian.move_note": "notes.move",
  "obsidian.trash_note": "notes.trash",
  "obsidian.create_task": "tasks.create",
  "obsidian.update_task": "tasks.update",
} as const satisfies Readonly<Record<RemoteVaultMethod, PermissionScope>>;

export interface RemoteVaultAdapterOptions {
  routing: RemoteRoutingBoundary;
  user: RemoteUserSession;
  vault: RemoteVaultDescriptor;
  confirmation?: ConfirmationServiceOptions;
  now?: () => number;
}

export interface CreateRemoteVaultRegistryOptions {
  routing: RemoteRoutingBoundary;
  user: RemoteUserSession;
  vaults: readonly RemoteVaultDescriptor[];
  confirmation?: ConfirmationServiceOptions;
  now?: () => number;
}

type WriteInput =
  | AppendToNoteInput
  | CreateNoteInput
  | CreateTaskInput
  | MoveNoteInput
  | SetFrontmatterInput
  | TrashNoteInput
  | UpdateNoteInput
  | UpdateTaskInput;

type WriteMethod =
  | "obsidian.append_to_note"
  | "obsidian.create_note"
  | "obsidian.create_task"
  | "obsidian.move_note"
  | "obsidian.set_frontmatter"
  | "obsidian.trash_note"
  | "obsidian.update_note"
  | "obsidian.update_task";

type WriteToolName =
  | "appendToNote"
  | "createNote"
  | "createTask"
  | "moveNote"
  | "setFrontmatter"
  | "trashNote"
  | "updateNote"
  | "updateTask";

const SAFE_REMOTE_ERRORS: Readonly<
  Record<ToolErrorCode, { message: string; recoverable: boolean }>
> = {
  VAULT_OFFLINE: {
    message: "The remote vault is offline or unavailable.",
    recoverable: true,
  },
  VAULT_NOT_FOUND: {
    message: "The requested vault could not be found.",
    recoverable: true,
  },
  NOTE_NOT_FOUND: {
    message: "The requested note could not be found.",
    recoverable: true,
  },
  PATH_NOT_ALLOWED: {
    message: "The requested path is not allowed.",
    recoverable: true,
  },
  PATH_TRAVERSAL_BLOCKED: {
    message: "The requested path is not allowed.",
    recoverable: true,
  },
  SYMLINK_ESCAPE_BLOCKED: {
    message: "The requested path is not allowed.",
    recoverable: true,
  },
  REVISION_CONFLICT: {
    message: "The note changed after it was read.",
    recoverable: true,
  },
  VALIDATION_ERROR: {
    message: "The remote vault rejected the request as invalid.",
    recoverable: true,
  },
  PERMISSION_DENIED: {
    message: "The remote vault operation is not permitted.",
    recoverable: true,
  },
  CONFIRMATION_REQUIRED: {
    message: "A valid confirmation is required for this mutation.",
    recoverable: true,
  },
  IDEMPOTENCY_CONFLICT: {
    message: "The remote mutation conflicts with an existing request.",
    recoverable: true,
  },
  UNSUPPORTED_OPERATION: {
    message: "The remote vault does not support this operation.",
    recoverable: true,
  },
  INTERNAL_ERROR: {
    message: "The remote vault could not complete the operation.",
    recoverable: false,
  },
};

const MAX_CACHED_PLANS = 500;

export class RemoteVaultAdapter implements VaultAdapter {
  readonly #routing: RemoteRoutingBoundary;
  readonly #user: RemoteUserSession;
  readonly #vaultId: string;
  readonly #name: string;
  readonly #scopes: readonly PermissionScope[];
  readonly #scopeSet: ReadonlySet<PermissionScope>;
  readonly #allowedRoots: readonly string[];
  readonly #excludedRoots: readonly string[];
  readonly #conventions: VaultConventions;
  readonly #confirmations: ConfirmationService;
  readonly #now: () => number;
  readonly #previewedPlans = new Map<string, MutationPlan>();
  #lastInfo: VaultInfo | undefined;

  constructor(options: RemoteVaultAdapterOptions) {
    let user: RemoteUserSession;
    let descriptor: z.output<typeof RemoteVaultDescriptorSchema>;
    try {
      user = RemoteUserSessionSchema.parse(options.user);
      descriptor = RemoteVaultDescriptorSchema.parse(options.vault);
    } catch {
      throw validationError("The remote vault configuration is invalid.");
    }
    this.#routing = options.routing;
    this.#user = user;
    this.#vaultId = descriptor.vaultId;
    this.#name = descriptor.name;
    this.#scopes = descriptor.scopes;
    this.#scopeSet = new Set(descriptor.scopes);
    this.#allowedRoots = descriptor.allowedRoots;
    this.#excludedRoots = descriptor.excludedRoots;
    this.#conventions = VaultConventionsSchema.parse(
      descriptor.conventions ?? {},
    );
    this.#now = options.now ?? Date.now;
    this.#confirmations = new ConfirmationService({
      ...options.confirmation,
      now: options.confirmation?.now ?? this.#now,
    });
  }

  get scopes(): readonly PermissionScope[] {
    return this.#scopes;
  }

  async getVaultInfo(): Promise<VaultInfo> {
    try {
      const info = await this.#call(
        "obsidian.get_vault_info",
        { vaultId: this.#vaultId },
        VaultInfoSchema,
      );
      if (info.vaultId !== this.#vaultId) throw invalidRemoteResponse();
      const visibleScopes = this.#scopes.filter((scope) =>
        info.capabilities.scopes.includes(scope),
      );
      const connected = info.status.state === "online";
      const normalized = VaultInfoSchema.parse({
        ...info,
        status: {
          ...info.status,
          mode: "remote",
          ...(connected && info.status.lastConnectedAt === undefined
            ? { lastConnectedAt: new Date(this.#now()).toISOString() }
            : {}),
        },
        capabilities: {
          ...info.capabilities,
          scopes: visibleScopes,
          supportsTrash:
            info.capabilities.supportsTrash &&
            visibleScopes.includes("notes.trash"),
          supportsFileManagerMoves:
            info.capabilities.supportsFileManagerMoves &&
            visibleScopes.includes("notes.move"),
        },
      });
      this.#lastInfo = normalized;
      return normalized;
    } catch (error) {
      if (isOfflineError(error)) return this.#offlineInfo();
      throw error;
    }
  }

  async listNotes(input: ListNotesInput) {
    const parsed = parseInput(ListNotesInputSchema, input);
    return await this.#call("obsidian.list_notes", parsed, NotesPageSchema);
  }

  async searchNotes(input: SearchNotesInput) {
    const parsed = parseInput(SearchNotesInputSchema, input);
    return await this.#call(
      "obsidian.search_notes",
      parsed,
      UntrustedSearchResultSchema,
    );
  }

  async readNote(input: ReadNoteInput) {
    const parsed = parseInput(ReadNoteInputSchema, input);
    return await this.#call(
      "obsidian.get_note",
      parsed,
      ReadNoteDocumentSchema,
    );
  }

  async getBacklinks(input: GetBacklinksInput) {
    const parsed = parseInput(GetBacklinksInputSchema, input);
    return await this.#call(
      "obsidian.get_backlinks",
      parsed,
      z.array(BacklinkSchema),
    );
  }

  async getOutlinks(input: GetOutlinksInput) {
    const parsed = parseInput(GetOutlinksInputSchema, input);
    return await this.#call(
      "obsidian.get_outlinks",
      parsed,
      z.array(WikiLinkSchema),
    );
  }

  async getUnresolvedLinks(input: GetOutlinksInput) {
    const parsed = parseInput(GetOutlinksInputSchema, input);
    return await this.#call(
      "obsidian.get_unresolved_links",
      parsed,
      z.array(UnresolvedLinkSchema),
    );
  }

  async getGraphNeighborhood(input: GraphNeighborhoodInput) {
    const parsed = parseInput(GraphNeighborhoodInputSchema, input);
    return await this.#call(
      "obsidian.get_graph_neighborhood",
      parsed,
      GraphResultSchema,
    );
  }

  async listRecentNotes(input: RecentNotesInput) {
    const parsed = parseInput(RecentNotesInputSchema, input);
    return await this.#call(
      "obsidian.list_recent_notes",
      parsed,
      NotesPageSchema,
    );
  }

  async getDailyNote(input: DailyNoteInput) {
    const parsed = parseInput(DailyNoteInputSchema, input);
    return await this.#call(
      "obsidian.get_daily_note",
      parsed,
      ReadNoteDocumentSchema,
    );
  }

  async listTasks(input: ListTasksInput) {
    const parsed = parseInput(ListTasksInputSchema, input);
    return await this.#call("obsidian.list_tasks", parsed, TasksPageSchema);
  }

  async createNote(input: CreateNoteInput): Promise<MutationResult> {
    return await this.#write(
      "obsidian.create_note",
      "createNote",
      parseInput(CreateNoteInputSchema, input),
      false,
    );
  }

  async updateNote(input: UpdateNoteInput): Promise<MutationResult> {
    const parsed = parseInput(UpdateNoteInputSchema, input);
    return await this.#write(
      "obsidian.update_note",
      "updateNote",
      parsed,
      parsed.operation.type === "replace_document",
    );
  }

  async appendToNote(input: AppendToNoteInput): Promise<MutationResult> {
    return await this.#write(
      "obsidian.append_to_note",
      "appendToNote",
      parseInput(AppendToNoteInputSchema, input),
      false,
    );
  }

  async setFrontmatter(input: SetFrontmatterInput): Promise<MutationResult> {
    return await this.#write(
      "obsidian.set_frontmatter",
      "setFrontmatter",
      parseInput(SetFrontmatterInputSchema, input),
      false,
    );
  }

  async moveNote(input: MoveNoteInput): Promise<MutationResult> {
    return await this.#write(
      "obsidian.move_note",
      "moveNote",
      parseInput(MoveNoteInputSchema, input),
      true,
    );
  }

  async trashNote(input: TrashNoteInput): Promise<MutationResult> {
    return await this.#write(
      "obsidian.trash_note",
      "trashNote",
      parseInput(TrashNoteInputSchema, input),
      true,
    );
  }

  async createTask(input: CreateTaskInput): Promise<MutationResult> {
    return await this.#write(
      "obsidian.create_task",
      "createTask",
      parseInput(CreateTaskInputSchema, input),
      false,
    );
  }

  async updateTask(input: UpdateTaskInput): Promise<MutationResult> {
    return await this.#write(
      "obsidian.update_task",
      "updateTask",
      parseInput(UpdateTaskInputSchema, input),
      false,
    );
  }

  issueConfirmation(input: MutationPlan): string {
    const plan = parseConfirmationPlan(input);
    this.#prunePlans();
    const cached = this.#previewedPlans.get(plan.requestHash);
    if (
      cached === undefined ||
      cached.vaultId !== this.#vaultId ||
      !cached.diff.confirmationRequired ||
      JSON.stringify(cached) !== JSON.stringify(plan)
    ) {
      throw confirmationError();
    }
    return this.#confirmations.issueFromPlan(cached, this.#user.userId);
  }

  async #write(
    method: WriteMethod,
    tool: WriteToolName,
    input: WriteInput,
    inherentlyHighRisk: boolean,
  ): Promise<MutationResult> {
    const requestHash = writeRequestHash(tool, input);
    this.#prunePlans();
    if (!input.dryRun) {
      const cached = this.#previewedPlans.get(requestHash);
      const requiresConfirmation =
        inherentlyHighRisk || cached?.diff.confirmationRequired === true;
      if (requiresConfirmation || input.confirmationToken !== undefined) {
        if (
          cached === undefined ||
          !cached.diff.confirmationRequired ||
          input.confirmationToken === undefined
        ) {
          throw confirmationError();
        }
        this.#confirmations.consume(input.confirmationToken, {
          userId: this.#user.userId,
          vaultId: this.#vaultId,
          targetPath: cached.targetPath,
          mutationHash: cached.mutationHash,
        });
        this.#previewedPlans.delete(requestHash);
      }
    }

    const result = await this.#call(method, input, MutationResultSchema);
    if (input.dryRun && result.status !== "preview") {
      throw invalidRemoteResponse();
    }
    if (!input.dryRun && result.status === "preview") {
      throw invalidRemoteResponse();
    }
    if (result.status === "preview") {
      const plan = result.plan;
      if (
        plan === undefined ||
        plan.vaultId !== this.#vaultId ||
        plan.requestHash !== requestHash ||
        (inherentlyHighRisk && !plan.diff.confirmationRequired)
      ) {
        throw invalidRemoteResponse();
      }
      if (plan.diff.confirmationRequired) this.#cachePlan(plan);
    }
    return result;
  }

  async #call<Method extends RemoteVaultMethod, Result>(
    method: Method,
    params: RemoteVaultOperations[Method],
    resultSchema: z.ZodType<Result>,
  ): Promise<Result> {
    this.#assertVault(params.vaultId);
    const requiredScope = REMOTE_VAULT_METHOD_SCOPES[method];
    this.#assertScope(requiredScope);
    let responseValue: ProtocolResponse;
    try {
      responseValue = await this.#routing.route({
        user: this.#user,
        vaultId: this.#vaultId,
        method,
        params,
        scopes: [requiredScope],
      } as RemoteRouteRequest);
    } catch (error) {
      throw routingError(error);
    }

    let response: ProtocolResponse;
    try {
      response = ProtocolResponseSchema.parse(responseValue);
    } catch {
      throw invalidRemoteResponse();
    }
    if (response.error !== undefined) {
      throw structuredRemoteError(response.error.code, response.error.data);
    }
    if (response.result === undefined) throw invalidRemoteResponse();
    try {
      return resultSchema.parse(response.result);
    } catch {
      throw invalidRemoteResponse();
    }
  }

  #cachePlan(plan: MutationPlan): void {
    this.#previewedPlans.delete(plan.requestHash);
    this.#previewedPlans.set(plan.requestHash, plan);
    if (this.#previewedPlans.size <= MAX_CACHED_PLANS) return;
    const oldest = this.#previewedPlans.keys().next().value as
      string | undefined;
    if (oldest !== undefined) this.#previewedPlans.delete(oldest);
  }

  #prunePlans(): void {
    const now = this.#now();
    for (const [requestHash, plan] of this.#previewedPlans) {
      if (Date.parse(plan.expiresAt) <= now) {
        this.#previewedPlans.delete(requestHash);
      }
    }
  }

  #offlineInfo(): VaultInfo {
    const previous = this.#lastInfo;
    return VaultInfoSchema.parse({
      ...(previous ?? {
        vaultId: this.#vaultId,
        name: this.#name,
        capabilities: {
          scopes: this.#scopes,
          supportsTrash: this.#scopeSet.has("notes.trash"),
          supportsFileManagerMoves: this.#scopeSet.has("notes.move"),
          supportsEvents: false,
          supportsOpenInObsidian: false,
        },
        allowedRoots: this.#allowedRoots,
        excludedRoots: this.#excludedRoots,
        conventions: this.#conventions,
      }),
      status: {
        state: "offline",
        mode: "remote",
        ...(previous?.status.lastConnectedAt === undefined
          ? {}
          : { lastConnectedAt: previous.status.lastConnectedAt }),
        lastError: SAFE_REMOTE_ERRORS.VAULT_OFFLINE.message,
      },
    });
  }

  #assertVault(vaultId: string): void {
    if (vaultId !== this.#vaultId) {
      throw new WorkbenchError({
        code: "VAULT_NOT_FOUND",
        message: SAFE_REMOTE_ERRORS.VAULT_NOT_FOUND.message,
        recoverable: true,
      });
    }
  }

  #assertScope(scope: PermissionScope): void {
    if (!this.#scopeSet.has(scope)) {
      throw new WorkbenchError({
        code: "PERMISSION_DENIED",
        message: "The operation is not permitted by the remote vault scopes.",
        recoverable: true,
      });
    }
  }
}

export function createRemoteVaultRegistry(
  options: CreateRemoteVaultRegistryOptions,
): VaultRegistry {
  return createVaultRegistry(
    options.vaults.map(
      (vault) =>
        new RemoteVaultAdapter({
          routing: options.routing,
          user: options.user,
          vault,
          ...(options.confirmation === undefined
            ? {}
            : { confirmation: options.confirmation }),
          ...(options.now === undefined ? {} : { now: options.now }),
        }),
    ),
  );
}

function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  try {
    return schema.parse(value) as z.output<Schema>;
  } catch {
    throw validationError();
  }
}

function parseConfirmationPlan(value: unknown): MutationPlan {
  try {
    return MutationPlanSchema.parse(value);
  } catch {
    throw confirmationError();
  }
}

function writeRequestHash(tool: WriteToolName, input: WriteInput): string {
  const payload = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) =>
        key !== "confirmationToken" &&
        key !== "dryRun" &&
        key !== "idempotencyKey",
    ),
  );
  return `sha256:${requestFingerprint({ tool, payload })}`;
}

function validationError(
  message = "The remote vault request is invalid.",
): WorkbenchError {
  return new WorkbenchError({
    code: "VALIDATION_ERROR",
    message,
    recoverable: true,
  });
}

function confirmationError(): WorkbenchError {
  return new WorkbenchError({
    code: "CONFIRMATION_REQUIRED",
    message: SAFE_REMOTE_ERRORS.CONFIRMATION_REQUIRED.message,
    recoverable: true,
  });
}

function invalidRemoteResponse(): WorkbenchError {
  return new WorkbenchError({
    code: "INTERNAL_ERROR",
    message: "The remote vault returned an invalid response.",
    recoverable: false,
  });
}

function structuredRemoteError(
  code: string,
  data?: Record<string, unknown>,
): WorkbenchError {
  const parsedCode = ToolErrorCodeSchema.safeParse(code);
  if (!parsedCode.success) return invalidRemoteResponse();
  const safe = SAFE_REMOTE_ERRORS[parsedCode.data];
  const details =
    parsedCode.data === "REVISION_CONFLICT"
      ? RevisionConflictDetailsSchema.safeParse(data)
      : undefined;
  return new WorkbenchError({
    code: parsedCode.data,
    message: safe.message,
    recoverable: safe.recoverable,
    ...(details?.success === true ? { details: details.data } : {}),
  });
}

function routingError(error: unknown): WorkbenchError {
  if (error instanceof WorkbenchError) return error;
  const code = objectErrorCode(error);
  switch (code) {
    case "AUTHENTICATION_REQUIRED":
    case "PAIRING_INVALID":
      return new WorkbenchError({
        code: "PERMISSION_DENIED",
        message: "An authenticated remote vault session is required.",
        recoverable: true,
      });
    case "CAPACITY_EXCEEDED":
    case "REQUEST_TIMEOUT":
    case "VAULT_OFFLINE":
      return structuredRemoteError("VAULT_OFFLINE");
    case "INVALID_REQUEST":
      return structuredRemoteError("VALIDATION_ERROR");
    default:
      return code === undefined
        ? new WorkbenchError({
            code: "INTERNAL_ERROR",
            message:
              "The remote routing service could not complete the request.",
            recoverable: false,
          })
        : structuredRemoteError(code);
  }
}

function objectErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isOfflineError(error: unknown): boolean {
  return (
    error instanceof WorkbenchError && error.toolError.code === "VAULT_OFFLINE"
  );
}
