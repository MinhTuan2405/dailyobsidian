import { z } from "zod";

export const EntityIdSchema = z.string().trim().min(1).max(256);
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const LocalDateSchema = z.iso.date();
export const RevisionSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "Expected a SHA-256 content revision");

export const PaginationCursorSchema = z
  .string()
  .min(1)
  .max(2048)
  .brand("PaginationCursor");
export type PaginationCursor = z.infer<typeof PaginationCursorSchema>;

export const PaginationInputSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: PaginationCursorSchema.optional(),
});
export type PaginationInput = z.infer<typeof PaginationInputSchema>;

export function paginatedSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: PaginationCursorSchema.optional(),
    total: z.number().int().nonnegative().optional(),
  });
}

export interface Paginated<T> {
  items: T[];
  nextCursor?: PaginationCursor;
  total?: number;
}

export type FrontmatterValue =
  | null
  | string
  | number
  | boolean
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue };

export const FrontmatterValueSchema: z.ZodType<FrontmatterValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.array(FrontmatterValueSchema),
    z.record(z.string(), FrontmatterValueSchema),
  ]),
);
