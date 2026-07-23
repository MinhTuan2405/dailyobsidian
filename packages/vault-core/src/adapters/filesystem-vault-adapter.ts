import {
  link,
  mkdir,
  open,
  readdir,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import {
  BacklinkSchema,
  AppendToNoteInputSchema,
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
  PermissionScopeSchema,
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
  WorkbenchError,
  paginatedSchema,
  type Backlink,
  type AppendToNoteInput,
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
  type MutationPlan,
  type MutationResult,
  type NoteIdentity,
  type NoteSummary,
  type Paginated,
  type PermissionScope,
  type ReadNoteInput,
  type RecentNotesInput,
  type SearchHit,
  type SearchNotesInput,
  type SetFrontmatterInput,
  type Task,
  type TrashNoteInput,
  type UnresolvedLink,
  type UpdateNoteInput,
  type UpdateTaskInput,
  type VaultConventions,
  type VaultInfo,
  type WikiLink,
} from "@obsidian-workbench/shared";

import { parseMarkdown, type ParsedTaskLine } from "../markdown/parser.js";
import {
  ConfirmationService,
  type ConfirmationServiceOptions,
} from "../mutations/confirmation-service.js";
import { InMemoryIdempotencyStore } from "../mutations/idempotency-store.js";
import {
  appendContent,
  applyExplicitUpdate,
  buildMutationPlan,
  createNoteContent,
  mutationRequestHash,
  setFrontmatterContent,
  updateTaskContent,
} from "../mutations/mutation-planner.js";
import { CursorCodec, requestFingerprint } from "../pagination/cursor.js";
import {
  createRevision,
  createStableId,
  normalizeNoteContent,
} from "../revisions/revisions.js";
import { PathSecurity } from "../security/path-security.js";
import type { VaultAdapter } from "./vault-adapter.js";
import type {
  ReadNoteDocument,
  UntrustedSearchResult,
} from "./vault-read-adapter.js";

export interface FilesystemVaultAdapterOptions {
  vaultId: string;
  rootPath: string;
  name?: string;
  allowedRoots?: readonly string[];
  excludedRoots?: readonly string[];
  conventions?: Partial<VaultConventions>;
  maxFileBytes?: number;
  paginationSecret?: string | Uint8Array;
  scopes?: readonly PermissionScope[];
  localUserId?: string;
  confirmationService?: ConfirmationService;
  confirmation?: ConfirmationServiceOptions;
  idempotencyStore?: InMemoryIdempotencyStore;
  now?: () => number;
}

interface IndexedNote {
  identity: NoteIdentity;
  content: string;
  frontmatter: Record<string, FrontmatterValue>;
  frontmatterEndLine: number;
  headings: Heading[];
  links: WikiLink[];
  tags: string[];
  tasks: ParsedTaskLine[];
  createdAt: string;
  modifiedAt: string;
}

interface VaultSnapshot {
  notes: IndexedNote[];
  byId: Map<string, IndexedNote>;
}

interface HandleContent {
  bytes: Buffer;
  content: string;
}

interface ExistingMutationOptions {
  note: IndexedNote;
  expectedRevision: string;
  dryRun: boolean;
  confirmationToken: string | undefined;
  requestHash: string;
  operation: string;
  changedSections: string[];
  riskLevel: "low" | "medium" | "high";
  confirmationRequired: boolean;
  transform(content: string): string;
}

interface RelocateNoteOptions {
  note: IndexedNote;
  expectedRevision: string;
  destinationPath: string;
  dryRun: boolean;
  confirmationToken: string | undefined;
  requestHash: string;
  operation: "move" | "trash";
  createDestinationFolder: boolean;
  trash: boolean;
}

interface RuntimeSchema<T> {
  parse(value: unknown): T;
}

const PRIORITIES = [
  "lowest",
  "low",
  "normal",
  "medium",
  "high",
  "highest",
] as const;
const MAX_DEFAULT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SNIPPET_LENGTH = 600;
const DEFAULT_FILESYSTEM_SCOPES: readonly PermissionScope[] = [
  "vault.metadata.read",
  "notes.read",
  "tasks.read",
];

function validationError(message = "The request is invalid."): WorkbenchError {
  return new WorkbenchError({
    code: "VALIDATION_ERROR",
    message,
    recoverable: true,
  });
}

function internalError(): WorkbenchError {
  return new WorkbenchError({
    code: "INTERNAL_ERROR",
    message: "The vault operation could not be completed.",
    recoverable: false,
  });
}

function noteNotFound(): WorkbenchError {
  return new WorkbenchError({
    code: "NOTE_NOT_FOUND",
    message: "The requested note could not be found.",
    recoverable: true,
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeTag(value: string): string {
  return `#${value.replace(/^#/, "").toLocaleLowerCase("en-US")}`;
}

function folderContains(notePath: string, folder: string): boolean {
  if (folder === "") {
    return true;
  }
  const note =
    process.platform === "win32"
      ? notePath.toLocaleLowerCase("en-US")
      : notePath;
  const root =
    process.platform === "win32" ? folder.toLocaleLowerCase("en-US") : folder;
  return note === root || note.startsWith(`${root}/`);
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (count < 10) {
    const found = value.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + Math.max(needle.length, 1);
  }
  return count;
}

function valueEquals(
  left: FrontmatterValue | undefined,
  right: FrontmatterValue,
): boolean {
  return (
    left !== undefined && requestFingerprint(left) === requestFingerprint(right)
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function toSafeFilesystemError(error: unknown): WorkbenchError {
  if (error instanceof WorkbenchError) {
    return error;
  }
  if (
    isNodeError(error) &&
    (error.code === "EACCES" || error.code === "EPERM")
  ) {
    return new WorkbenchError({
      code: "PERMISSION_DENIED",
      message:
        "The vault path cannot be accessed with the current permissions.",
      recoverable: true,
    });
  }
  if (isNodeError(error) && error.code === "ENOENT") {
    return noteNotFound();
  }
  if (isNodeError(error) && error.code === "EEXIST") {
    return validationError("The destination path already exists.");
  }
  return internalError();
}

export class FilesystemVaultAdapter implements VaultAdapter {
  readonly #vaultId: string;
  readonly #rootPath: string;
  readonly #name: string;
  readonly #conventions: VaultConventions;
  readonly #maxFileBytes: number;
  readonly #cursorCodec: CursorCodec;
  readonly #scopes: readonly PermissionScope[];
  readonly #scopeSet: ReadonlySet<PermissionScope>;
  readonly #localUserId: string;
  readonly #idempotencyStore: InMemoryIdempotencyStore;
  readonly #now: () => number;
  readonly confirmations: ConfirmationService;
  readonly #policyOptions: {
    allowedRoots?: readonly string[];
    excludedRoots?: readonly string[];
  };
  #policyPromise: Promise<PathSecurity> | undefined;

  constructor(options: FilesystemVaultAdapterOptions) {
    if (options.vaultId.trim().length === 0 || options.vaultId.length > 256) {
      throw validationError("The configured vault ID is invalid.");
    }
    if (
      options.maxFileBytes !== undefined &&
      (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 1)
    ) {
      throw validationError("The maximum note size is invalid.");
    }

    this.#vaultId = options.vaultId;
    this.#rootPath = options.rootPath;
    this.#name = options.name ?? path.basename(options.rootPath);
    this.#maxFileBytes = options.maxFileBytes ?? MAX_DEFAULT_FILE_BYTES;
    this.#cursorCodec = new CursorCodec(options.paginationSecret);
    this.#now = options.now ?? Date.now;
    this.#localUserId = options.localUserId ?? "local";
    if (
      this.#localUserId.trim().length === 0 ||
      this.#localUserId.length > 256
    ) {
      throw validationError("The configured local user ID is invalid.");
    }
    try {
      this.#scopes = [
        ...new Set(
          PermissionScopeSchema.array().parse(
            options.scopes ?? DEFAULT_FILESYSTEM_SCOPES,
          ),
        ),
      ];
    } catch {
      throw validationError("The configured permission scopes are invalid.");
    }
    this.#scopeSet = new Set(this.#scopes);
    this.#idempotencyStore =
      options.idempotencyStore ?? new InMemoryIdempotencyStore();
    if (
      options.confirmationService !== undefined &&
      options.confirmation !== undefined
    ) {
      throw validationError("Configure only one confirmation service.");
    }
    this.confirmations =
      options.confirmationService ??
      new ConfirmationService({
        ...options.confirmation,
        now: options.confirmation?.now ?? this.#now,
      });
    this.#policyOptions = {
      ...(options.allowedRoots !== undefined
        ? { allowedRoots: options.allowedRoots }
        : {}),
      ...(options.excludedRoots !== undefined
        ? { excludedRoots: options.excludedRoots }
        : {}),
    };
    try {
      this.#conventions = VaultConventionsSchema.parse(
        options.conventions ?? {},
      );
    } catch {
      throw validationError("The configured vault conventions are invalid.");
    }
  }

  async getVaultInfo(): Promise<VaultInfo> {
    return this.#safe(async () => {
      this.#assertScope("vault.metadata.read");
      const policy = await this.#policy();
      const excludedRoots = [...policy.excludedRoots].map(
        (root) => root || ".",
      );
      if (policy.blockObsidian && !excludedRoots.includes(".obsidian")) {
        excludedRoots.push(".obsidian");
      }
      return this.#output(VaultInfoSchema, {
        vaultId: this.#vaultId,
        name: this.#name,
        status: { state: "online", mode: "filesystem" },
        capabilities: {
          scopes: this.#scopes,
          supportsTrash: this.#scopeSet.has("notes.trash"),
          supportsFileManagerMoves: false,
          supportsEvents: false,
          supportsOpenInObsidian: false,
        },
        allowedRoots: policy.allowedRoots.map((root) => root || "."),
        excludedRoots,
        conventions: this.#conventions,
      });
    });
  }

  async listNotes(input: ListNotesInput): Promise<Paginated<NoteSummary>> {
    return this.#safe(async () => {
      this.#assertScope("notes.read");
      const parsed = this.#input(ListNotesInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const policy = await this.#policy();
      const folder =
        parsed.folder === undefined
          ? undefined
          : policy.assertAuthorizedFolder(parsed.folder);
      const snapshot = await this.#snapshot();
      const requestedTags = parsed.tags.map(normalizeTag);
      const filtered = snapshot.notes.filter((note) => {
        if (
          folder !== undefined &&
          !folderContains(note.identity.path, folder)
        ) {
          return false;
        }
        const tags = note.tags.map((tag) => tag.toLocaleLowerCase("en-US"));
        if (!requestedTags.every((tag) => tags.includes(tag))) return false;
        const created = Date.parse(note.createdAt);
        const modified = Date.parse(note.modifiedAt);
        if (
          parsed.createdAfter !== undefined &&
          created <= Date.parse(parsed.createdAfter)
        ) {
          return false;
        }
        if (
          parsed.createdBefore !== undefined &&
          created >= Date.parse(parsed.createdBefore)
        ) {
          return false;
        }
        if (
          parsed.modifiedAfter !== undefined &&
          modified <= Date.parse(parsed.modifiedAfter)
        ) {
          return false;
        }
        if (
          parsed.modifiedBefore !== undefined &&
          modified >= Date.parse(parsed.modifiedBefore)
        ) {
          return false;
        }
        return true;
      });

      const direction = parsed.order === "asc" ? 1 : -1;
      filtered.sort((left, right) => {
        let result: number;
        if (parsed.sort === "title") {
          result = compareText(
            left.identity.title.toLocaleLowerCase("en-US"),
            right.identity.title.toLocaleLowerCase("en-US"),
          );
        } else if (parsed.sort === "created") {
          result = compareText(left.createdAt, right.createdAt);
        } else {
          result = compareText(left.modifiedAt, right.modifiedAt);
        }
        return result === 0
          ? compareText(left.identity.path, right.identity.path)
          : result * direction;
      });

      const fingerprint = requestFingerprint({
        ...parsed,
        cursor: undefined,
      });
      const offset = this.#cursorCodec.decode(
        parsed.cursor,
        "list-notes",
        fingerprint,
      );
      this.#assertOffset(offset, filtered.length);
      const end = Math.min(offset + parsed.limit, filtered.length);
      const items = filtered.slice(offset, end).map((note) =>
        NoteSummarySchema.parse({
          ...note.identity,
          createdAt: note.createdAt,
          modifiedAt: note.modifiedAt,
          tags: note.tags,
        }),
      );
      const page = this.#output(paginatedSchema(NoteSummarySchema), {
        items,
        ...(end < filtered.length
          ? {
              nextCursor: this.#cursorCodec.encode(
                "list-notes",
                fingerprint,
                end,
              ),
            }
          : {}),
        total: filtered.length,
      });
      return {
        items: page.items,
        ...(page.nextCursor !== undefined
          ? { nextCursor: page.nextCursor }
          : {}),
        ...(page.total !== undefined ? { total: page.total } : {}),
      };
    });
  }

  async searchNotes(input: SearchNotesInput): Promise<UntrustedSearchResult> {
    return this.#safe(async () => {
      this.#assertScope("notes.read");
      const parsed = this.#input(SearchNotesInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const policy = await this.#policy();
      const folders = parsed.search.folders.map((folder) =>
        policy.assertAuthorizedFolder(folder),
      );
      const excludedFolders = parsed.search.excludedFolders.map((folder) =>
        policy.assertAuthorizedFolder(folder),
      );
      const requestedTags = parsed.search.tags.map(normalizeTag);
      const needle = parsed.search.query.toLocaleLowerCase("en-US");
      const snapshot = await this.#snapshot();
      const hits: SearchHit[] = [];

      for (const note of snapshot.notes) {
        if (
          folders.length > 0 &&
          !folders.some((folder) => folderContains(note.identity.path, folder))
        ) {
          continue;
        }
        if (
          excludedFolders.some((folder) =>
            folderContains(note.identity.path, folder),
          )
        ) {
          continue;
        }
        const normalizedTags = note.tags.map((tag) =>
          tag.toLocaleLowerCase("en-US"),
        );
        if (!requestedTags.every((tag) => normalizedTags.includes(tag))) {
          continue;
        }
        if (
          !Object.entries(parsed.search.frontmatter).every(([key, value]) =>
            valueEquals(note.frontmatter[key], value),
          )
        ) {
          continue;
        }

        const matchedFields = new Set<string>();
        let score = 0;
        const title = note.identity.title.toLocaleLowerCase("en-US");
        const headings = note.headings
          .map((heading) => heading.text)
          .join("\n")
          .toLocaleLowerCase("en-US");
        const content = note.content.toLocaleLowerCase("en-US");
        const metadata = JSON.stringify({
          path: note.identity.path,
          tags: note.tags,
          frontmatter: note.frontmatter,
        }).toLocaleLowerCase("en-US");

        if (parsed.search.mode !== "metadata") {
          if (title.includes(needle)) {
            score += 100;
            matchedFields.add("title");
          }
          const headingMatches = countOccurrences(headings, needle);
          if (headingMatches > 0) {
            score += headingMatches * 30;
            matchedFields.add("headings");
          }
          const contentMatches = countOccurrences(content, needle);
          if (contentMatches > 0) {
            score += contentMatches;
            matchedFields.add("content");
          }
        }
        if (parsed.search.mode !== "text" && metadata.includes(needle)) {
          score += normalizedTags.some((tag) => tag.includes(needle)) ? 25 : 10;
          matchedFields.add("metadata");
        }
        if (score === 0) continue;

        const snippet = this.#snippet(note, needle);
        hits.push({
          note: note.identity,
          score,
          snippet: snippet.text,
          lineStart: snippet.lineStart,
          lineEnd: snippet.lineEnd,
          matchedFields: [...matchedFields].sort(compareText),
        });
      }

      hits.sort(
        (left, right) =>
          right.score - left.score ||
          compareText(left.note.path, right.note.path),
      );
      const fingerprint = requestFingerprint({
        ...parsed,
        search: { ...parsed.search, cursor: undefined },
      });
      const offset = this.#cursorCodec.decode(
        parsed.search.cursor,
        "search-notes",
        fingerprint,
      );
      this.#assertOffset(offset, hits.length);
      const end = Math.min(offset + parsed.search.limit, hits.length);
      const result = this.#output(SearchResultSchema, {
        hits: hits.slice(offset, end),
        ...(end < hits.length
          ? {
              nextCursor: this.#cursorCodec.encode(
                "search-notes",
                fingerprint,
                end,
              ),
            }
          : {}),
        total: hits.length,
      });
      return { ...result, untrustedContent: true };
    });
  }

  async readNote(input: ReadNoteInput): Promise<ReadNoteDocument> {
    return this.#safe(async () => {
      this.#assertScope("notes.read");
      const parsed = this.#input(ReadNoteInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const snapshot = await this.#snapshot();
      const note = this.#findNote(snapshot, parsed.noteId);
      const unresolvedLinks = this.#unresolvedLinks(note);
      const document = this.#output(NoteDocumentSchema, {
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
      if (!parsed.includeBacklinks) {
        return document;
      }
      return {
        ...document,
        backlinks: this.#backlinks(snapshot, note),
      };
    });
  }

  async getBacklinks(input: GetBacklinksInput): Promise<Backlink[]> {
    return this.#safe(async () => {
      this.#assertScope("notes.read");
      const parsed = this.#input(GetBacklinksInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const snapshot = await this.#snapshot();
      return this.#backlinks(snapshot, this.#findNote(snapshot, parsed.noteId));
    });
  }

  async getOutlinks(input: GetOutlinksInput): Promise<WikiLink[]> {
    return this.#safe(async () => {
      this.#assertScope("notes.read");
      const parsed = this.#input(GetOutlinksInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const note = this.#findNote(await this.#snapshot(), parsed.noteId);
      return note.links.map((link) => this.#output(WikiLinkSchema, link));
    });
  }

  async getUnresolvedLinks(input: GetOutlinksInput): Promise<UnresolvedLink[]> {
    return this.#safe(async () => {
      this.#assertScope("notes.read");
      const parsed = this.#input(GetOutlinksInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const note = this.#findNote(await this.#snapshot(), parsed.noteId);
      return this.#unresolvedLinks(note);
    });
  }

  async getGraphNeighborhood(
    input: GraphNeighborhoodInput,
  ): Promise<GraphResult> {
    return this.#safe(async () => {
      this.#assertScope("notes.read");
      const parsed = this.#input(GraphNeighborhoodInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const snapshot = await this.#snapshot();
      const start = this.#findNote(snapshot, parsed.noteId);
      const adjacency = new Map<string, Set<string>>();
      for (const note of snapshot.notes) {
        adjacency.set(note.identity.noteId, new Set());
      }
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
        const currentId = queue.shift();
        if (currentId === undefined) break;
        const currentDepth = depths.get(currentId) ?? 0;
        if (currentDepth >= parsed.depth) continue;
        const neighbors = [...(adjacency.get(currentId) ?? [])].sort(
          (left, right) =>
            compareText(
              snapshot.byId.get(left)?.identity.path ?? left,
              snapshot.byId.get(right)?.identity.path ?? right,
            ),
        );
        for (const neighbor of neighbors) {
          if (depths.has(neighbor)) continue;
          if (depths.size >= parsed.maxNodes) {
            truncated = true;
            continue;
          }
          depths.set(neighbor, currentDepth + 1);
          queue.push(neighbor);
        }
      }

      const nodes = [...depths.entries()]
        .map(([noteId, depth]) => {
          const note = snapshot.byId.get(noteId);
          if (note === undefined) throw internalError();
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
          ) {
            continue;
          }
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
      edges.sort((left, right) =>
        compareText(
          `${left.sourceNoteId}\0${left.targetNoteId}\0${left.kind}`,
          `${right.sourceNoteId}\0${right.targetNoteId}\0${right.kind}`,
        ),
      );
      return this.#output(GraphResultSchema, { nodes, edges, truncated });
    });
  }

  async listRecentNotes(
    input: RecentNotesInput,
  ): Promise<Paginated<NoteSummary>> {
    return this.#safe(async () => {
      this.#assertScope("notes.read");
      const parsed = this.#input(RecentNotesInputSchema, input);
      return await this.listNotes({
        vaultId: parsed.vaultId,
        tags: [],
        sort: "modified",
        order: "desc",
        limit: parsed.limit,
        ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
        ...(parsed.modifiedAfter !== undefined
          ? { modifiedAfter: parsed.modifiedAfter }
          : {}),
      });
    });
  }

  async getDailyNote(input: DailyNoteInput): Promise<ReadNoteDocument> {
    return this.#safe(async () => {
      this.#assertScope("notes.read");
      const parsed = this.#input(DailyNoteInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const date = parsed.date;
      const filename = this.#formatDailyDate(
        date,
        this.#conventions.dailyNoteFormat,
      );
      const folder = this.#conventions.dailyNotesFolder.replace(/[\\/]+$/, "");
      const expectedPath =
        folder === "" || folder === "."
          ? `${filename}.md`
          : `${folder}/${filename}.md`;
      const policy = await this.#policy();
      const authorizedPath = policy.assertAuthorizedRelativePath(expectedPath);
      const snapshot = await this.#snapshot();
      const note = snapshot.notes.find((candidate) =>
        policy.pathsEqual(candidate.identity.path, authorizedPath),
      );
      if (note === undefined) throw noteNotFound();
      return await this.readNote({
        vaultId: parsed.vaultId,
        noteId: note.identity.noteId,
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
    return this.#safe(async () => {
      this.#assertScope("tasks.read");
      const parsed = this.#input(ListTasksInputSchema, input);
      this.#assertVault(parsed.vaultId);
      if (
        !parsed.priority.every((priority) =>
          PRIORITIES.includes(priority as (typeof PRIORITIES)[number]),
        )
      ) {
        throw validationError("A task priority filter is invalid.");
      }
      const policy = await this.#policy();
      const folder =
        parsed.folder === undefined
          ? undefined
          : policy.assertAuthorizedFolder(parsed.folder);
      const snapshot = await this.#snapshot();
      const tasks: Task[] = [];
      for (const note of snapshot.notes) {
        if (
          folder !== undefined &&
          !folderContains(note.identity.path, folder)
        ) {
          continue;
        }
        const occurrences = new Map<string, number>();
        for (const parsedTask of note.tasks) {
          const fingerprint = createRevision(
            parsedTask.text
              .replace(/\s+\^[a-zA-Z0-9][a-zA-Z0-9_-]*\s*$/, "")
              .trim(),
          );
          const occurrence = occurrences.get(fingerprint) ?? 0;
          occurrences.set(fingerprint, occurrence + 1);
          const taskId = createStableId(
            "task",
            parsedTask.blockId === undefined
              ? `${note.identity.noteId}\0${fingerprint}\0${occurrence}`
              : `${note.identity.noteId}\0block:${parsedTask.blockId}`,
          );
          const dueDate =
            parsedTask.dueDate !== undefined &&
            LocalDateSchema.safeParse(parsedTask.dueDate).success
              ? parsedTask.dueDate
              : undefined;
          const scheduledDate =
            parsedTask.scheduledDate !== undefined &&
            LocalDateSchema.safeParse(parsedTask.scheduledDate).success
              ? parsedTask.scheduledDate
              : undefined;
          tasks.push(
            this.#output(TaskSchema, {
              taskId,
              noteId: note.identity.noteId,
              vaultId: this.#vaultId,
              path: note.identity.path,
              line: parsedTask.line,
              text: parsedTask.text,
              status: parsedTask.status,
              ...(parsedTask.blockId !== undefined
                ? { blockId: parsedTask.blockId }
                : {}),
              fingerprint,
              ...(dueDate !== undefined ? { dueDate } : {}),
              ...(scheduledDate !== undefined ? { scheduledDate } : {}),
              priority: parsedTask.priority,
              tags: parsedTask.tags,
            }),
          );
        }
      }

      const requestedTags = parsed.tags.map(normalizeTag);
      const projectTag =
        parsed.projectTag === undefined
          ? undefined
          : normalizeTag(parsed.projectTag);
      const filtered = tasks.filter((task) => {
        if (parsed.status.length > 0 && !parsed.status.includes(task.status)) {
          return false;
        }
        if (parsed.noteId !== undefined && task.noteId !== parsed.noteId)
          return false;
        if (
          parsed.dueFrom !== undefined &&
          (task.dueDate ?? "") < parsed.dueFrom
        ) {
          return false;
        }
        if (
          parsed.dueTo !== undefined &&
          (task.dueDate ?? "9999") > parsed.dueTo
        ) {
          return false;
        }
        if (
          parsed.scheduledFrom !== undefined &&
          (task.scheduledDate ?? "") < parsed.scheduledFrom
        ) {
          return false;
        }
        if (
          parsed.scheduledTo !== undefined &&
          (task.scheduledDate ?? "9999") > parsed.scheduledTo
        ) {
          return false;
        }
        if (
          parsed.priority.length > 0 &&
          !parsed.priority.includes(task.priority)
        ) {
          return false;
        }
        const taskTags = task.tags.map((tag) => tag.toLocaleLowerCase("en-US"));
        if (!requestedTags.every((tag) => taskTags.includes(tag))) return false;
        return projectTag === undefined || taskTags.includes(projectTag);
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

      const fingerprint = requestFingerprint({ ...parsed, cursor: undefined });
      const offset = this.#cursorCodec.decode(
        parsed.cursor,
        "list-tasks",
        fingerprint,
      );
      this.#assertOffset(offset, filtered.length);
      const end = Math.min(offset + parsed.limit, filtered.length);
      const page = this.#output(paginatedSchema(TaskSchema), {
        items: filtered.slice(offset, end),
        ...(end < filtered.length
          ? {
              nextCursor: this.#cursorCodec.encode(
                "list-tasks",
                fingerprint,
                end,
              ),
            }
          : {}),
        total: filtered.length,
      });
      return {
        items: page.items,
        ...(page.nextCursor !== undefined
          ? { nextCursor: page.nextCursor }
          : {}),
        ...(page.total !== undefined ? { total: page.total } : {}),
      };
    });
  }

  async createNote(input: CreateNoteInput): Promise<MutationResult> {
    return this.#safe(async () => {
      this.#assertScope("notes.create");
      const parsed = this.#input(CreateNoteInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const requestHash = this.#writeRequestHash("createNote", parsed);
      return await this.#executeWrite(
        "createNote",
        parsed,
        requestHash,
        async () => await this.#createNote(parsed, requestHash),
      );
    });
  }

  async updateNote(input: UpdateNoteInput): Promise<MutationResult> {
    return this.#safe(async () => {
      this.#assertScope("notes.update");
      const parsed = this.#input(UpdateNoteInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const requestHash = this.#writeRequestHash("updateNote", parsed);
      return await this.#executeWrite(
        "updateNote",
        parsed,
        requestHash,
        async () => {
          const note = this.#findNote(await this.#snapshot(), parsed.noteId);
          const confirmationRequired =
            parsed.operation.type === "replace_document";
          return await this.#mutateExistingNote({
            note,
            expectedRevision: parsed.expectedRevision,
            dryRun: parsed.dryRun,
            confirmationToken: parsed.confirmationToken,
            requestHash,
            operation: parsed.operation.type,
            changedSections:
              parsed.operation.type === "replace_section"
                ? [parsed.operation.heading]
                : ["document"],
            riskLevel: confirmationRequired ? "high" : "medium",
            confirmationRequired,
            transform: (content) =>
              applyExplicitUpdate(content, parsed.operation),
          });
        },
      );
    });
  }

  async appendToNote(input: AppendToNoteInput): Promise<MutationResult> {
    return this.#safe(async () => {
      this.#assertScope("notes.update");
      const parsed = this.#input(AppendToNoteInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const requestHash = this.#writeRequestHash("appendToNote", parsed);
      return await this.#executeWrite(
        "appendToNote",
        parsed,
        requestHash,
        async () => {
          const note = this.#findNote(await this.#snapshot(), parsed.noteId);
          return await this.#mutateExistingNote({
            note,
            expectedRevision: parsed.expectedRevision,
            dryRun: parsed.dryRun,
            confirmationToken: parsed.confirmationToken,
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
    return this.#safe(async () => {
      this.#assertScope("notes.update");
      const parsed = this.#input(SetFrontmatterInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const requestHash = this.#writeRequestHash("setFrontmatter", parsed);
      return await this.#executeWrite(
        "setFrontmatter",
        parsed,
        requestHash,
        async () => {
          const note = this.#findNote(await this.#snapshot(), parsed.noteId);
          return await this.#mutateExistingNote({
            note,
            expectedRevision: parsed.expectedRevision,
            dryRun: parsed.dryRun,
            confirmationToken: parsed.confirmationToken,
            requestHash,
            operation: "set_frontmatter",
            changedSections: ["frontmatter"],
            riskLevel: "low",
            confirmationRequired: false,
            transform: (content) =>
              setFrontmatterContent(content, parsed.set, parsed.remove),
          });
        },
      );
    });
  }

  async moveNote(input: MoveNoteInput): Promise<MutationResult> {
    return this.#safe(async () => {
      this.#assertScope("notes.move");
      const parsed = this.#input(MoveNoteInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const requestHash = this.#writeRequestHash("moveNote", parsed);
      return await this.#executeWrite(
        "moveNote",
        parsed,
        requestHash,
        async () => {
          this.#assertMarkdownPath(parsed.destinationPath);
          const note = this.#findNote(await this.#snapshot(), parsed.noteId);
          return await this.#relocateNote({
            note,
            expectedRevision: parsed.expectedRevision,
            destinationPath: parsed.destinationPath,
            dryRun: parsed.dryRun,
            confirmationToken: parsed.confirmationToken,
            requestHash,
            operation: "move",
            createDestinationFolder: false,
            trash: false,
          });
        },
      );
    });
  }

  async trashNote(input: TrashNoteInput): Promise<MutationResult> {
    return this.#safe(async () => {
      this.#assertScope("notes.trash");
      const parsed = this.#input(TrashNoteInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const requestHash = this.#writeRequestHash("trashNote", parsed);
      return await this.#executeWrite(
        "trashNote",
        parsed,
        requestHash,
        async () => {
          const policy = await this.#policy();
          const note = this.#findNote(await this.#snapshot(), parsed.noteId);
          const authorizedRoot = policy.authorizedRootFor(note.identity.path);
          const trashFolder = authorizedRoot
            ? `${authorizedRoot}/.workbench-trash`
            : ".workbench-trash";
          const suffix = requestHash.replace(/^sha256:/, "").slice(0, 20);
          const destinationPath = `${trashFolder}/${path.posix.basename(
            note.identity.path,
          )}.${suffix}.trashed`;
          return await this.#relocateNote({
            note,
            expectedRevision: parsed.expectedRevision,
            destinationPath,
            dryRun: parsed.dryRun,
            confirmationToken: parsed.confirmationToken,
            requestHash,
            operation: "trash",
            createDestinationFolder: true,
            trash: true,
          });
        },
      );
    });
  }

  async createTask(input: CreateTaskInput): Promise<MutationResult> {
    return this.#safe(async () => {
      this.#assertScope("tasks.create");
      const parsed = this.#input(CreateTaskInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const requestHash = this.#writeRequestHash("createTask", parsed);
      return await this.#executeWrite(
        "createTask",
        parsed,
        requestHash,
        async () => {
          const note = this.#findNote(await this.#snapshot(), parsed.noteId);
          const task = `- [ ] ${parsed.text}${
            parsed.dueDate === undefined ? "" : ` \u{1F4C5} ${parsed.dueDate}`
          }`;
          return await this.#mutateExistingNote({
            note,
            expectedRevision: parsed.expectedRevision,
            dryRun: parsed.dryRun,
            confirmationToken: parsed.confirmationToken,
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
    return this.#safe(async () => {
      this.#assertScope("tasks.update");
      const parsed = this.#input(UpdateTaskInputSchema, input);
      this.#assertVault(parsed.vaultId);
      const requestHash = this.#writeRequestHash("updateTask", parsed);
      return await this.#executeWrite(
        "updateTask",
        parsed,
        requestHash,
        async () => {
          const located = this.#findTask(await this.#snapshot(), parsed.taskId);
          return await this.#mutateExistingNote({
            note: located.note,
            expectedRevision: parsed.expectedRevision,
            dryRun: parsed.dryRun,
            confirmationToken: parsed.confirmationToken,
            requestHash,
            operation: "update_task",
            changedSections: ["tasks"],
            riskLevel: "low",
            confirmationRequired: false,
            transform: (content) =>
              updateTaskContent(
                content,
                located.task.line,
                located.task.blockId,
                located.task.dueDate,
                {
                  ...(parsed.status !== undefined
                    ? { status: parsed.status }
                    : {}),
                  ...(parsed.text !== undefined ? { text: parsed.text } : {}),
                  ...(parsed.dueDate !== undefined
                    ? { dueDate: parsed.dueDate }
                    : {}),
                },
              ),
          });
        },
      );
    });
  }

  issueConfirmation(plan: MutationPlan): string {
    if (plan.vaultId !== this.#vaultId) {
      throw new WorkbenchError({
        code: "VAULT_NOT_FOUND",
        message: "The requested vault could not be found.",
        recoverable: true,
      });
    }
    return this.confirmations.issueFromPlan(plan, this.#localUserId);
  }

  async #executeWrite(
    tool: string,
    safety: { dryRun: boolean; idempotencyKey: string },
    requestHash: string,
    operation: () => Promise<MutationResult>,
  ): Promise<MutationResult> {
    if (safety.dryRun) return await operation();
    return await this.#idempotencyStore.execute(
      this.#localUserId,
      this.#vaultId,
      tool,
      safety.idempotencyKey,
      requestHash,
      operation,
    );
  }

  #writeRequestHash(tool: string, input: object): string {
    const payload = Object.fromEntries(
      Object.entries(input).filter(
        ([key]) =>
          key !== "confirmationToken" &&
          key !== "dryRun" &&
          key !== "idempotencyKey",
      ),
    );
    return mutationRequestHash({ tool, payload });
  }

  async #createNote(
    parsed: ReturnType<(typeof CreateNoteInputSchema)["parse"]>,
    requestHash: string,
  ): Promise<MutationResult> {
    this.#assertMarkdownPath(parsed.path);
    const policy = await this.#policy();
    let destination = await policy.resolveAuthorizedDestination(parsed.path);
    await this.#assertDestinationAvailable(destination.absolutePath);
    if (!parsed.createFolders) {
      await this.#assertExistingDirectory(
        path.dirname(destination.absolutePath),
      );
    }

    const proposed = createNoteContent(parsed.content, parsed.frontmatter);
    this.#assertWritableSize(proposed);
    const plan = buildMutationPlan({
      vaultId: this.#vaultId,
      sourcePath: destination.relativePath,
      operation: "create",
      requestHash,
      proposedContent: proposed,
      changedSections: ["document"],
      riskLevel: "low",
      confirmationRequired: false,
      now: this.#now(),
    });
    if (parsed.dryRun) return this.#mutationResult(plan, true);

    if (parsed.createFolders) {
      await mkdir(path.dirname(destination.absolutePath), { recursive: true });
      destination = await policy.resolveAuthorizedDestination(parsed.path);
      await this.#assertDestinationAvailable(destination.absolutePath);
    }
    const handle = await open(destination.absolutePath, "wx");
    try {
      await this.#writeHandle(handle, proposed);
    } finally {
      await handle.close();
    }
    const created = await this.#readIndexedNote(
      policy,
      destination.relativePath,
    );
    return this.#mutationResult(plan, false, created.identity);
  }

  async #mutateExistingNote(
    options: ExistingMutationOptions,
  ): Promise<MutationResult> {
    const policy = await this.#policy();
    const authorized = await policy.resolveAuthorizedPath(
      options.note.identity.path,
    );
    const handle = await open(
      authorized.absolutePath,
      options.dryRun ? "r" : "r+",
    );
    try {
      const original = await this.#readHandle(handle, options.expectedRevision);
      this.#assertRevision(options.expectedRevision, original.content);
      const proposed = normalizeNoteContent(
        options.transform(original.content),
      );
      this.#assertWritableSize(proposed);
      const plan = buildMutationPlan({
        vaultId: this.#vaultId,
        targetNoteId: options.note.identity.noteId,
        sourcePath: options.note.identity.path,
        operation: options.operation,
        requestHash: options.requestHash,
        originalContent: original.content,
        proposedContent: proposed,
        changedSections: options.changedSections,
        riskLevel: options.riskLevel,
        confirmationRequired: options.confirmationRequired,
        now: this.#now(),
      });
      if (options.dryRun) {
        return this.#mutationResult(
          plan,
          true,
          this.#identityForContent(
            options.note,
            options.note.identity.path,
            proposed,
          ),
        );
      }
      this.#consumeConfirmation(plan, options.confirmationToken);
      if (proposed === original.content) {
        return this.#mutationResult(
          plan,
          false,
          this.#identityForContent(
            options.note,
            options.note.identity.path,
            proposed,
          ),
          true,
        );
      }

      const immediatelyBeforeWrite = await this.#readHandle(
        handle,
        options.expectedRevision,
      );
      if (!immediatelyBeforeWrite.bytes.equals(original.bytes)) {
        throw this.#revisionConflict(
          options.expectedRevision,
          createRevision(immediatelyBeforeWrite.content),
        );
      }
      await this.#writeHandle(handle, proposed);
      return this.#mutationResult(
        plan,
        false,
        this.#identityForContent(
          options.note,
          options.note.identity.path,
          proposed,
        ),
      );
    } finally {
      await handle.close();
    }
  }

  async #relocateNote(options: RelocateNoteOptions): Promise<MutationResult> {
    const policy = await this.#policy();
    const source = await policy.resolveAuthorizedPath(
      options.note.identity.path,
    );
    let destination = await policy.resolveAuthorizedDestination(
      options.destinationPath,
    );
    if (policy.pathsEqual(source.relativePath, destination.relativePath)) {
      throw validationError("The source and destination paths are the same.");
    }
    await this.#assertDestinationAvailable(destination.absolutePath);
    if (!options.createDestinationFolder) {
      await this.#assertExistingDirectory(
        path.dirname(destination.absolutePath),
      );
    }

    const handle = await open(source.absolutePath, "r");
    let sourceIdentity: { dev: bigint; ino: bigint };
    let original: HandleContent;
    let plan: MutationPlan;
    try {
      const identity = await handle.stat({ bigint: true });
      sourceIdentity = { dev: identity.dev, ino: identity.ino };
      original = await this.#readHandle(handle, options.expectedRevision);
      this.#assertRevision(options.expectedRevision, original.content);
      plan = buildMutationPlan({
        vaultId: this.#vaultId,
        targetNoteId: options.note.identity.noteId,
        sourcePath: source.relativePath,
        targetPath: destination.relativePath,
        operation: options.operation,
        requestHash: options.requestHash,
        originalContent: original.content,
        proposedContent: original.content,
        changedSections: ["path"],
        riskLevel: "high",
        confirmationRequired: true,
        now: this.#now(),
      });
      if (options.dryRun) {
        return this.#mutationResult(
          plan,
          true,
          options.trash
            ? undefined
            : this.#identityForContent(
                options.note,
                destination.relativePath,
                original.content,
              ),
        );
      }
      this.#consumeConfirmation(plan, options.confirmationToken);
      const immediatelyBeforeMove = await this.#readHandle(
        handle,
        options.expectedRevision,
      );
      if (!immediatelyBeforeMove.bytes.equals(original.bytes)) {
        throw this.#revisionConflict(
          options.expectedRevision,
          createRevision(immediatelyBeforeMove.content),
        );
      }
    } finally {
      await handle.close();
    }

    if (options.createDestinationFolder) {
      await mkdir(path.dirname(destination.absolutePath), { recursive: true });
    }
    const freshSource = await policy.resolveAuthorizedPath(
      options.note.identity.path,
    );
    destination = await policy.resolveAuthorizedDestination(
      options.destinationPath,
    );
    await this.#assertDestinationAvailable(destination.absolutePath);
    await this.#assertExistingDirectory(path.dirname(destination.absolutePath));
    const currentIdentity = await stat(freshSource.absolutePath, {
      bigint: true,
    });
    if (
      currentIdentity.dev !== sourceIdentity.dev ||
      currentIdentity.ino !== sourceIdentity.ino
    ) {
      const current = await open(freshSource.absolutePath, "r");
      try {
        const changed = await this.#readHandle(
          current,
          options.expectedRevision,
        );
        throw this.#revisionConflict(
          options.expectedRevision,
          createRevision(changed.content),
        );
      } finally {
        await current.close();
      }
    }

    const finalSource = await open(freshSource.absolutePath, "r");
    try {
      const current = await this.#readHandle(
        finalSource,
        options.expectedRevision,
      );
      if (!current.bytes.equals(original.bytes)) {
        throw this.#revisionConflict(
          options.expectedRevision,
          createRevision(current.content),
        );
      }
    } finally {
      await finalSource.close();
    }

    await link(freshSource.absolutePath, destination.absolutePath);
    try {
      await unlink(freshSource.absolutePath);
    } catch (error) {
      try {
        await unlink(destination.absolutePath);
      } catch {
        // The original remains intact; do not expose rollback filesystem details.
      }
      throw error;
    }
    return this.#mutationResult(
      plan,
      false,
      options.trash
        ? undefined
        : this.#identityForContent(
            options.note,
            destination.relativePath,
            original.content,
          ),
    );
  }

  async #readHandle(
    handle: FileHandle,
    expectedRevision?: string,
  ): Promise<HandleContent> {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw noteNotFound();
    if (metadata.size > this.#maxFileBytes) {
      throw validationError("A note exceeds the configured maximum size.");
    }
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const afterRead = await handle.stat();
    if (offset !== bytes.length || afterRead.size !== metadata.size) {
      const partial = bytes.subarray(0, offset);
      throw this.#revisionConflict(
        expectedRevision ?? createRevision(""),
        createRevision(partial.toString("utf8")),
      );
    }
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw validationError("A note is not valid UTF-8 text.");
    }
    return { bytes, content: normalizeNoteContent(decoded) };
  }

  async #writeHandle(handle: FileHandle, content: string): Promise<void> {
    const bytes = Buffer.from(normalizeNoteContent(content), "utf8");
    if (bytes.length > this.#maxFileBytes) {
      throw validationError(
        "The proposed note exceeds the configured maximum size.",
      );
    }
    await handle.truncate(0);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesWritten === 0) throw internalError();
      offset += result.bytesWritten;
    }
    await handle.sync();
  }

  #assertRevision(expectedRevision: string, content: string): void {
    const currentRevision = createRevision(content);
    if (currentRevision !== expectedRevision) {
      throw this.#revisionConflict(expectedRevision, currentRevision);
    }
  }

  #revisionConflict(
    expectedRevision: string,
    currentRevision: string,
  ): WorkbenchError {
    return new WorkbenchError({
      code: "REVISION_CONFLICT",
      message: "The note changed after it was read.",
      recoverable: true,
      details: { expectedRevision, currentRevision },
    });
  }

  #consumeConfirmation(
    plan: MutationPlan,
    confirmationToken: string | undefined,
  ): void {
    if (!plan.diff.confirmationRequired) return;
    if (confirmationToken === undefined) {
      throw new WorkbenchError({
        code: "CONFIRMATION_REQUIRED",
        message:
          "This mutation requires confirmation before it can be applied.",
        recoverable: true,
      });
    }
    this.confirmations.consume(confirmationToken, {
      userId: this.#localUserId,
      vaultId: this.#vaultId,
      targetPath: plan.targetPath,
      mutationHash: plan.mutationHash,
    });
  }

  #mutationResult(
    plan: MutationPlan,
    dryRun: boolean,
    note?: NoteIdentity,
    unchanged = false,
  ): MutationResult {
    return this.#output(MutationResultSchema, {
      operationId: plan.mutationId,
      status: dryRun ? "preview" : unchanged ? "unchanged" : "applied",
      ...(note !== undefined ? { note } : {}),
      diff: plan.diff,
      plan,
      idempotentReplay: false,
    });
  }

  #identityForContent(
    indexed: IndexedNote,
    relativePath: string,
    content: string,
  ): NoteIdentity {
    const parsed = parseMarkdown(content, relativePath);
    const titleValue = parsed.frontmatter.title;
    return {
      noteId: indexed.identity.noteId,
      vaultId: this.#vaultId,
      path: relativePath,
      title:
        typeof titleValue === "string" && titleValue.trim() !== ""
          ? titleValue.trim()
          : path.posix.basename(relativePath, path.posix.extname(relativePath)),
      revision: createRevision(content),
    };
  }

  #assertWritableSize(content: string): void {
    if (Buffer.byteLength(content, "utf8") > this.#maxFileBytes) {
      throw validationError(
        "The proposed note exceeds the configured maximum size.",
      );
    }
  }

  #assertMarkdownPath(relativePath: string): void {
    if (path.posix.extname(relativePath).toLocaleLowerCase("en-US") !== ".md") {
      throw validationError("A note path must use the .md extension.");
    }
  }

  async #assertDestinationAvailable(absolutePath: string): Promise<void> {
    try {
      await stat(absolutePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    throw validationError("The destination path already exists.");
  }

  async #assertExistingDirectory(absolutePath: string): Promise<void> {
    try {
      if ((await stat(absolutePath)).isDirectory()) return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    throw validationError("The destination folder does not exist.");
  }

  async #policy(): Promise<PathSecurity> {
    this.#policyPromise ??= PathSecurity.create({
      vaultRoot: this.#rootPath,
      ...this.#policyOptions,
    });
    return await this.#policyPromise;
  }

  async #snapshot(): Promise<VaultSnapshot> {
    const policy = await this.#policy();
    const paths = await this.#enumerateMarkdown(policy, policy.vaultRoot, "");
    paths.sort(compareText);
    const notes: IndexedNote[] = [];
    for (const relativePath of paths) {
      notes.push(await this.#readIndexedNote(policy, relativePath));
    }

    const byPath = new Map<string, IndexedNote[]>();
    const byBasename = new Map<string, IndexedNote[]>();
    for (const note of notes) {
      const pathKey = note.identity.path
        .replace(/\.md$/i, "")
        .toLocaleLowerCase("en-US");
      const basenameKey = path.posix
        .basename(pathKey)
        .toLocaleLowerCase("en-US");
      byPath.set(pathKey, [...(byPath.get(pathKey) ?? []), note]);
      byBasename.set(basenameKey, [
        ...(byBasename.get(basenameKey) ?? []),
        note,
      ]);
    }
    for (const note of notes) {
      note.links = note.links.map((link) => {
        const resolved = this.#resolveLink(
          note,
          link.target,
          byPath,
          byBasename,
        );
        return this.#output(WikiLinkSchema, {
          ...link,
          ...(resolved !== undefined
            ? { resolvedNoteId: resolved.identity.noteId }
            : {}),
        });
      });
    }
    return {
      notes,
      byId: new Map(notes.map((note) => [note.identity.noteId, note])),
    };
  }

  async #enumerateMarkdown(
    policy: PathSecurity,
    absoluteDirectory: string,
    relativeDirectory: string,
  ): Promise<string[]> {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    const results: string[] = [];
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!policy.shouldTraverseDirectory(relativePath)) continue;
        results.push(
          ...(await this.#enumerateMarkdown(
            policy,
            path.join(absoluteDirectory, entry.name),
            relativePath,
          )),
        );
        continue;
      }
      if (
        entry.isFile() &&
        path.extname(entry.name).toLocaleLowerCase("en-US") === ".md" &&
        policy.isAuthorizedRelativePath(relativePath)
      ) {
        results.push(relativePath.replaceAll("\\", "/"));
      }
    }
    return results;
  }

  async #readIndexedNote(
    policy: PathSecurity,
    relativePath: string,
  ): Promise<IndexedNote> {
    const authorized = await policy.resolveAuthorizedPath(relativePath);
    const handle = await open(authorized.absolutePath, "r");
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw noteNotFound();
      if (stats.size > this.#maxFileBytes) {
        throw new WorkbenchError({
          code: "VALIDATION_ERROR",
          message: "A note exceeds the configured maximum readable size.",
          recoverable: true,
        });
      }
      const buffer = await handle.readFile();
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        throw new WorkbenchError({
          code: "VALIDATION_ERROR",
          message: "A note is not valid UTF-8 text.",
          recoverable: true,
        });
      }
      content = normalizeNoteContent(content);
      const parsed = parseMarkdown(content, relativePath);
      const identityStats = await handle.stat({ bigint: true });
      const filesystemIdentity = `${identityStats.dev}:${identityStats.ino}:${identityStats.birthtimeNs}`;
      const titleValue = parsed.frontmatter.title;
      const title =
        typeof titleValue === "string" && titleValue.trim() !== ""
          ? titleValue.trim()
          : path.posix.basename(relativePath, path.posix.extname(relativePath));
      const identity: NoteIdentity = {
        noteId: createStableId(
          "note",
          `${this.#vaultId}\0${filesystemIdentity}`,
        ),
        vaultId: this.#vaultId,
        path: relativePath,
        title,
        revision: createRevision(content),
      };
      return {
        identity,
        content,
        frontmatter: parsed.frontmatter,
        frontmatterEndLine: parsed.frontmatterEndLine,
        headings: parsed.headings,
        links: parsed.links,
        tags: parsed.tags,
        tasks: parsed.tasks,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
      };
    } finally {
      await handle.close();
    }
  }

  #resolveLink(
    source: IndexedNote,
    rawTarget: string,
    byPath: Map<string, IndexedNote[]>,
    byBasename: Map<string, IndexedNote[]>,
  ): IndexedNote | undefined {
    let target = rawTarget.trim().replaceAll("\\", "/").replace(/\.md$/i, "");
    try {
      target = decodeURIComponent(target);
    } catch {
      return undefined;
    }
    if (/^(?:\/|[a-zA-Z]:|[a-z]+:)/.test(target)) return undefined;
    const sourceDirectory = path.posix.dirname(source.identity.path);
    const candidates: string[] = [];
    if (target.includes("/")) {
      candidates.push(path.posix.normalize(target));
      candidates.push(
        path.posix.normalize(path.posix.join(sourceDirectory, target)),
      );
    } else {
      const basenameMatches = byBasename.get(target.toLocaleLowerCase("en-US"));
      if (basenameMatches?.length === 1) return basenameMatches[0];
      candidates.push(
        path.posix.normalize(path.posix.join(sourceDirectory, target)),
      );
    }
    for (const candidate of candidates) {
      if (candidate === ".." || candidate.startsWith("../")) continue;
      const matches = byPath.get(candidate.toLocaleLowerCase("en-US"));
      if (matches?.length === 1) return matches[0];
    }
    return undefined;
  }

  #findNote(snapshot: VaultSnapshot, noteId: string): IndexedNote {
    const note = snapshot.byId.get(noteId);
    if (note === undefined) throw noteNotFound();
    return note;
  }

  #findTask(
    snapshot: VaultSnapshot,
    taskId: string,
  ): { note: IndexedNote; task: ParsedTaskLine } {
    for (const note of snapshot.notes) {
      const occurrences = new Map<string, number>();
      for (const task of note.tasks) {
        const fingerprint = createRevision(
          task.text.replace(/\s+\^[a-zA-Z0-9][a-zA-Z0-9_-]*\s*$/, "").trim(),
        );
        const occurrence = occurrences.get(fingerprint) ?? 0;
        occurrences.set(fingerprint, occurrence + 1);
        const candidateId = createStableId(
          "task",
          task.blockId === undefined
            ? `${note.identity.noteId}\0${fingerprint}\0${occurrence}`
            : `${note.identity.noteId}\0block:${task.blockId}`,
        );
        if (candidateId === taskId) return { note, task };
      }
    }
    throw validationError("The requested task could not be found.");
  }

  #backlinks(snapshot: VaultSnapshot, target: IndexedNote): Backlink[] {
    const backlinks: Backlink[] = [];
    for (const source of snapshot.notes) {
      for (const link of source.links) {
        if (link.resolvedNoteId !== target.identity.noteId) continue;
        backlinks.push(
          this.#output(BacklinkSchema, {
            sourceNoteId: source.identity.noteId,
            sourcePath: source.identity.path,
            targetNoteId: target.identity.noteId,
            line: link.line,
            context: (source.content.split("\n")[link.line - 1] ?? "").slice(
              0,
              1000,
            ),
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
        this.#output(UnresolvedLinkSchema, {
          raw: link.raw,
          target: link.target,
          ...(link.alias !== undefined ? { alias: link.alias } : {}),
          ...(link.heading !== undefined ? { heading: link.heading } : {}),
          ...(link.blockId !== undefined ? { blockId: link.blockId } : {}),
          embedded: link.embedded,
          line: link.line,
          sourceNoteId: note.identity.noteId,
        }),
      );
  }

  #snippet(
    note: IndexedNote,
    needle: string,
  ): { text: string; lineStart: number; lineEnd: number } {
    const lines = note.content.split("\n");
    const lowerContent = note.content.toLocaleLowerCase("en-US");
    const matchOffset = lowerContent.indexOf(needle);
    let lineIndex = note.frontmatterEndLine;
    let column = 0;
    if (matchOffset >= 0) {
      const prefix = note.content.slice(0, matchOffset);
      lineIndex = prefix.split("\n").length - 1;
      column = matchOffset - (prefix.lastIndexOf("\n") + 1);
    } else {
      const firstTextLine = lines.findIndex(
        (line, index) => index >= note.frontmatterEndLine && line.trim() !== "",
      );
      lineIndex = firstTextLine >= 0 ? firstTextLine : 0;
    }
    const line = lines[lineIndex] ?? note.identity.title;
    const startColumn = Math.max(
      0,
      Math.min(column - Math.floor(MAX_SNIPPET_LENGTH / 3), line.length),
    );
    const text = line.slice(startColumn, startColumn + MAX_SNIPPET_LENGTH);
    return {
      text: text || note.identity.title.slice(0, MAX_SNIPPET_LENGTH),
      lineStart: lineIndex + 1,
      lineEnd: lineIndex + 1,
    };
  }

  #formatDailyDate(date: string, format: string): string {
    const [year, month, day] = date.split("-");
    if (year === undefined || month === undefined || day === undefined) {
      throw validationError("The daily-note date is invalid.");
    }
    const filename = format
      .replaceAll("YYYY", year)
      .replaceAll("MM", month)
      .replaceAll("DD", day);
    if (filename.length === 0 || /[\\/]/.test(filename)) {
      throw validationError("The daily-note format is invalid.");
    }
    return filename;
  }

  #assertVault(vaultId: string): void {
    if (vaultId !== this.#vaultId) {
      throw new WorkbenchError({
        code: "VAULT_NOT_FOUND",
        message: "The requested vault could not be found.",
        recoverable: true,
      });
    }
  }

  #assertScope(scope: PermissionScope): void {
    if (!this.#scopeSet.has(scope)) {
      throw new WorkbenchError({
        code: "PERMISSION_DENIED",
        message:
          "The operation is not permitted by the configured vault scopes.",
        recoverable: true,
      });
    }
  }

  #assertOffset(offset: number, total: number): void {
    if (offset > total) {
      throw validationError(
        "The pagination cursor is stale or does not match the available results.",
      );
    }
  }

  #input<T>(schema: RuntimeSchema<T>, value: unknown): T {
    try {
      return schema.parse(value);
    } catch (error) {
      if (error instanceof WorkbenchError) throw error;
      throw validationError();
    }
  }

  #output<T>(schema: RuntimeSchema<T>, value: unknown): T {
    try {
      return schema.parse(value);
    } catch {
      throw internalError();
    }
  }

  async #safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw toSafeFilesystemError(error);
    }
  }
}
