import {
  AppendToNoteInputSchema,
  BacklinkSchema,
  CreateNoteInputSchema,
  CreateTaskInputSchema,
  DailyNoteInputSchema,
  GetBacklinksInputSchema,
  GetOutlinksInputSchema,
  GraphNeighborhoodInputSchema,
  GraphResultSchema,
  ListNotesInputSchema,
  ListTasksInputSchema,
  LocalDateSchema,
  MoveNoteInputSchema,
  MutationResultSchema,
  NoteDocumentSchema,
  NoteSummarySchema,
  PaginationCursorSchema,
  ReadNoteInputSchema,
  RecentNotesInputSchema,
  SearchNotesInputSchema,
  SearchResultSchema,
  SetFrontmatterInputSchema,
  TaskSchema,
  TrashNoteInputSchema,
  UnresolvedLinkSchema,
  UpdateNoteInputSchema,
  UpdateTaskInputSchema,
  VaultConventionsSchema,
  VaultInfoSchema,
  WikiLinkSchema,
  paginatedSchema,
  type AppendToNoteInput,
  type Backlink,
  type CreateNoteInput,
  type CreateTaskInput,
  type DailyNoteInput,
  type FrontmatterValue,
  type GetBacklinksInput,
  type GetOutlinksInput,
  type GraphNeighborhoodInput,
  type GraphResult,
  type Heading,
  type ListNotesInput,
  type ListTasksInput,
  type MoveNoteInput,
  type MutationResult,
  type NoteDocument,
  type NoteIdentity,
  type NoteSummary,
  type Paginated,
  type PaginationCursor,
  type ReadNoteInput,
  type RecentNotesInput,
  type SearchHit,
  type SearchResult,
  type SearchNotesInput,
  type SetFrontmatterInput,
  type Task,
  type TrashNoteInput,
  type UnresolvedLink,
  type UpdateNoteInput,
  type UpdateTaskInput,
  type VaultInfo,
  type WikiLink,
  type WorkbenchError,
} from "@obsidian-workbench/shared";
import type { VaultAdapter } from "@obsidian-workbench/vault-core";
import type { App, CachedMetadata, TAbstractFile, TFile } from "obsidian";

import { sanitizeError, validationError, workbenchError } from "./errors.js";
import { createRevision, hashValue, normalizeContent } from "./hash.js";
import {
  appendContent,
  applyUpdate,
  createNoteContent,
  parseFrontmatter,
  parseHeadings,
  parseTasks,
  parseWikiLinks,
  setFrontmatter,
  updateTaskLine,
  type ParsedTask,
} from "./markdown.js";
import {
  buildMutationPlan,
  mutationRequestHash,
  mutationResult,
} from "./mutations.js";
import type { StableNoteIds } from "./note-ids.js";
import { isAtOrBelow, VaultPermissions } from "./permissions.js";
import type { PluginSettingsData } from "./settings-data.js";
import type { GatewayState } from "./gateway.js";

interface IndexedNote {
  file: TFile;
  content: string;
  identity: NoteIdentity;
  frontmatter: Record<string, FrontmatterValue>;
  headings: Heading[];
  links: WikiLink[];
  tags: string[];
  tasks: ParsedTask[];
  createdAt: string;
  modifiedAt: string;
}

type ReadNoteDocument = NoteDocument & { backlinks?: Backlink[] };
type UntrustedSearchResult = SearchResult & { untrustedContent: true };

interface VaultSnapshot {
  notes: IndexedNote[];
  byId: Map<string, IndexedNote>;
}

interface ExistingMutation {
  note: IndexedNote;
  expectedRevision: string;
  dryRun: boolean;
  confirmationToken?: string;
  requestHash: string;
  operation: string;
  changedSections: string[];
  riskLevel: "low" | "medium" | "high";
  confirmationRequired: boolean;
  transform(content: string): string;
}

interface StoredMutation {
  requestHash: string;
  result: Promise<MutationResult>;
}

interface RuntimeSchema<T> {
  parse(value: unknown): T;
}

export interface ObsidianVaultAdapterOptions {
  app: App;
  settings(): PluginSettingsData;
  noteIds: StableNoteIds;
  connectionState(): GatewayState;
  now?: () => number;
  maxNoteBytes?: number;
}

const PRIORITIES = [
  "lowest",
  "low",
  "normal",
  "medium",
  "high",
  "highest",
] as const;
const MAX_SNIPPET = 600;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedTag(value: string): string {
  return `#${value.replace(/^#/, "").toLocaleLowerCase("en-US")}`;
}

function isMarkdownFile(file: TAbstractFile | null): file is TFile {
  if (file === null) return false;
  const candidate = file as Partial<TFile>;
  return (
    typeof candidate.extension === "string" &&
    candidate.extension.toLocaleLowerCase("en-US") === "md"
  );
}

function safeDate(value: number): string {
  return new Date(
    Number.isFinite(value) && value >= 0 ? value : 0,
  ).toISOString();
}

function valuesEqual(
  left: FrontmatterValue | undefined,
  right: FrontmatterValue,
): boolean {
  return left !== undefined && hashValue(left) === hashValue(right);
}

export class ObsidianVaultAdapter implements VaultAdapter {
  readonly #app: App;
  readonly #settings: () => PluginSettingsData;
  readonly #noteIds: StableNoteIds;
  readonly #connectionState: () => GatewayState;
  readonly #now: () => number;
  readonly #maxNoteBytes: number;
  readonly #idempotency = new Map<string, StoredMutation>();

  constructor(options: ObsidianVaultAdapterOptions) {
    this.#app = options.app;
    this.#settings = options.settings;
    this.#noteIds = options.noteIds;
    this.#connectionState = options.connectionState;
    this.#now = options.now ?? Date.now;
    this.#maxNoteBytes = options.maxNoteBytes ?? 10 * 1024 * 1024;
  }

