import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AppendToNoteInputSchema,
  CreateNoteInputSchema,
  CreateTaskInputSchema,
  MoveNoteInputSchema,
  MutationResultSchema,
  SetFrontmatterInputSchema,
  TrashNoteInputSchema,
  UpdateNoteInputSchema,
  UpdateTaskInputSchema,
} from "@obsidian-workbench/shared";

import type { VaultRegistry } from "../adapters/vault-registry.js";
import { toolFailure, toolSuccess } from "./result.js";

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const DESTRUCTIVE_ANNOTATIONS = {
  ...WRITE_ANNOTATIONS,
  destructiveHint: true,
} as const;

export function registerWriteTools(
  server: McpServer,
  registry: VaultRegistry,
): void {
  server.registerTool(
    "obsidian.create_note",
    {
      title: "Create an Obsidian note",
      description:
        "Use this tool when the user asks to create a Markdown note at an authorized vault path; preview first when the destination is uncertain.",
      inputSchema: CreateNoteInputSchema,
      outputSchema: MutationResultSchema,
      annotations: WRITE_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(
          MutationResultSchema,
          await (await registry.get(input.vaultId)).createNote(input),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.append_to_note",
    {
      title: "Append to an Obsidian note",
      description:
        "Use this tool when the user asks to append Markdown at the end of, or under a heading in, an authorized note using its expected revision.",
      inputSchema: AppendToNoteInputSchema,
      outputSchema: MutationResultSchema,
      annotations: WRITE_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(
          MutationResultSchema,
          await (await registry.get(input.vaultId)).appendToNote(input),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.update_note",
    {
      title: "Update an Obsidian note",
      description:
        "Use this tool when the user asks for an explicit range, section, patch, or confirmed document update to an authorized note.",
      inputSchema: UpdateNoteInputSchema,
      outputSchema: MutationResultSchema,
      annotations: WRITE_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(
          MutationResultSchema,
          await (await registry.get(input.vaultId)).updateNote(input),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.set_frontmatter",
    {
      title: "Set Obsidian note frontmatter",
      description:
        "Use this tool when the user asks to set or remove specific frontmatter fields while preserving unrelated note data.",
      inputSchema: SetFrontmatterInputSchema,
      outputSchema: MutationResultSchema,
      annotations: WRITE_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(
          MutationResultSchema,
          await (await registry.get(input.vaultId)).setFrontmatter(input),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.move_note",
    {
      title: "Move an Obsidian note",
      description:
        "Use this tool when the user asks to move an authorized note after reviewing its dry-run plan and confirming the exact destination.",
      inputSchema: MoveNoteInputSchema,
      outputSchema: MutationResultSchema,
      annotations: WRITE_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(
          MutationResultSchema,
          await (await registry.get(input.vaultId)).moveNote(input),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.trash_note",
    {
      title: "Move an Obsidian note to trash",
      description:
        "Use this tool only when the user explicitly asks to trash a note and has reviewed and confirmed the exact dry-run mutation.",
      inputSchema: TrashNoteInputSchema,
      outputSchema: MutationResultSchema,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(
          MutationResultSchema,
          await (await registry.get(input.vaultId)).trashNote(input),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.create_task",
    {
      title: "Create an Obsidian task",
      description:
        "Use this tool when the user asks to append a Markdown task to a specific authorized note and revision.",
      inputSchema: CreateTaskInputSchema,
      outputSchema: MutationResultSchema,
      annotations: WRITE_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(
          MutationResultSchema,
          await (await registry.get(input.vaultId)).createTask(input),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.update_task",
    {
      title: "Update an Obsidian task",
      description:
        "Use this tool when the user asks to update a known Markdown task using its source note's expected revision.",
      inputSchema: UpdateTaskInputSchema,
      outputSchema: MutationResultSchema,
      annotations: WRITE_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(
          MutationResultSchema,
          await (await registry.get(input.vaultId)).updateTask(input),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
