import { z } from "zod";

import { EntityIdSchema } from "./common.js";

export const WikiLinkSchema = z.object({
  raw: z.string(),
  target: z.string().min(1),
  alias: z.string().optional(),
  heading: z.string().optional(),
  blockId: z.string().optional(),
  embedded: z.boolean(),
  line: z.number().int().positive(),
  resolvedNoteId: EntityIdSchema.optional(),
});
export type WikiLink = z.infer<typeof WikiLinkSchema>;

export const BacklinkSchema = z.object({
  sourceNoteId: EntityIdSchema,
  sourcePath: z.string(),
  targetNoteId: EntityIdSchema,
  line: z.number().int().positive(),
  context: z.string().max(1000),
});
export type Backlink = z.infer<typeof BacklinkSchema>;

export const UnresolvedLinkSchema = WikiLinkSchema.omit({
  resolvedNoteId: true,
}).extend({
  sourceNoteId: EntityIdSchema,
});
export type UnresolvedLink = z.infer<typeof UnresolvedLinkSchema>;

export const GraphNodeSchema = z.object({
  noteId: EntityIdSchema,
  path: z.string(),
  title: z.string(),
  depth: z.number().int().min(0).max(2),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  sourceNoteId: EntityIdSchema,
  targetNoteId: EntityIdSchema,
  kind: z.enum(["link", "embed", "backlink"]),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphResultSchema = z.object({
  nodes: z.array(GraphNodeSchema).max(200),
  edges: z.array(GraphEdgeSchema),
  truncated: z.boolean(),
});
export type GraphResult = z.infer<typeof GraphResultSchema>;
