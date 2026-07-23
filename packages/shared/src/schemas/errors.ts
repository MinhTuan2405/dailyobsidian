import { z } from "zod";

export const ToolErrorCodeSchema = z.enum([
  "VAULT_OFFLINE",
  "VAULT_NOT_FOUND",
  "NOTE_NOT_FOUND",
  "PATH_NOT_ALLOWED",
  "PATH_TRAVERSAL_BLOCKED",
  "SYMLINK_ESCAPE_BLOCKED",
  "REVISION_CONFLICT",
  "VALIDATION_ERROR",
  "PERMISSION_DENIED",
  "CONFIRMATION_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
  "UNSUPPORTED_OPERATION",
  "INTERNAL_ERROR",
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;

export const ToolErrorSchema = z.object({
  code: ToolErrorCodeSchema,
  message: z.string().min(1).max(1000),
  recoverable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

export const RevisionConflictSchema = z.object({
  error: ToolErrorSchema.extend({
    code: z.literal("REVISION_CONFLICT"),
    recoverable: z.literal(true),
    details: z.object({
      expectedRevision: z.string(),
      currentRevision: z.string(),
    }),
  }),
});
export type RevisionConflict = z.infer<typeof RevisionConflictSchema>;

export class WorkbenchError extends Error {
  readonly toolError: ToolError;

  constructor(toolError: ToolError) {
    super(toolError.message);
    this.name = "WorkbenchError";
    this.toolError = ToolErrorSchema.parse(toolError);
  }
}

export function toToolError(error: unknown): ToolError {
  if (error instanceof WorkbenchError) {
    return error.toolError;
  }
  return {
    code: "INTERNAL_ERROR",
    message: "An internal error occurred.",
    recoverable: false,
  };
}
