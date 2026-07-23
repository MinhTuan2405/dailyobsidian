import type { App } from "@modelcontextprotocol/ext-apps";
import {
  MutationResultSchema,
  NoteDocumentSchema,
  NoteSummarySchema,
  SearchResultSchema,
  TaskSchema,
  ToolErrorSchema,
  VaultInfoSchema,
  paginatedSchema,
  type CreateNoteInput,
  type ListTasksInput,
  type MutationPlan,
  type MutationResult,
  type NoteDocument,
  type NoteSummary,
  type SearchResult,
  type Task,
  type UpdateNoteInput,
  type UpdateTaskInput,
  type VaultInfo,
} from "@obsidian-workbench/shared";
import { z } from "zod";

const VaultListSchema = z.object({ vaults: z.array(VaultInfoSchema) });
const SearchOutputSchema = SearchResultSchema.extend({
  untrustedContent: z.literal(true),
});
const NoteOutputSchema = NoteDocumentSchema.extend({
  backlinks: z.array(z.unknown()).optional(),
});
const NotesPageSchema = paginatedSchema(NoteSummarySchema);
const TasksPageSchema = paginatedSchema(TaskSchema);
const OrphanOutputSchema = z.object({
  notes: z.array(NoteSummarySchema),
  truncated: z.boolean(),
});
const ConfirmationOutputSchema = z.object({ confirmationToken: z.string() });

export class BridgeError extends Error {
  readonly code: string;
  readonly recoverable: boolean;

  constructor(code: string, message: string, recoverable = true) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export interface WorkbenchBridge {
  listVaults(): Promise<VaultInfo[]>;
  listNotes(vaultId: string, limit?: number): Promise<NoteSummary[]>;
  searchNotes(vaultId: string, query: string): Promise<SearchResult>;
  getNote(vaultId: string, noteId: string): Promise<NoteDocument>;
  listTasks(input: ListTasksInput): Promise<Task[]>;
  findOrphans(vaultId: string): Promise<NoteSummary[]>;
  createNote(input: CreateNoteInput): Promise<MutationResult>;
  updateNote(input: UpdateNoteInput): Promise<MutationResult>;
  updateTask(input: UpdateTaskInput): Promise<MutationResult>;
  confirmMutation(plan: MutationPlan): Promise<string>;
}

interface ToolCaller {
  callServerTool(input: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{
    structuredContent?: Record<string, unknown>;
    content?: unknown;
    isError?: boolean;
  }>;
}

export class McpWorkbenchBridge implements WorkbenchBridge {
  readonly #app: ToolCaller;

  constructor(app: App) {
    this.#app = app;
  }

  async listVaults(): Promise<VaultInfo[]> {
    return (await this.#call("obsidian.list_vaults", {}, VaultListSchema))
      .vaults;
  }

  async listNotes(vaultId: string, limit = 100): Promise<NoteSummary[]> {
    return (
      await this.#call(
        "obsidian.list_notes",
        { vaultId, limit },
        NotesPageSchema,
      )
    ).items;
  }

  async searchNotes(vaultId: string, query: string): Promise<SearchResult> {
    return await this.#call(
      "obsidian.search_notes",
      { vaultId, search: { query, limit: 50 } },
      SearchOutputSchema,
    );
  }

  async getNote(vaultId: string, noteId: string): Promise<NoteDocument> {
    return await this.#call(
      "obsidian.get_note",
      { vaultId, noteId },
      NoteOutputSchema,
    );
  }

  async listTasks(input: ListTasksInput): Promise<Task[]> {
    return (
      await this.#call(
        "obsidian.list_tasks",
        input as Record<string, unknown>,
        TasksPageSchema,
      )
    ).items;
  }

  async findOrphans(vaultId: string): Promise<NoteSummary[]> {
    return (
      await this.#call(
        "obsidian.find_orphan_notes",
        { vaultId },
        OrphanOutputSchema,
      )
    ).notes;
  }

  async createNote(input: CreateNoteInput): Promise<MutationResult> {
    return await this.#call(
      "obsidian.create_note",
      input as Record<string, unknown>,
      MutationResultSchema,
    );
  }

  async updateNote(input: UpdateNoteInput): Promise<MutationResult> {
    return await this.#call(
      "obsidian.update_note",
      input as Record<string, unknown>,
      MutationResultSchema,
    );
  }

  async updateTask(input: UpdateTaskInput): Promise<MutationResult> {
    return await this.#call(
      "obsidian.update_task",
      input as Record<string, unknown>,
      MutationResultSchema,
    );
  }

  async confirmMutation(plan: MutationPlan): Promise<string> {
    return (
      await this.#call(
        "obsidian.ui.confirm_mutation",
        { plan },
        ConfirmationOutputSchema,
      )
    ).confirmationToken;
  }

  async #call<T extends z.ZodType>(
    name: string,
    arguments_: Record<string, unknown>,
    schema: T,
  ): Promise<z.output<T>> {
    const result = await this.#app.callServerTool({
      name,
      arguments: arguments_,
    });
    if (result.isError) {
      const error = this.#parseError(result.content);
      throw new BridgeError(error.code, error.message, error.recoverable);
    }
    const parsed = schema.safeParse(result.structuredContent);
    if (!parsed.success) {
      throw new BridgeError(
        "VALIDATION_ERROR",
        "The MCP server returned an invalid response.",
        false,
      );
    }
    return parsed.data;
  }

  #parseError(content: unknown) {
    try {
      const first = Array.isArray(content) ? content[0] : undefined;
      if (
        first !== null &&
        typeof first === "object" &&
        "text" in first &&
        typeof first.text === "string"
      ) {
        const payload: unknown = JSON.parse(first.text);
        if (
          payload !== null &&
          typeof payload === "object" &&
          "error" in payload
        ) {
          const parsed = ToolErrorSchema.safeParse(payload.error);
          if (parsed.success) return parsed.data;
        }
      }
    } catch {
      // Fall through to a stable error that cannot leak transport details.
    }
    return {
      code: "INTERNAL_ERROR",
      message: "The MCP operation failed.",
      recoverable: false,
    };
  }
}
