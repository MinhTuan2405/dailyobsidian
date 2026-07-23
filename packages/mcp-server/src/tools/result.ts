import { toToolError } from "@obsidian-workbench/shared";
import type { z } from "zod";

export function toolSuccess<T extends z.ZodObject>(schema: T, value: unknown) {
  const output = schema.parse(value);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

export function toolFailure(error: unknown) {
  const output = { error: toToolError(error) };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    isError: true as const,
  };
}
