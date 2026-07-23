import type {
  MutationPlan,
  MutationResult,
  NoteDocument,
  UpdateNoteInput,
} from "@obsidian-workbench/shared";

export type ScreenId =
  "vault" | "search" | "note" | "diff" | "capture" | "tasks" | "maintenance";

export interface PendingMutation {
  previews: MutationResult[];
  apply: (
    plan: MutationPlan,
    confirmationToken?: string,
  ) => Promise<MutationResult>;
  editScreen: ScreenId;
}

export interface NoteDraft {
  document: NoteDocument;
  markdown: string;
  request: Omit<UpdateNoteInput, "dryRun" | "confirmationToken">;
}