  async getVaultInfo(): Promise<VaultInfo> {
    return await this.#safe(async () => {
      const permissions = this.#permissions();
      permissions.assertScope("vault.metadata.read");
      const settings = this.#settings();
      const state = this.#connectionState();
      return VaultInfoSchema.parse({
        vaultId: settings.vaultId,
        name: this.#app.vault.getName(),
        status: {
          state,
          mode: "companion",
          ...(state === "error"
            ? { lastError: "The gateway connection failed." }
            : {}),
        },
        capabilities: {
          scopes: settings.enabledScopes,
          supportsTrash: permissions.scopes.has("notes.trash"),
          supportsFileManagerMoves: true,
          supportsEvents: true,
          supportsOpenInObsidian: true,
        },
        allowedRoots: permissions.allowedRoots.map((root) => root || "."),
        excludedRoots: [
          ...permissions.excludedRoots.map((root) => root || "."),
          ".obsidian",
        ],
        conventions: VaultConventionsSchema.parse({}),
      });
    });
  }

  async listNotes(input: ListNotesInput): Promise<Paginated<NoteSummary>> {
    return await this.#safe(async () => {
      const permissions = this.#permissions();
      permissions.assertScope("notes.read");
      const parsed = this.#input(ListNotesInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const folder =
        parsed.folder === undefined
          ? undefined
          : permissions.assertFolder(parsed.folder);
      const requestedTags = parsed.tags.map(normalizedTag);
      const notes = (await this.#snapshot()).notes.filter((note) => {
        if (folder !== undefined && !isAtOrBelow(note.identity.path, folder))
          return false;
        const tags = note.tags.map((tag) => tag.toLocaleLowerCase("en-US"));
        if (!requestedTags.every((tag) => tags.includes(tag))) return false;
        const created = Date.parse(note.createdAt);
        const modified = Date.parse(note.modifiedAt);
        if (
          parsed.createdAfter !== undefined &&
          created <= Date.parse(parsed.createdAfter)
        )
          return false;
        if (
          parsed.createdBefore !== undefined &&
          created >= Date.parse(parsed.createdBefore)
        )
          return false;
        if (
          parsed.modifiedAfter !== undefined &&
          modified <= Date.parse(parsed.modifiedAfter)
        )
          return false;
        if (
          parsed.modifiedBefore !== undefined &&
          modified >= Date.parse(parsed.modifiedBefore)
        )
          return false;
        return true;
      });
      const direction = parsed.order === "asc" ? 1 : -1;
      notes.sort((left, right) => {
        const result =
          parsed.sort === "title"
            ? compareText(
                left.identity.title.toLocaleLowerCase("en-US"),
                right.identity.title.toLocaleLowerCase("en-US"),
              )
            : parsed.sort === "created"
              ? compareText(left.createdAt, right.createdAt)
              : compareText(left.modifiedAt, right.modifiedAt);
        return result === 0
          ? compareText(left.identity.path, right.identity.path)
          : result * direction;
      });
      return this.#notePage(notes, parsed.limit, parsed.cursor, "list-notes", {
        ...parsed,
        cursor: undefined,
      });
    });
  }

  async searchNotes(input: SearchNotesInput): Promise<UntrustedSearchResult> {
    return await this.#safe(async () => {
      const permissions = this.#permissions();
      permissions.assertScope("notes.read");
      const parsed = this.#input(SearchNotesInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const folders = parsed.search.folders.map((folder) =>
        permissions.assertFolder(folder),
      );
      const excluded = parsed.search.excludedFolders.map((folder) =>
        permissions.assertFolder(folder),
      );
      const requestedTags = parsed.search.tags.map(normalizedTag);
      const needle = parsed.search.query.toLocaleLowerCase("en-US");
      const hits: SearchHit[] = [];
      for (const note of (await this.#snapshot()).notes) {
        if (
          folders.length > 0 &&
          !folders.some((folder) => isAtOrBelow(note.identity.path, folder))
        )
          continue;
        if (excluded.some((folder) => isAtOrBelow(note.identity.path, folder)))
          continue;
        const tags = note.tags.map((tag) => tag.toLocaleLowerCase("en-US"));
        if (!requestedTags.every((tag) => tags.includes(tag))) continue;
        if (
          !Object.entries(parsed.search.frontmatter).every(([key, value]) =>
            valuesEqual(note.frontmatter[key], value),
          )
        )
          continue;
        const fields = new Set<string>();
        let score = 0;
        const title = note.identity.title.toLocaleLowerCase("en-US");
        const headings = note.headings
          .map((heading) => heading.text)
          .join("\n")
          .toLocaleLowerCase("en-US");
        const content = note.content.toLocaleLowerCase("en-US");
        const metadata = JSON.stringify({
          path: note.identity.path,
          tags,
          frontmatter: note.frontmatter,
        }).toLocaleLowerCase("en-US");
        if (parsed.search.mode !== "metadata") {
          if (title.includes(needle)) {
            score += 100;
            fields.add("title");
          }
          if (headings.includes(needle)) {
            score += 30;
            fields.add("headings");
          }
          const occurrences = content.split(needle).length - 1;
          if (occurrences > 0) {
            score += Math.min(10, occurrences);
            fields.add("content");
          }
        }
        if (parsed.search.mode !== "text" && metadata.includes(needle)) {
          score += tags.some((tag) => tag.includes(needle)) ? 25 : 10;
          fields.add("metadata");
        }
        if (score === 0) continue;
        const snippet = this.#snippet(note.content, needle);
        hits.push({
          note: note.identity,
          score,
          snippet: snippet.text,
          lineStart: snippet.lineStart,
          lineEnd: snippet.lineEnd,
          matchedFields: [...fields].sort(),
        });
      }
      hits.sort(
        (left, right) =>
          right.score - left.score ||
          compareText(left.note.path, right.note.path),
      );
      const fingerprint = hashValue({
        ...parsed,
        search: { ...parsed.search, cursor: undefined },
      });
      const offset = this.#decodeCursor(
        parsed.search.cursor,
        "search-notes",
        fingerprint,
        hits.length,
      );
      const end = Math.min(offset + parsed.search.limit, hits.length);
      const result = SearchResultSchema.parse({
        hits: hits.slice(offset, end),
        ...(end < hits.length
          ? { nextCursor: this.#encodeCursor("search-notes", fingerprint, end) }
          : {}),
        total: hits.length,
      });
      return { ...result, untrustedContent: true };
    });
  }

  async readNote(input: ReadNoteInput): Promise<ReadNoteDocument> {
    return await this.#safe(async () => {
      this.#permissions().assertScope("notes.read");
      const parsed = this.#input(ReadNoteInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const snapshot = await this.#snapshot();
      const note = this.#findNote(snapshot, parsed.noteId);
      const unresolvedLinks = this.#unresolvedLinks(note);
      const document: NoteDocument = NoteDocumentSchema.parse({
        identity: note.identity,
        ...(parsed.includeContent ? { content: note.content } : {}),
        ...(parsed.includeFrontmatter ? { frontmatter: note.frontmatter } : {}),
        ...(parsed.includeHeadings ? { headings: note.headings } : {}),
        ...(parsed.includeLinks ? { links: note.links } : {}),
        ...(parsed.includeUnresolvedLinks ? { unresolvedLinks } : {}),
        createdAt: note.createdAt,
        modifiedAt: note.modifiedAt,
        untrustedContent: true,
      });
      return parsed.includeBacklinks
        ? { ...document, backlinks: this.#backlinks(snapshot, note) }
        : document;
    });
  }

  async getBacklinks(input: GetBacklinksInput): Promise<Backlink[]> {
    return await this.#safe(async () => {
      this.#permissions().assertScope("notes.read");
      const parsed = this.#input(GetBacklinksInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const snapshot = await this.#snapshot();
      return this.#backlinks(snapshot, this.#findNote(snapshot, parsed.noteId));
    });
  }

  async getOutlinks(input: GetOutlinksInput): Promise<WikiLink[]> {
    return await this.#safe(async () => {
      this.#permissions().assertScope("notes.read");
      const parsed = this.#input(GetOutlinksInputSchema, input);
      this.#assertVault(parsed.vaultId);
      return this.#findNote(await this.#snapshot(), parsed.noteId).links.map(
        (link) => WikiLinkSchema.parse(link),
      );
    });
  }

  async getUnresolvedLinks(input: GetOutlinksInput): Promise<UnresolvedLink[]> {
    return await this.#safe(async () => {
      this.#permissions().assertScope("notes.read");
      const parsed = this.#input(GetOutlinksInputSchema, input);
      this.#assertVault(parsed.vaultId);
      return this.#unresolvedLinks(
        this.#findNote(await this.#snapshot(), parsed.noteId),
      );
    });
  }

  async getGraphNeighborhood(
    input: GraphNeighborhoodInput,
  ): Promise<GraphResult> {
    return await this.#safe(async () => {
      this.#permissions().assertScope("notes.read");
      const parsed = this.#input(GraphNeighborhoodInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const snapshot = await this.#snapshot();
      const start = this.#findNote(snapshot, parsed.noteId);
      const adjacency = new Map<string, Set<string>>();
      for (const note of snapshot.notes)
        adjacency.set(note.identity.noteId, new Set());
      for (const note of snapshot.notes) {
        for (const link of note.links) {
          if (link.resolvedNoteId === undefined) continue;
          adjacency.get(note.identity.noteId)?.add(link.resolvedNoteId);
          adjacency.get(link.resolvedNoteId)?.add(note.identity.noteId);
        }
      }
      const depths = new Map<string, number>([[start.identity.noteId, 0]]);
      const queue = [start.identity.noteId];
      let truncated = false;
      while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined) break;
        const depth = depths.get(current) ?? 0;
        if (depth >= parsed.depth) continue;
        for (const next of adjacency.get(current) ?? []) {
          if (depths.has(next)) continue;
          if (depths.size >= parsed.maxNodes) {
            truncated = true;
            continue;
          }
          depths.set(next, depth + 1);
          queue.push(next);
        }
      }
      const nodes = [...depths]
        .map(([noteId, depth]) => {
          const note = snapshot.byId.get(noteId);
          if (note === undefined)
            throw workbenchError(
              "INTERNAL_ERROR",
              "The graph index is inconsistent.",
              false,
            );
          return {
            noteId,
            path: note.identity.path,
            title: note.identity.title,
            depth,
          };
        })
        .sort(
          (left, right) =>
            left.depth - right.depth || compareText(left.path, right.path),
        );
      const edgeKeys = new Set<string>();
      const edges: GraphResult["edges"] = [];
      for (const note of snapshot.notes) {
        if (!depths.has(note.identity.noteId)) continue;
        for (const link of note.links) {
          if (
            link.resolvedNoteId === undefined ||
            !depths.has(link.resolvedNoteId)
          )
            continue;
          const kind = link.embedded ? "embed" : "link";
          const key = `${note.identity.noteId}\0${link.resolvedNoteId}\0${kind}`;
          if (edgeKeys.has(key)) continue;
          edgeKeys.add(key);
          edges.push({
            sourceNoteId: note.identity.noteId,
            targetNoteId: link.resolvedNoteId,
            kind,
          });
        }
      }
      return GraphResultSchema.parse({ nodes, edges, truncated });
    });
  }

  async listRecentNotes(
    input: RecentNotesInput,
  ): Promise<Paginated<NoteSummary>> {
    return await this.#safe(async () => {
      const parsed = this.#input(RecentNotesInputSchema, input);
      return await this.listNotes({
        vaultId: parsed.vaultId,
        sort: "modified",
        order: "desc",
        limit: parsed.limit,
        ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
        ...(parsed.modifiedAfter === undefined
          ? {}
          : { modifiedAfter: parsed.modifiedAfter }),
      });
    });
  }

  async getDailyNote(input: DailyNoteInput): Promise<ReadNoteDocument> {
    return await this.#safe(async () => {
      this.#permissions().assertScope("notes.read");
      const parsed = this.#input(DailyNoteInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const conventions = VaultConventionsSchema.parse({});
      const filename = this.#formatDate(
        parsed.date,
        conventions.dailyNoteFormat,
      );
      const folder = conventions.dailyNotesFolder.replace(/[\\/]+$/, "");
      const path = this.#permissions().assertPath(
        `${folder ? `${folder}/` : ""}${filename}.md`,
      );
      const file = this.#app.vault.getAbstractFileByPath(path);
      if (!isMarkdownFile(file)) throw this.#noteNotFound();
      return await this.readNote({
        vaultId: parsed.vaultId,
        noteId: this.#noteIds.getOrCreate(file.path),
        includeContent: parsed.includeContent,
        includeFrontmatter: parsed.includeFrontmatter,
        includeHeadings: parsed.includeHeadings,
        includeLinks: parsed.includeLinks,
        includeBacklinks: parsed.includeBacklinks,
        includeUnresolvedLinks: parsed.includeUnresolvedLinks,
      });
    });
  }

  async listTasks(input: ListTasksInput): Promise<Paginated<Task>> {
    return await this.#safe(async () => {
      const permissions = this.#permissions();
      permissions.assertScope("tasks.read");
      const parsed = this.#input(ListTasksInputSchema, input);
      this.#assertVault(parsed.vaultId);
      if (
        !parsed.priority.every((value) =>
          PRIORITIES.includes(value as (typeof PRIORITIES)[number]),
        )
      ) {
        throw validationError("A task priority filter is invalid.");
      }
      const folder =
        parsed.folder === undefined
          ? undefined
          : permissions.assertFolder(parsed.folder);
      const tasks: Task[] = [];
      for (const note of (await this.#snapshot()).notes) {
        if (folder !== undefined && !isAtOrBelow(note.identity.path, folder))
          continue;
        tasks.push(...this.#tasksFor(note));
      }
      const tags = parsed.tags.map(normalizedTag);
      const projectTag =
        parsed.projectTag === undefined
          ? undefined
          : normalizedTag(parsed.projectTag);
      const filtered = tasks.filter((task) => {
        if (parsed.status.length > 0 && !parsed.status.includes(task.status))
          return false;
        if (parsed.noteId !== undefined && parsed.noteId !== task.noteId)
          return false;
        if (
          parsed.dueFrom !== undefined &&
          (task.dueDate ?? "") < parsed.dueFrom
        )
          return false;
        if (
          parsed.dueTo !== undefined &&
          (task.dueDate ?? "9999") > parsed.dueTo
        )
          return false;
        if (
          parsed.scheduledFrom !== undefined &&
          (task.scheduledDate ?? "") < parsed.scheduledFrom
        )
          return false;
        if (
          parsed.scheduledTo !== undefined &&
          (task.scheduledDate ?? "9999") > parsed.scheduledTo
        )
          return false;
        if (
          parsed.priority.length > 0 &&
          !parsed.priority.includes(task.priority)
        )
          return false;
        const taskTags = task.tags.map((tag) => tag.toLocaleLowerCase("en-US"));
        return (
          tags.every((tag) => taskTags.includes(tag)) &&
          (projectTag === undefined || taskTags.includes(projectTag))
        );
      });
      filtered.sort(
        (left, right) =>
          compareText(
            left.dueDate ?? "9999-99-99",
            right.dueDate ?? "9999-99-99",
          ) ||
          compareText(left.path, right.path) ||
          left.line - right.line,
      );
      const fingerprint = hashValue({ ...parsed, cursor: undefined });
      const offset = this.#decodeCursor(
        parsed.cursor,
        "list-tasks",
        fingerprint,
        filtered.length,
      );
      const end = Math.min(offset + parsed.limit, filtered.length);
      const page = paginatedSchema(TaskSchema).parse({
        items: filtered.slice(offset, end),
        ...(end < filtered.length
          ? { nextCursor: this.#encodeCursor("list-tasks", fingerprint, end) }
          : {}),
        total: filtered.length,
      });
      return {
        items: page.items,
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    });
  }

  async createNote(input: CreateNoteInput): Promise<MutationResult> {
    return await this.#safe(async () => {
      const permissions = this.#permissions();
      permissions.assertScope("notes.create");
      const parsed = this.#input(CreateNoteInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const requestHash = mutationRequestHash("createNote", parsed);
      return await this.#executeWrite(
        "createNote",
        parsed,
        requestHash,
        async () => {
          const path = permissions.assertPath(parsed.path);
          this.#assertMarkdownPath(path);
          if (this.#app.vault.getAbstractFileByPath(path) !== null) {
            throw validationError("The destination path already exists.");
          }
          const parent = path.includes("/")
            ? path.slice(0, path.lastIndexOf("/"))
            : "";
          if (
            !parsed.createFolders &&
            parent !== "" &&
            this.#app.vault.getAbstractFileByPath(parent) === null
          ) {
            throw validationError("The destination folder does not exist.");
          }
          const proposed = createNoteContent(
            parsed.content,
            parsed.frontmatter,
          );
          this.#assertSize(proposed);
          const plan = buildMutationPlan({
            vaultId: parsed.vaultId,
            sourcePath: path,
            operation: "create",
            requestHash,
            proposedContent: proposed,
            changedSections: ["document"],
            riskLevel: "low",
            confirmationRequired: false,
            now: this.#now(),
          });
          const previewIdentity = this.#identity(path, proposed);
          if (parsed.dryRun)
            return mutationResult(plan, "preview", previewIdentity);
          if (parsed.createFolders) await this.#createFolders(parent);
          if (this.#app.vault.getAbstractFileByPath(path) !== null) {
            throw validationError("The destination path already exists.");
          }
          const file = await this.#app.vault.create(path, proposed);
          return mutationResult(
            plan,
            "applied",
            this.#identity(file.path, proposed),
          );
        },
      );
    });
  }

  async updateNote(input: UpdateNoteInput): Promise<MutationResult> {
    return await this.#safe(async () => {
      this.#permissions().assertScope("notes.update");
      const parsed = this.#input(UpdateNoteInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const requestHash = mutationRequestHash("updateNote", parsed);
      return await this.#executeWrite(
        "updateNote",
        parsed,
        requestHash,
        async () => {
          const note = this.#findNote(await this.#snapshot(), parsed.noteId);
          const highRisk = parsed.operation.type === "replace_document";
          return await this.#mutateExisting({
            note,
            expectedRevision: parsed.expectedRevision,
            dryRun: parsed.dryRun,
            ...(parsed.confirmationToken === undefined
              ? {}
              : { confirmationToken: parsed.confirmationToken }),
            requestHash,
            operation: parsed.operation.type,
            changedSections:
              parsed.operation.type === "replace_section"
                ? [parsed.operation.heading]
                : ["document"],
            riskLevel: highRisk ? "high" : "medium",
            confirmationRequired: highRisk,
            transform: (content) => applyUpdate(content, parsed.operation),
          });
        },
      );
    });
  }

  async appendToNote(input: AppendToNoteInput): Promise<MutationResult> {
    return await this.#safe(async () => {
      this.#permissions().assertScope("notes.update");
      const parsed = this.#input(AppendToNoteInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const requestHash = mutationRequestHash("appendToNote", parsed);
      return await this.#executeWrite(
        "appendToNote",
        parsed,
        requestHash,
        async () => {
          const note = this.#findNote(await this.#snapshot(), parsed.noteId);
          return await this.#mutateExisting({
            note,
            expectedRevision: parsed.expectedRevision,
            dryRun: parsed.dryRun,
            ...(parsed.confirmationToken === undefined
              ? {}
              : { confirmationToken: parsed.confirmationToken }),
            requestHash,
            operation: "append",
            changedSections: [parsed.heading ?? "document"],
            riskLevel: "low",
            confirmationRequired: false,
            transform: (content) =>
              appendContent(content, parsed.content, parsed.heading),
          });
        },
      );
    });
  }

  async setFrontmatter(input: SetFrontmatterInput): Promise<MutationResult> {
    return await this.#safe(async () => {
      this.#permissions().assertScope("notes.update");
      const parsed = this.#input(SetFrontmatterInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const requestHash = mutationRequestHash("setFrontmatter", parsed);
      return await this.#executeWrite(
        "setFrontmatter",
        parsed,
        requestHash,
        async () => {
          const note = this.#findNote(await this.#snapshot(), parsed.noteId);
          return await this.#mutateExisting({
            note,
            expectedRevision: parsed.expectedRevision,
            dryRun: parsed.dryRun,
            ...(parsed.confirmationToken === undefined
              ? {}
              : { confirmationToken: parsed.confirmationToken }),
            requestHash,
            operation: "set_frontmatter",
            changedSections: ["frontmatter"],
            riskLevel: "low",
            confirmationRequired: false,
            transform: (content) =>
              setFrontmatter(content, parsed.set, parsed.remove),
          });
        },
      );
    });
  }

  async moveNote(input: MoveNoteInput): Promise<MutationResult> {
    return await this.#safe(async () => {
      const permissions = this.#permissions();
      permissions.assertScope("notes.move");
      const parsed = this.#input(MoveNoteInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const requestHash = mutationRequestHash("moveNote", parsed);
      return await this.#executeWrite(
        "moveNote",
        parsed,
        requestHash,
        async () => {
          const note = this.#findNote(await this.#snapshot(), parsed.noteId);
          this.#assertRevision(parsed.expectedRevision, note.content);
          const destination = permissions.assertPath(parsed.destinationPath);
          this.#assertMarkdownPath(destination);
          if (
            note.identity.path.toLocaleLowerCase("en-US") ===
            destination.toLocaleLowerCase("en-US")
          ) {
            throw validationError(
              "The source and destination paths are the same.",
            );
          }
          if (this.#app.vault.getAbstractFileByPath(destination) !== null) {
            throw validationError("The destination path already exists.");
          }
          const plan = buildMutationPlan({
            vaultId: parsed.vaultId,
            targetNoteId: note.identity.noteId,
            sourcePath: note.identity.path,
            targetPath: destination,
            operation: "move",
            requestHash,
            originalContent: note.content,
            proposedContent: note.content,
            changedSections: ["path"],
            riskLevel: "high",
            confirmationRequired: true,
            now: this.#now(),
          });
          const movedIdentity = {
            ...note.identity,
            path: destination,
            title: this.#title(destination),
          };
          if (parsed.dryRun)
            return mutationResult(plan, "preview", movedIdentity);
          this.#requireConfirmation(parsed.confirmationToken);
          const current = normalizeContent(
            await this.#app.vault.read(note.file),
          );
          this.#assertRevision(parsed.expectedRevision, current);
          if (current !== note.content)
            throw this.#revisionConflict(parsed.expectedRevision, current);
          await this.#app.fileManager.renameFile(note.file, destination);
          this.#noteIds.rename(note.identity.path, destination);
          return mutationResult(plan, "applied", movedIdentity);
        },
      );
    });
  }

  async trashNote(input: TrashNoteInput): Promise<MutationResult> {
    return await this.#safe(async () => {
      this.#permissions().assertScope("notes.trash");
      const parsed = this.#input(TrashNoteInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const requestHash = mutationRequestHash("trashNote", parsed);
      return await this.#executeWrite(
        "trashNote",
        parsed,
        requestHash,
        async () => {
          const note = this.#findNote(await this.#snapshot(), parsed.noteId);
          this.#assertRevision(parsed.expectedRevision, note.content);
          const plan = buildMutationPlan({
            vaultId: parsed.vaultId,
            targetNoteId: note.identity.noteId,
            sourcePath: note.identity.path,
            operation: "trash",
            requestHash,
            originalContent: note.content,
            proposedContent: note.content,
            changedSections: ["path"],
            riskLevel: "high",
            confirmationRequired: true,
            now: this.#now(),
          });
          if (parsed.dryRun) return mutationResult(plan, "preview");
          this.#requireConfirmation(parsed.confirmationToken);
          const current = normalizeContent(
            await this.#app.vault.read(note.file),
          );
          this.#assertRevision(parsed.expectedRevision, current);
          if (current !== note.content)
            throw this.#revisionConflict(parsed.expectedRevision, current);
          await this.#app.vault.trash(note.file, true);
          return mutationResult(plan, "applied");
        },
      );
    });
  }

  async createTask(input: CreateTaskInput): Promise<MutationResult> {
    return await this.#safe(async () => {
      this.#permissions().assertScope("tasks.create");
      const parsed = this.#input(CreateTaskInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const requestHash = mutationRequestHash("createTask", parsed);
      return await this.#executeWrite(
        "createTask",
        parsed,
        requestHash,
        async () => {
          const note = this.#findNote(await this.#snapshot(), parsed.noteId);
          const task = `- [ ] ${parsed.text}${parsed.dueDate === undefined ? "" : ` \u{1F4C5} ${parsed.dueDate}`}`;
          return await this.#mutateExisting({
            note,
            expectedRevision: parsed.expectedRevision,
            dryRun: parsed.dryRun,
            ...(parsed.confirmationToken === undefined
              ? {}
              : { confirmationToken: parsed.confirmationToken }),
            requestHash,
            operation: "create_task",
            changedSections: [parsed.heading ?? "tasks"],
            riskLevel: "low",
            confirmationRequired: false,
            transform: (content) =>
              appendContent(content, task, parsed.heading),
          });
        },
      );
    });
  }

  async updateTask(input: UpdateTaskInput): Promise<MutationResult> {
    return await this.#safe(async () => {
      this.#permissions().assertScope("tasks.update");
      const parsed = this.#input(UpdateTaskInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const requestHash = mutationRequestHash("updateTask", parsed);
      return await this.#executeWrite(
        "updateTask",
        parsed,
        requestHash,
        async () => {
          const located = this.#findTask(await this.#snapshot(), parsed.taskId);
          return await this.#mutateExisting({
            note: located.note,
            expectedRevision: parsed.expectedRevision,
            dryRun: parsed.dryRun,
            ...(parsed.confirmationToken === undefined
              ? {}
              : { confirmationToken: parsed.confirmationToken }),
            requestHash,
            operation: "update_task",
            changedSections: ["tasks"],
            riskLevel: "low",
            confirmationRequired: false,
            transform: (content) =>
              updateTaskLine(content, located.task, {
                ...(parsed.status === undefined
                  ? {}
                  : { status: parsed.status }),
                ...(parsed.text === undefined ? {} : { text: parsed.text }),
                ...(parsed.dueDate === undefined
                  ? {}
                  : { dueDate: parsed.dueDate }),
              }),
          });
        },
      );
    });
  }

  async #snapshot(): Promise<VaultSnapshot> {
    const permissions = this.#permissions();
    const files = this.#app.vault
      .getMarkdownFiles()
      .filter((file) => permissions.allowsPath(file.path));
    const notes = await Promise.all(
      files.map(async (file) => await this.#index(file)),
    );
    notes.sort((left, right) =>
      compareText(left.identity.path, right.identity.path),
    );
    return {
      notes,
      byId: new Map(notes.map((note) => [note.identity.noteId, note])),
    };
  }

  async #index(file: TFile): Promise<IndexedNote> {
    const content = normalizeContent(await this.#app.vault.cachedRead(file));
    this.#assertSize(content);
    const cache = this.#app.metadataCache.getFileCache(file);
    let parsedFrontmatter: ReturnType<typeof parseFrontmatter>;
    try {
      parsedFrontmatter = parseFrontmatter(content);
    } catch {
      parsedFrontmatter = { values: {}, endLine: 0 };
    }
    const headings = this.#headings(cache, content, parsedFrontmatter.endLine);
    const links = this.#links(file, cache, content);
    const tags = this.#tags(cache, parsedFrontmatter.values, content);
    return {
      file,
      content,
      identity: this.#identity(file.path, content),
      frontmatter: parsedFrontmatter.values,
      headings,
      links,
      tags,
      tasks: parseTasks(content, parsedFrontmatter.endLine),
      createdAt: safeDate(file.stat.ctime),
      modifiedAt: safeDate(file.stat.mtime),
    };
  }

  #headings(
    cache: CachedMetadata | null,
    content: string,
    startLine: number,
  ): Heading[] {
    if (cache?.headings === undefined) return parseHeadings(content, startLine);
    const anchors = new Map<string, number>();
    return cache.headings.map((heading) => {
      const base =
        heading.heading
          .toLocaleLowerCase("en-US")
          .replace(/[^a-z0-9\s-]/g, "")
          .trim()
          .replace(/\s+/g, "-") || "heading";
      const count = anchors.get(base) ?? 0;
      anchors.set(base, count + 1);
      return {
        text: heading.heading,
        level: heading.level,
        line: heading.position.start.line + 1,
        anchor: count === 0 ? base : `${base}-${count}`,
      };
    });
  }

  #links(
    file: TFile,
    cache: CachedMetadata | null,
    content: string,
  ): WikiLink[] {
    const cached = [
      ...(cache?.links ?? []).map((link) => ({ link, embedded: false })),
      ...(cache?.embeds ?? []).map((link) => ({ link, embedded: true })),
    ];
    if (cached.length === 0) {
      return parseWikiLinks(content, file.path).map((link) =>
        this.#resolveLink(file, link),
      );
    }
    return cached.map(({ link, embedded }) => {
      const [target = "", fragment] = link.link.split("#", 2);
      const resolved = this.#app.metadataCache.getFirstLinkpathDest(
        target || file.path,
        file.path,
      );
      const allowed =
        isMarkdownFile(resolved) &&
        this.#permissions().allowsPath(resolved.path);
      return WikiLinkSchema.parse({
        raw: link.original,
        target: target || file.path.replace(/\.md$/i, ""),
        ...(link.displayText ? { alias: link.displayText } : {}),
        ...(fragment?.startsWith("^")
          ? { blockId: fragment.slice(1) }
          : fragment
            ? { heading: fragment }
            : {}),
        embedded,
        line: link.position.start.line + 1,
        ...(allowed && resolved !== null
          ? { resolvedNoteId: this.#noteIds.getOrCreate(resolved.path) }
          : {}),
      });
    });
  }

  #resolveLink(file: TFile, link: WikiLink): WikiLink {
    const resolved = this.#app.metadataCache.getFirstLinkpathDest(
      link.target,
      file.path,
    );
    return isMarkdownFile(resolved) &&
      this.#permissions().allowsPath(resolved.path)
      ? { ...link, resolvedNoteId: this.#noteIds.getOrCreate(resolved.path) }
      : link;
  }

  #tags(
    cache: CachedMetadata | null,
    frontmatter: Record<string, FrontmatterValue>,
    content: string,
  ): string[] {
    const tags = (cache?.tags ?? []).map((tag) => tag.tag);
    const frontmatterTags = frontmatter.tags ?? frontmatter.tag;
    for (const value of Array.isArray(frontmatterTags)
      ? frontmatterTags
      : [frontmatterTags]) {
      if (typeof value === "string") {
        for (const tag of value.split(/[\s,]+/))
          if (tag) tags.push(tag.startsWith("#") ? tag : `#${tag}`);
      }
    }
    if (cache?.tags === undefined) {
      for (const match of content.matchAll(
        /(^|\s)#([\p{Letter}\p{Number}_/-]+)/gu,
      )) {
        if (match[2]) tags.push(`#${match[2]}`);
      }
    }
    return [...new Set(tags)].sort();
  }

  #tasksFor(note: IndexedNote): Task[] {
    const occurrences = new Map<string, number>();
    return note.tasks.map((task) => {
      const fingerprint = createRevision(
        task.text.replace(/\s+\^[a-zA-Z0-9][a-zA-Z0-9_-]*\s*$/, "").trim(),
      );
      const occurrence = occurrences.get(fingerprint) ?? 0;
      occurrences.set(fingerprint, occurrence + 1);
      const taskId = `task_${hashValue(
        task.blockId === undefined
          ? [note.identity.noteId, fingerprint, occurrence]
          : [note.identity.noteId, "block", task.blockId],
      )}`;
      return TaskSchema.parse({
        taskId,
        noteId: note.identity.noteId,
        vaultId: this.#settings().vaultId,
        path: note.identity.path,
        line: task.line,
        text: task.text,
        status: task.status,
        ...(task.blockId === undefined ? {} : { blockId: task.blockId }),
        fingerprint,
        ...(task.dueDate !== undefined &&
        LocalDateSchema.safeParse(task.dueDate).success
          ? { dueDate: task.dueDate }
          : {}),
        ...(task.scheduledDate !== undefined &&
        LocalDateSchema.safeParse(task.scheduledDate).success
          ? { scheduledDate: task.scheduledDate }
          : {}),
        priority: task.priority,
        tags: task.tags,
      });
    });
  }

  async #mutateExisting(options: ExistingMutation): Promise<MutationResult> {
    this.#assertRevision(options.expectedRevision, options.note.content);
    const proposed = normalizeContent(options.transform(options.note.content));
    this.#assertSize(proposed);
    const plan = buildMutationPlan({
      vaultId: this.#settings().vaultId,
      targetNoteId: options.note.identity.noteId,
      sourcePath: options.note.identity.path,
      operation: options.operation,
      requestHash: options.requestHash,
      originalContent: options.note.content,
      proposedContent: proposed,
      changedSections: options.changedSections,
      riskLevel: options.riskLevel,
      confirmationRequired: options.confirmationRequired,
      now: this.#now(),
    });
    const identity = this.#identity(options.note.identity.path, proposed);
    if (options.dryRun) return mutationResult(plan, "preview", identity);
    if (options.confirmationRequired)
      this.#requireConfirmation(options.confirmationToken);
    if (proposed === options.note.content)
      return mutationResult(plan, "unchanged", identity);
    await this.#app.vault.process(options.note.file, (currentValue) => {
      const current = normalizeContent(currentValue);
      this.#assertRevision(options.expectedRevision, current);
      if (current !== options.note.content) {
        throw this.#revisionConflict(options.expectedRevision, current);
      }
      return proposed;
    });
    return mutationResult(plan, "applied", identity);
  }

  async #executeWrite(
    tool: string,
    safety: { dryRun: boolean; idempotencyKey: string },
    requestHash: string,
    operation: () => Promise<MutationResult>,
  ): Promise<MutationResult> {
    if (safety.dryRun) return await operation();
    const key = `${tool}\0${safety.idempotencyKey}`;
    const existing = this.#idempotency.get(key);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        throw workbenchError(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key was already used for a different request.",
        );
      }
      return { ...(await existing.result), idempotentReplay: true };
    }
    const stored = { requestHash, result: Promise.resolve().then(operation) };
    this.#idempotency.set(key, stored);
    try {
      const result = await stored.result;
      while (this.#idempotency.size > 1000) {
        const oldest = this.#idempotency.keys().next().value as
          string | undefined;
        if (oldest === undefined) break;
        this.#idempotency.delete(oldest);
      }
      return MutationResultSchema.parse(result);
    } catch (error) {
      if (this.#idempotency.get(key) === stored) this.#idempotency.delete(key);
      throw error;
    }
  }

  #notePage(
    notes: IndexedNote[],
    limit: number,
    cursor: PaginationCursor | undefined,
    operation: string,
    fingerprintInput: unknown,
  ): Paginated<NoteSummary> {
    const fingerprint = hashValue(fingerprintInput);
    const offset = this.#decodeCursor(
      cursor,
      operation,
      fingerprint,
      notes.length,
    );
    const end = Math.min(offset + limit, notes.length);
    const page = paginatedSchema(NoteSummarySchema).parse({
      items: notes.slice(offset, end).map((note) =>
        NoteSummarySchema.parse({
          ...note.identity,
          createdAt: note.createdAt,
          modifiedAt: note.modifiedAt,
          tags: note.tags,
        }),
      ),
      ...(end < notes.length
        ? { nextCursor: this.#encodeCursor(operation, fingerprint, end) }
        : {}),
      total: notes.length,
    });
    return {
      items: page.items,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      ...(page.total === undefined ? {} : { total: page.total }),
    };
  }

  #encodeCursor(
    operation: string,
    fingerprint: string,
    offset: number,
  ): PaginationCursor {
    return PaginationCursorSchema.parse(
      btoa(JSON.stringify({ operation, fingerprint, offset })),
    );
  }

  #decodeCursor(
    cursor: PaginationCursor | undefined,
    operation: string,
    fingerprint: string,
    length: number,
  ): number {
    if (cursor === undefined) return 0;
    try {
      const value = JSON.parse(atob(cursor)) as Record<string, unknown>;
      if (
        value.operation !== operation ||
        value.fingerprint !== fingerprint ||
        typeof value.offset !== "number" ||
        !Number.isSafeInteger(value.offset) ||
        value.offset < 0 ||
        value.offset > length
      )
        throw new Error("invalid cursor");
      return value.offset;
    } catch {
      throw validationError(
        "The pagination cursor is invalid for this request.",
      );
    }
  }

  #backlinks(snapshot: VaultSnapshot, target: IndexedNote): Backlink[] {
    const backlinks: Backlink[] = [];
    for (const source of snapshot.notes) {
      const lines = source.content.split("\n");
      for (const link of source.links) {
        if (link.resolvedNoteId !== target.identity.noteId) continue;
        backlinks.push(
          BacklinkSchema.parse({
            sourceNoteId: source.identity.noteId,
            sourcePath: source.identity.path,
            targetNoteId: target.identity.noteId,
            line: link.line,
            context: (lines[link.line - 1] ?? "").slice(0, 1000),
          }),
        );
      }
    }
    return backlinks.sort(
      (left, right) =>
        compareText(left.sourcePath, right.sourcePath) ||
        left.line - right.line,
    );
  }

  #unresolvedLinks(note: IndexedNote): UnresolvedLink[] {
    return note.links
      .filter((link) => link.resolvedNoteId === undefined)
      .map((link) =>
        UnresolvedLinkSchema.parse({
          raw: link.raw,
          target: link.target,
          ...(link.alias === undefined ? {} : { alias: link.alias }),
          ...(link.heading === undefined ? {} : { heading: link.heading }),
          ...(link.blockId === undefined ? {} : { blockId: link.blockId }),
          embedded: link.embedded,
          line: link.line,
          sourceNoteId: note.identity.noteId,
        }),
      );
  }

  #findNote(snapshot: VaultSnapshot, noteId: string): IndexedNote {
    const note = snapshot.byId.get(noteId);
    if (note === undefined) throw this.#noteNotFound();
    this.#permissions().assertPath(note.identity.path);
    return note;
  }

  #findTask(
    snapshot: VaultSnapshot,
    taskId: string,
  ): { note: IndexedNote; task: ParsedTask } {
    for (const note of snapshot.notes) {
      const tasks = this.#tasksFor(note);
      const index = tasks.findIndex((task) => task.taskId === taskId);
      if (index >= 0 && note.tasks[index] !== undefined)
        return { note, task: note.tasks[index] };
    }
    throw workbenchError(
      "NOTE_NOT_FOUND",
      "The requested task could not be found.",
    );
  }

  #identity(path: string, content: string): NoteIdentity {
    return {
      noteId: this.#noteIds.getOrCreate(path),
      vaultId: this.#settings().vaultId,
      path,
      title: this.#title(path),
      revision: createRevision(content),
    };
  }

  #title(path: string): string {
    const filename = path.slice(path.lastIndexOf("/") + 1);
    return filename.replace(/\.md$/i, "");
  }

  #snippet(
    content: string,
    needle: string,
  ): { text: string; lineStart: number; lineEnd: number } {
    const lines = content.split("\n");
    const index = Math.max(
      0,
      lines.findIndex((line) =>
        line.toLocaleLowerCase("en-US").includes(needle),
      ),
    );
    const start = Math.max(0, index - 1);
    const end = Math.min(lines.length, index + 2);
    return {
      text: lines.slice(start, end).join("\n").slice(0, MAX_SNIPPET),
      lineStart: start + 1,
      lineEnd: Math.max(start + 1, end),
    };
  }

  #permissions(): VaultPermissions {
    const settings = this.#settings();
    return new VaultPermissions({
      allowedRoots: settings.allowedRoots,
      excludedRoots: settings.excludedRoots,
      scopes: settings.enabledScopes,
    });
  }

  #assertVault(vaultId: string): void {
    if (vaultId !== this.#settings().vaultId) {
      throw workbenchError(
        "VAULT_NOT_FOUND",
        "The requested vault could not be found.",
      );
    }
  }

  #assertRevision(expected: string, content: string): void {
    const current = createRevision(content);
    if (current !== expected) throw this.#revisionConflict(expected, content);
  }

  #revisionConflict(expected: string, content: string): WorkbenchError {
    return workbenchError(
      "REVISION_CONFLICT",
      "The note changed after it was read; no update was applied.",
      true,
      { expectedRevision: expected, currentRevision: createRevision(content) },
    );
  }

  #requireConfirmation(token: string | undefined): void {
    if (token === undefined || token.trim() === "") {
      throw workbenchError(
        "CONFIRMATION_REQUIRED",
        "This high-risk mutation requires upstream confirmation.",
      );
    }
  }

  #assertMarkdownPath(path: string): void {
    if (!path.toLocaleLowerCase("en-US").endsWith(".md")) {
      throw validationError("Note paths must use the .md extension.");
    }
  }

  #assertSize(content: string): void {
    if (new TextEncoder().encode(content).length > this.#maxNoteBytes) {
      throw validationError("The note exceeds the configured maximum size.");
    }
  }

  async #createFolders(path: string): Promise<void> {
    if (path === "") return;
    let current = "";
    for (const segment of path.split("/")) {
      current = current === "" ? segment : `${current}/${segment}`;
      if (this.#app.vault.getAbstractFileByPath(current) === null) {
        await this.#app.vault.createFolder(current);
      }
    }
  }

  #formatDate(date: string, format: string): string {
    const [year = "", month = "", day = ""] = date.split("-");
    return format
      .replaceAll("YYYY", year)
      .replaceAll("MM", month)
      .replaceAll("DD", day);
  }

  #input<T>(schema: RuntimeSchema<T>, value: unknown): T {
    try {
      return schema.parse(value);
    } catch {
      throw validationError();
    }
  }

  #noteNotFound(): WorkbenchError {
    return workbenchError(
      "NOTE_NOT_FOUND",
      "The requested note could not be found.",
    );
  }

  async #safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw sanitizeError(error);
    }
  }
}
