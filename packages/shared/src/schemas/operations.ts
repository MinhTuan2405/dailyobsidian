import { z } from "zod";

import {
  FrontmatterValueSchema,
  IsoDateTimeSchema,
  LocalDateSchema,
  PaginationInputSchema,
} from "./common.js";
import { MutationOperationSchema, WriteSafetySchema } from "./mutations.js";
import { SearchQuerySchema } from "./search.js";
import { TaskStatusSchema } from "./tasks.js";

export const VaultTargetSchema = z.object({ vaultId: z.string().min(1) });
export const NoteTargetSchema = VaultTargetSchema.extend({
  noteId: z.string().min(1),
});

export const ListNotesInputSchema = VaultTargetSchema.extend({
  folder: z.string().optional(),
  tags: z.array(z.string()).default([]),
  modifiedAfter: z.iso.datetime({ offset: true }).optional(),
  modifiedBefore: z.iso.datetime({ offset: true }).optional(),
  createdAfter: z.iso.datetime({ offset: true }).optional(),
  createdBefore: z.iso.datetime({ offset: true }).optional(),
  sort: z.enum(["title", "created", "modified"]).default("modified"),
  order: z.enum(["asc", "desc"]).default("desc"),
}).merge(PaginationInputSchema);
export type ListNotesInput = z.input<typeof ListNotesInputSchema>;

export const SearchNotesInputSchema = VaultTargetSchema.extend({
  search: SearchQuerySchema,
});
export type SearchNotesInput = z.input<typeof SearchNotesInputSchema>;

export const ReadNoteInputSchema = NoteTargetSchema.extend({
  includeContent: z.boolean().default(true),
  includeFrontmatter: z.boolean().default(true),
  includeHeadings: z.boolean().default(true),
  includeLinks: z.boolean().default(true),
  includeBacklinks: z.boolean().default(false),
  includeUnresolvedLinks: z.boolean().default(true),
});
export type ReadNoteInput = z.input<typeof ReadNoteInputSchema>;

export const RecentNotesInputSchema = VaultTargetSchema.extend({
  modifiedAfter: IsoDateTimeSchema.optional(),
}).merge(PaginationInputSchema);
export type RecentNotesInput = z.input<typeof RecentNotesInputSchema>;

export const DailyNoteInputSchema = VaultTargetSchema.extend({
  date: LocalDateSchema,
  includeContent: z.boolean().default(true),
  includeFrontmatter: z.boolean().default(true),
  includeHeadings: z.boolean().default(true),
  includeLinks: z.boolean().default(true),
  includeBacklinks: z.boolean().default(false),
  includeUnresolvedLinks: z.boolean().default(true),
});
export type DailyNoteInput = z.input<typeof DailyNoteInputSchema>;

export const CreateNoteInputSchema = VaultTargetSchema.extend({
  path: z.string().min(1),
  content: z.string().default(""),
  frontmatter: z.record(z.string(), FrontmatterValueSchema).default({}),
  createFolders: z.boolean().default(false),
}).merge(WriteSafetySchema.omit({ expectedRevision: true }));
export type CreateNoteInput = z.input<typeof CreateNoteInputSchema>;

export const UpdateNoteInputSchema = NoteTargetSchema.extend({
  expectedRevision: WriteSafetySchema.shape.expectedRevision.unwrap(),
  operation: MutationOperationSchema,
  idempotencyKey: WriteSafetySchema.shape.idempotencyKey,
  dryRun: WriteSafetySchema.shape.dryRun,
  confirmationToken: WriteSafetySchema.shape.confirmationToken,
});
export type UpdateNoteInput = z.input<typeof UpdateNoteInputSchema>;

export const AppendToNoteInputSchema = NoteTargetSchema.extend({
  expectedRevision: WriteSafetySchema.shape.expectedRevision.unwrap(),
  content: z.string(),
  heading: z.string().optional(),
  idempotencyKey: WriteSafetySchema.shape.idempotencyKey,
  dryRun: WriteSafetySchema.shape.dryRun,
  confirmationToken: WriteSafetySchema.shape.confirmationToken,
});
export type AppendToNoteInput = z.input<typeof AppendToNoteInputSchema>;

