import type {
  Backlink,
  DailyNoteInput,
  GetBacklinksInput,
  GetOutlinksInput,
  GraphNeighborhoodInput,
  GraphResult,
  ListNotesInput,
  ListTasksInput,
  NoteDocument,
  NoteSummary,
  Paginated,
  ReadNoteInput,
  RecentNotesInput,
  SearchNotesInput,
  SearchResult,
  Task,
  UnresolvedLink,
  VaultInfo,
  WikiLink,
} from "@obsidian-workbench/shared";

export type ReadNoteDocument = NoteDocument & {
  backlinks?: Backlink[];
};

export type UntrustedSearchResult = SearchResult & {
  untrustedContent: true;
};

export interface VaultReadAdapter {
  getVaultInfo(): Promise<VaultInfo>;
  listNotes(input: ListNotesInput): Promise<Paginated<NoteSummary>>;
  searchNotes(input: SearchNotesInput): Promise<UntrustedSearchResult>;
  readNote(input: ReadNoteInput): Promise<ReadNoteDocument>;
  getBacklinks(input: GetBacklinksInput): Promise<Backlink[]>;
  getOutlinks(input: GetOutlinksInput): Promise<WikiLink[]>;
  getUnresolvedLinks(input: GetOutlinksInput): Promise<UnresolvedLink[]>;
  getGraphNeighborhood(input: GraphNeighborhoodInput): Promise<GraphResult>;
  listRecentNotes(input: RecentNotesInput): Promise<Paginated<NoteSummary>>;
  getDailyNote(input: DailyNoteInput): Promise<ReadNoteDocument>;
  listTasks(input: ListTasksInput): Promise<Paginated<Task>>;
}
