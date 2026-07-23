import { z } from "zod";

import { FrontmatterValueSchema, PaginationCursorSchema } from "./common.js";
import { NoteIdentitySchema } from "./notes.js";

export const SearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(1000),
  mode: z.enum(["text", "metadata", "hybrid"]).default("hybrid"),
  folders: z.array(z.string()).default([]),
  excludedFolders: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  frontmatter: z.record(z.string(), FrontmatterValueSchema).default({}),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: PaginationCursorSchema.optional(),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const SearchHitSchema = z.object({
  note: NoteIdentitySchema,
  score: z.number().nonnegative(),
  snippet: z.string().max(2000),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  matchedFields: z.array(z.string()),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchResultSchema = z.object({
  hits: z.array(SearchHitSchema),
  nextCursor: PaginationCursorSchema.optional(),
  total: z.number().int().nonnegative(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;
