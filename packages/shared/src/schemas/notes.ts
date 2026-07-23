import { z } from "zod";

import {
  EntityIdSchema,
  FrontmatterValueSchema,
  IsoDateTimeSchema,
  RevisionSchema,
} from "./common.js";
import { UnresolvedLinkSchema, WikiLinkSchema } from "./links.js";

export const NoteIdentitySchema = z.object({
  noteId: EntityIdSchema,
  vaultId: EntityIdSchema,
  path: z.string().min(1),
  title: z.string(),
  revision: RevisionSchema,
});
export type NoteIdentity = z.infer<typeof NoteIdentitySchema>;

export const HeadingSchema = z.object({
  text: z.string(),
  level: z.number().int().min(1).max(6),
  line: z.number().int().positive(),
  anchor: z.string(),
});
export type Heading = z.infer<typeof HeadingSchema>;

export const NoteSummarySchema = NoteIdentitySchema.extend({
  createdAt: IsoDateTimeSchema,
  modifiedAt: IsoDateTimeSchema,
  tags: z.array(z.string()),
  excerpt: z.string().max(1000).optional(),
});
export type NoteSummary = z.infer<typeof NoteSummarySchema>;

export const NoteDocumentSchema = z.object({
  identity: NoteIdentitySchema,
  content: z.string().optional(),
  frontmatter: z.record(z.string(), FrontmatterValueSchema).optional(),
  headings: z.array(HeadingSchema).optional(),
  links: z.array(WikiLinkSchema).optional(),
  unresolvedLinks: z.array(UnresolvedLinkSchema).optional(),
  createdAt: IsoDateTimeSchema,
  modifiedAt: IsoDateTimeSchema,
  untrustedContent: z.literal(true),
});
export type NoteDocument = z.infer<typeof NoteDocumentSchema>;
