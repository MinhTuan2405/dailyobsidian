import type {
  AppendToNoteInput,
  CreateNoteInput,
  CreateTaskInput,
  MoveNoteInput,
  MutationResult,
  SetFrontmatterInput,
  TrashNoteInput,
  UpdateNoteInput,
  UpdateTaskInput,
} from "@obsidian-workbench/shared";

import type { VaultReadAdapter } from "./vault-read-adapter.js";

export interface VaultAdapter extends VaultReadAdapter {
  createNote(input: CreateNoteInput): Promise<MutationResult>;
  updateNote(input: UpdateNoteInput): Promise<MutationResult>;
  appendToNote(input: AppendToNoteInput): Promise<MutationResult>;
  setFrontmatter(input: SetFrontmatterInput): Promise<MutationResult>;
  moveNote(input: MoveNoteInput): Promise<MutationResult>;
  trashNote(input: TrashNoteInput): Promise<MutationResult>;
  createTask(input: CreateTaskInput): Promise<MutationResult>;
  updateTask(input: UpdateTaskInput): Promise<MutationResult>;
}
