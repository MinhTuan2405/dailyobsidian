import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BacklinkSchema,
  ConnectionStatusSchema,
  DailyNoteInputSchema,
  GetBacklinksInputSchema,
  GetOutlinksInputSchema,
  GraphNeighborhoodInputSchema,
  GraphResultSchema,
  HeadingSchema,
  ListNotesInputSchema,
  ListTasksInputSchema,
  NoteDocumentSchema,
  NoteSummarySchema,
  ReadNoteInputSchema,
  RecentNotesInputSchema,
  SearchNotesInputSchema,
  SearchResultSchema,
  TaskSchema,
  UnresolvedLinkSchema,
  VaultConventionsSchema,
  VaultInfoSchema,
  VaultTargetSchema,
  WikiLinkSchema,
  paginatedSchema,
} from "@obsidian-workbench/shared";
import { z } from "zod";

import type { VaultRegistry } from "../adapters/vault-registry.js";
import { WORKBENCH_APP_URI } from "../app/workbench-app.js";
import { toolFailure, toolSuccess } from "./result.js";

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const EmptyInputSchema = z.object({});
const VaultListOutputSchema = z.object({ vaults: z.array(VaultInfoSchema) });
const ReadNoteOutputSchema = NoteDocumentSchema.extend({
  backlinks: z.array(BacklinkSchema).optional(),
});
const SearchOutputSchema = SearchResultSchema.extend({
  untrustedContent: z.literal(true),
});
const BacklinksOutputSchema = z.object({ backlinks: z.array(BacklinkSchema) });
const OutlinksOutputSchema = z.object({ outlinks: z.array(WikiLinkSchema) });
const UnresolvedOutputSchema = z.object({
  unresolvedLinks: z.array(UnresolvedLinkSchema),
});
const GraphOutputSchema = z.object({ graph: GraphResultSchema });
const NoteContextOutputSchema = z.object({
  backlinks: z.array(BacklinkSchema),
  outgoingLinks: z.array(WikiLinkSchema),
  unresolvedLinks: z.array(UnresolvedLinkSchema),
  headings: z.array(HeadingSchema),
  embeddedNoteIds: z.array(z.string()),
  relatedNotes: z.array(NoteSummarySchema),
  graph: GraphResultSchema,
  untrustedContent: z.literal(true),
});
const NotesPageOutputSchema = paginatedSchema(NoteSummarySchema);
const TasksPageOutputSchema = paginatedSchema(TaskSchema);
const OrphanOutputSchema = z.object({
  notes: z.array(NoteSummarySchema),
  truncated: z.boolean(),
});
const HubInputSchema = VaultTargetSchema.extend({
  limit: z.number().int().min(1).max(100).default(20),
});
const HubOutputSchema = z.object({
  hubs: z.array(
    z.object({
      note: NoteSummarySchema,
      incomingLinks: z.number().int().nonnegative(),
      outgoingLinks: z.number().int().nonnegative(),
    }),
  ),
  truncated: z.boolean(),
});

