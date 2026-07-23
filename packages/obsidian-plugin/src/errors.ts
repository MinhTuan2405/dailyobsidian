import { WorkbenchError, type ToolErrorCode } from "@obsidian-workbench/shared";

export function workbenchError(
  code: ToolErrorCode,
  message: string,
  recoverable = true,
  details?: Record<string, unknown>,
): WorkbenchError {
  return new WorkbenchError({
    code,
    message,
    recoverable,
    ...(details === undefined ? {} : { details }),
  });
}

export function validationError(
  message = "The request is invalid.",
): WorkbenchError {
  return workbenchError("VALIDATION_ERROR", message);
}

export function sanitizeError(error: unknown): WorkbenchError {
  if (error instanceof WorkbenchError) return error;
  return workbenchError(
    "INTERNAL_ERROR",
    "The companion could not complete the operation.",
    false,
  );
}

export function errorCode(error: unknown): string {
  return error instanceof WorkbenchError
    ? error.toolError.code
    : "INTERNAL_ERROR";
}
