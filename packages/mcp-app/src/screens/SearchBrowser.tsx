import { startTransition, useDeferredValue, useEffect, useState } from "react";

import type {
  NoteDocument,
  NoteSummary,
  SearchHit,
} from "@obsidian-workbench/shared";

import type { WorkbenchBridge } from "../bridge/workbench-bridge.js";

export function SearchBrowser({
  bridge,
  vaultId,
  onOpen,
}: {
  bridge: WorkbenchBridge;
  vaultId: string;
  onOpen: (document: NoteDocument) => void;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [folder, setFolder] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [summaries, setSummaries] = useState<NoteSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(undefined);
    const load = deferredQuery
      ? bridge.searchNotes(vaultId, deferredQuery)
      : bridge.listNotes(vaultId);
    void load
      .then((result) => {
        if (!current) return;
        startTransition(() => {
          if (Array.isArray(result)) {
            setSummaries(result);
            setHits([]);
          } else {
            setHits(result.hits);
            setSummaries([]);
          }
          setLoading(false);
        });
      })
      .catch(() => {
        if (!current) return;
        setError("Search could not be completed.");
        setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [bridge, deferredQuery, vaultId]);

  const rows = (
    hits.length > 0 ? hits.map((hit) => hit.note) : summaries
  ).filter((note) => folder === "" || note.path.startsWith(folder));

  async function openNote(noteId: string) {
    setError(undefined);
    try {
      onOpen(await bridge.getNote(vaultId, noteId));
    } catch {
      setError("The selected note is stale or unavailable.");
    }
  }

  function toggle(noteId: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  }

  return (
    <section className="screen search-screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">02 / Retrieval desk</p>
          <h1>Find the thread</h1>
        </div>
        <span className="selection-count">{selected.size} selected</span>
      </header>
      <div className="search-controls">
        <label>
          <span>Search notes</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="A phrase, title, tag..."
          />
        </label>
        <label>
          <span>Folder prefix</span>
          <input
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
            placeholder="Projects/"
          />
        </label>
        <label>
          <span>Sort</span>
          <select defaultValue="relevance">
            <option value="relevance">Relevance</option>
            <option value="modified">Modified</option>
          </select>
        </label>
      </div>
      {error ? <p className="inline-error">{error}</p> : null}
      <div className="result-ledger" aria-busy={loading}>
        {loading ? (
          <p className="loading-line">Indexing authorized notes...</p>
        ) : null}
        {!loading && rows.length === 0 ? (
          <p className="empty-line">No notes match this boundary.</p>
        ) : null}
        {rows.map((note) => {
          const hit = hits.find(
            (candidate) => candidate.note.noteId === note.noteId,
          );
          return (
            <article className="result-row" key={note.noteId}>
              <label className="check-cell">
                <input
                  type="checkbox"
                  checked={selected.has(note.noteId)}
                  onChange={() => toggle(note.noteId)}
                  aria-label={`Select ${note.title}`}
                />
              </label>
              <button
                className="result-main"
                onClick={() => void openNote(note.noteId)}
              >
                <strong>{note.title}</strong>
                <code>{note.path}</code>
                {hit ? <span className="snippet">{hit.snippet}</span> : null}
              </button>
              <span className="score">{hit ? hit.score.toFixed(0) : "--"}</span>
            </article>
          );
        })}
      </div>
      <footer className="screen-footer">
        <button className="button ghost" disabled={selected.size === 0}>
          Send selected to context
        </button>
        <span>Search snippets are untrusted and bounded.</span>
      </footer>
    </section>
  );
}