export function registerReadTools(
  server: McpServer,
  registry: VaultRegistry,
): void {
  server.registerTool(
    "obsidian.list_vaults",
    {
      title: "List authorized Obsidian vaults",
      description:
        "Use this tool when the user asks which authorized Obsidian vaults are available.",
      inputSchema: EmptyInputSchema,
      outputSchema: VaultListOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ui: { resourceUri: WORKBENCH_APP_URI, visibility: ["model", "app"] },
      },
    },
    async () => {
      try {
        return toolSuccess(VaultListOutputSchema, {
          vaults: await registry.list(),
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.get_vault_info",
    {
      title: "Get Obsidian vault information",
      description:
        "Use this tool when the user asks about an authorized vault's status, capabilities, folder policy, or conventions.",
      inputSchema: VaultTargetSchema,
      outputSchema: VaultInfoSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ vaultId }) => {
      try {
        return toolSuccess(
          VaultInfoSchema,
          await (await registry.get(vaultId)).getVaultInfo(),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.get_connection_status",
    {
      title: "Get Obsidian connection status",
      description:
        "Use this tool when the user asks whether an authorized Obsidian vault is online.",
      inputSchema: VaultTargetSchema,
      outputSchema: ConnectionStatusSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ vaultId }) => {
      try {
        const info = await (await registry.get(vaultId)).getVaultInfo();
        return toolSuccess(ConnectionStatusSchema, info.status);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.get_vault_conventions",
    {
      title: "Get Obsidian vault conventions",
      description:
        "Use this tool before capture or daily-note workflows to read the authorized vault's configured conventions.",
      inputSchema: VaultTargetSchema,
      outputSchema: VaultConventionsSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ vaultId }) => {
      try {
        const info = await (await registry.get(vaultId)).getVaultInfo();
        return toolSuccess(VaultConventionsSchema, info.conventions);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.list_notes",
    {
      title: "List authorized Obsidian notes",
      description:
        "Use this tool when the user asks to browse or filter note summaries in an authorized Obsidian vault.",
      inputSchema: ListNotesInputSchema,
      outputSchema: NotesPageOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(
          NotesPageOutputSchema,
          await (await registry.get(input.vaultId)).listNotes(input),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.search_notes",
    {
      title: "Search authorized Obsidian notes",
      description:
        "Use this tool when the user asks to find notes in an authorized Obsidian vault; results contain bounded snippets, not full note bodies.",
      inputSchema: SearchNotesInputSchema,
      outputSchema: SearchOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(
          SearchOutputSchema,
          await (await registry.get(input.vaultId)).searchNotes(input),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.get_note",
    {
      title: "Read an authorized Obsidian note",
      description:
        "Use this tool when the user asks to read a specific authorized Obsidian note and its selected metadata.",
      inputSchema: ReadNoteInputSchema,
      outputSchema: ReadNoteOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(
          ReadNoteOutputSchema,
          await (await registry.get(input.vaultId)).readNote(input),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.get_note_context",
    {
      title: "Inspect Obsidian note context",
      description:
        "Use this tool when the user asks for links, headings, embeds, related notes, or a bounded graph around an authorized note.",
      inputSchema: GraphNeighborhoodInputSchema,
      outputSchema: NoteContextOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        const adapter = await registry.get(input.vaultId);
        const [
          document,
          backlinks,
          outgoingLinks,
          unresolvedLinks,
          graph,
          notes,
        ] = await Promise.all([
          adapter.readNote({
            vaultId: input.vaultId,
            noteId: input.noteId,
            includeContent: false,
            includeFrontmatter: false,
            includeHeadings: true,
            includeLinks: true,
            includeBacklinks: false,
            includeUnresolvedLinks: true,
          }),
          adapter.getBacklinks(input),
          adapter.getOutlinks(input),
          adapter.getUnresolvedLinks(input),
          adapter.getGraphNeighborhood(input),
          adapter.listNotes({ vaultId: input.vaultId, limit: 200 }),
        ]);
        const relatedIds = new Set(
          graph.nodes
            .filter((node) => node.noteId !== input.noteId)
            .map((node) => node.noteId),
        );
        return toolSuccess(NoteContextOutputSchema, {
          backlinks,
          outgoingLinks,
          unresolvedLinks,
          headings: document.headings ?? [],
          embeddedNoteIds: outgoingLinks
            .filter(
              (link) => link.embedded && link.resolvedNoteId !== undefined,
            )
            .map((link) => link.resolvedNoteId),
          relatedNotes: notes.items.filter((note) =>
            relatedIds.has(note.noteId),
          ),
          graph,
          untrustedContent: true,
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.get_daily_note",
    {
      title: "Read an Obsidian daily note",
      description:
        "Use this tool when the user asks to read the authorized daily note for a specific date.",
      inputSchema: DailyNoteInputSchema,
      outputSchema: ReadNoteOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(
          ReadNoteOutputSchema,
          await (await registry.get(input.vaultId)).getDailyNote(input),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.list_recent_notes",
    {
      title: "List recent Obsidian notes",
      description:
        "Use this tool when the user asks for recently modified notes in an authorized Obsidian vault.",
      inputSchema: RecentNotesInputSchema,
      outputSchema: NotesPageOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(
          NotesPageOutputSchema,
          await (await registry.get(input.vaultId)).listRecentNotes(input),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.get_backlinks",
    {
      title: "Get Obsidian backlinks",
      description:
        "Use this tool when the user asks which authorized notes link to a specific note.",
      inputSchema: GetBacklinksInputSchema,
      outputSchema: BacklinksOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(BacklinksOutputSchema, {
          backlinks: await (
            await registry.get(input.vaultId)
          ).getBacklinks(input),
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.get_outlinks",
    {
      title: "Get Obsidian outgoing links",
      description:
        "Use this tool when the user asks which notes a specific authorized note links to.",
      inputSchema: GetOutlinksInputSchema,
      outputSchema: OutlinksOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(OutlinksOutputSchema, {
          outlinks: await (
            await registry.get(input.vaultId)
          ).getOutlinks(input),
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.get_unresolved_links",
    {
      title: "Get unresolved Obsidian links",
      description:
        "Use this tool when the user asks for unresolved wikilinks in a specific authorized note.",
      inputSchema: GetOutlinksInputSchema,
      outputSchema: UnresolvedOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(UnresolvedOutputSchema, {
          unresolvedLinks: await (
            await registry.get(input.vaultId)
          ).getUnresolvedLinks(input),
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.get_graph_neighborhood",
    {
      title: "Get Obsidian graph neighborhood",
      description:
        "Use this tool when the user asks for a bounded graph neighborhood around an authorized note.",
      inputSchema: GraphNeighborhoodInputSchema,
      outputSchema: GraphOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(GraphOutputSchema, {
          graph: await (
            await registry.get(input.vaultId)
          ).getGraphNeighborhood(input),
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.find_orphan_notes",
    {
      title: "Find orphan Obsidian notes",
      description:
        "Use this tool when the user asks for authorized notes with no incoming or outgoing wikilinks.",
      inputSchema: VaultTargetSchema,
      outputSchema: OrphanOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ vaultId }) => {
      try {
        const adapter = await registry.get(vaultId);
        const page = await adapter.listNotes({ vaultId, limit: 200 });
        const notes = [];
        for (const note of page.items) {
          const [incoming, outgoing] = await Promise.all([
            adapter.getBacklinks({ vaultId, noteId: note.noteId }),
            adapter.getOutlinks({ vaultId, noteId: note.noteId }),
          ]);
          if (incoming.length === 0 && outgoing.length === 0) notes.push(note);
        }
        return toolSuccess(OrphanOutputSchema, {
          notes,
          truncated: page.nextCursor !== undefined,
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.find_hub_notes",
    {
      title: "Find Obsidian hub notes",
      description:
        "Use this tool when the user asks which authorized notes have the most wikilink connections.",
      inputSchema: HubInputSchema,
      outputSchema: HubOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ vaultId, limit }) => {
      try {
        const adapter = await registry.get(vaultId);
        const page = await adapter.listNotes({ vaultId, limit: 200 });
        const hubs = await Promise.all(
          page.items.map(async (note) => {
            const [incoming, outgoing] = await Promise.all([
              adapter.getBacklinks({ vaultId, noteId: note.noteId }),
              adapter.getOutlinks({ vaultId, noteId: note.noteId }),
            ]);
            return {
              note,
              incomingLinks: incoming.length,
              outgoingLinks: outgoing.length,
            };
          }),
        );
        hubs.sort(
          (left, right) =>
            right.incomingLinks +
              right.outgoingLinks -
              (left.incomingLinks + left.outgoingLinks) ||
            left.note.path.localeCompare(right.note.path),
        );
        return toolSuccess(HubOutputSchema, {
          hubs: hubs.slice(0, limit),
          truncated: page.nextCursor !== undefined || hubs.length > limit,
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "obsidian.list_tasks",
    {
      title: "List Obsidian tasks",
      description:
        "Use this tool when the user asks to list or filter Markdown tasks in an authorized Obsidian vault.",
      inputSchema: ListTasksInputSchema,
      outputSchema: TasksPageOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return toolSuccess(
          TasksPageOutputSchema,
          await (await registry.get(input.vaultId)).listTasks(input),
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
