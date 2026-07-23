import { z } from "zod";

import { EntityIdSchema, LocalDateSchema } from "./common.js";

export const TaskStatusSchema = z.enum([
  "open",
  "completed",
  "cancelled",
  "in_progress",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  taskId: EntityIdSchema,
  noteId: EntityIdSchema,
  vaultId: EntityIdSchema,
  path: z.string(),
  line: z.number().int().positive(),
  text: z.string(),
  status: TaskStatusSchema,
  blockId: z.string().optional(),
  fingerprint: z.string(),
  dueDate: LocalDateSchema.optional(),
  scheduledDate: LocalDateSchema.optional(),
  priority: z.enum(["lowest", "low", "normal", "medium", "high", "highest"]),
  tags: z.array(z.string()),
});
export type Task = z.infer<typeof TaskSchema>;
