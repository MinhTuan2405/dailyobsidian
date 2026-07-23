import { z } from "zod";

import { EntityIdSchema, RevisionSchema } from "./common.js";
import { NoteIdentitySchema } from "./notes.js";

export const MutationOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("replace_range"),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    content: z.string(),
  }),
  z.object({
    type: z.literal("replace_section"),
    heading: z.string().min(1),
    content: z.string(),
  }),
  z.object({
    type: z.literal("apply_patch"),
    patch: z.string().min(1),
  }),
  z.object({
    type: z.literal("replace_document"),
    content: z.string(),
  }),
]);
export type MutationOperation = z.infer<typeof MutationOperationSchema>;

export const MutationDiffSchema = z.object({
  path: z.string(),
  originalRevision: RevisionSchema.optional(),
  proposedRevision: RevisionSchema,
  unifiedDiff: z.string(),
  changedSections: z.array(z.string()),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  riskLevel: z.enum(["low", "medium", "high"]),
  confirmationRequired: z.boolean(),
});
export type MutationDiff = z.infer<typeof MutationDiffSchema>;

export const MutationPlanSchema = z.object({
  mutationId: EntityIdSchema,
  vaultId: EntityIdSchema,
  targetNoteId: EntityIdSchema.optional(),
  targetPath: z.string(),
  operation: z.string(),
  requestHash: RevisionSchema,
  mutationHash: RevisionSchema,
  diff: MutationDiffSchema,
  expiresAt: z.iso.datetime({ offset: true }),
});
export type MutationPlan = z.infer<typeof MutationPlanSchema>;

export const MutationResultSchema = z.object({
  operationId: EntityIdSchema,
  status: z.enum(["preview", "applied", "unchanged"]),
  note: NoteIdentitySchema.optional(),
  diff: MutationDiffSchema.optional(),
  plan: MutationPlanSchema.optional(),
  idempotentReplay: z.boolean(),
});
export type MutationResult = z.infer<typeof MutationResultSchema>;

export const WriteSafetySchema = z.object({
  expectedRevision: RevisionSchema.optional(),
  idempotencyKey: z.string().min(8).max(256),
  dryRun: z.boolean().default(true),
  confirmationToken: z.string().min(1).optional(),
});
export type WriteSafety = z.infer<typeof WriteSafetySchema>;