export const SetFrontmatterInputSchema = NoteTargetSchema.extend({
  expectedRevision: WriteSafetySchema.shape.expectedRevision.unwrap(),
  set: z.record(z.string(), FrontmatterValueSchema).default({}),
  remove: z.array(z.string()).default([]),
  idempotencyKey: WriteSafetySchema.shape.idempotencyKey,
  dryRun: WriteSafetySchema.shape.dryRun,
  confirmationToken: WriteSafetySchema.shape.confirmationToken,
});
export type SetFrontmatterInput = z.input<typeof SetFrontmatterInputSchema>;

export const MoveNoteInputSchema = NoteTargetSchema.extend({
  expectedRevision: WriteSafetySchema.shape.expectedRevision.unwrap(),
  destinationPath: z.string().min(1),
  idempotencyKey: WriteSafetySchema.shape.idempotencyKey,
  dryRun: WriteSafetySchema.shape.dryRun,
  confirmationToken: WriteSafetySchema.shape.confirmationToken,
});
export type MoveNoteInput = z.input<typeof MoveNoteInputSchema>;

export const TrashNoteInputSchema = NoteTargetSchema.extend({
  expectedRevision: WriteSafetySchema.shape.expectedRevision.unwrap(),
  idempotencyKey: WriteSafetySchema.shape.idempotencyKey,
  dryRun: WriteSafetySchema.shape.dryRun,
  confirmationToken: WriteSafetySchema.shape.confirmationToken,
});
export type TrashNoteInput = z.input<typeof TrashNoteInputSchema>;

export const GetBacklinksInputSchema = NoteTargetSchema;
export type GetBacklinksInput = z.infer<typeof GetBacklinksInputSchema>;

export const GetOutlinksInputSchema = NoteTargetSchema;
export type GetOutlinksInput = z.infer<typeof GetOutlinksInputSchema>;

export const GraphNeighborhoodInputSchema = NoteTargetSchema.extend({
  depth: z.number().int().min(1).max(2).default(1),
  maxNodes: z.number().int().min(1).max(200).default(100),
});
export type GraphNeighborhoodInput = z.input<
  typeof GraphNeighborhoodInputSchema
>;

export const ListTasksInputSchema = VaultTargetSchema.extend({
  status: z.array(TaskStatusSchema).default([]),
  dueFrom: LocalDateSchema.optional(),
  dueTo: LocalDateSchema.optional(),
  scheduledFrom: LocalDateSchema.optional(),
  scheduledTo: LocalDateSchema.optional(),
  folder: z.string().optional(),
  projectTag: z.string().optional(),
  tags: z.array(z.string()).default([]),
  priority: z.array(z.string()).default([]),
  noteId: z.string().optional(),
}).merge(PaginationInputSchema);
export type ListTasksInput = z.input<typeof ListTasksInputSchema>;

export const CreateTaskInputSchema = NoteTargetSchema.extend({
  expectedRevision: WriteSafetySchema.shape.expectedRevision.unwrap(),
  text: z.string().min(1),
  heading: z.string().optional(),
  dueDate: LocalDateSchema.optional(),
  idempotencyKey: WriteSafetySchema.shape.idempotencyKey,
  dryRun: WriteSafetySchema.shape.dryRun,
  confirmationToken: WriteSafetySchema.shape.confirmationToken,
});
export type CreateTaskInput = z.input<typeof CreateTaskInputSchema>;

export const UpdateTaskInputSchema = VaultTargetSchema.extend({
  taskId: z.string().min(1),
  expectedRevision: WriteSafetySchema.shape.expectedRevision.unwrap(),
  status: TaskStatusSchema.optional(),
  text: z.string().min(1).optional(),
  dueDate: LocalDateSchema.nullable().optional(),
  idempotencyKey: WriteSafetySchema.shape.idempotencyKey,
  dryRun: WriteSafetySchema.shape.dryRun,
  confirmationToken: WriteSafetySchema.shape.confirmationToken,
}).refine(
  (input) =>
    input.status !== undefined ||
    input.text !== undefined ||
    input.dueDate !== undefined,
  { message: "At least one task field must be updated." },
);
export type UpdateTaskInput = z.input<typeof UpdateTaskInputSchema>;
