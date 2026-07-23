import { useEffect, useState } from "react";

import type { NoteDocument } from "@obsidian-workbench/shared";

type NoteTab = "preview" | "markdown" | "metadata" | "links";

export function NoteViewer({
  document,
  onPreviewDiff,
}: {
  document?: NoteDocument;
  onPreviewDiff: (document: NoteDocument, markdown: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<NoteTab>("preview");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setDraft(document?.content ?? "");
    setEditing(false);
    setTab("preview");
  }, [document]);

  if (!document) {
    return (
      <section className="screen note-screen empty-note">
        <p className="eyebrow">03 / Reading table</p>
        <h1>No note open</h1>
        <p>Select a search result to inspect it here.</p>
      </section>
    );
  }

  async function preview() {
    setLoading(true);
    try {
      await onPreviewDiff(document as NoteDocument, draft);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="screen note-screen">
      <header className="note-heading">
        <div>
          <p className="eyebrow">03 / Reading table</p>
          <h1>{document.identity.title}</h1>
          <code>{document.identity.path}</code>
        </div>
        <div className="revision-stamp">
          <span>REV</span>
          <code>{document.identity.revision.slice(7, 19)}</code>
        </div>
      </header>
      <nav className="tab-strip" aria-label="Note sections">
        {(["preview", "markdown", "metadata", "links"] as NoteTab[]).map(
          (candidate) => (
            <button
              key={candidate}
              aria-pressed={tab === candidate}
              onClick={() => setTab(candidate)}
            >
              {candidate}
            </button>
          ),
        )}
      </nav>
      <div className="note-content">
        {tab === "preview" ? (
          <pre className="markdown-preview">{draft}</pre>
        ) : null}
        {tab === "markdown" ? (
          <textarea
            aria-label="Markdown draft"
            value={draft}
            readOnly={!editing}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck="false"
          />
        ) : null}
        {tab === "metadata" ? (
          <dl className="metadata-list">
            <div>
              <dt>Modified</dt>
              <dd>{document.modifiedAt}</dd>
            </div>
            {Object.entries(document.frontmatter ?? {}).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{JSON.stringify(value)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {tab === "links" ? (
          <div className="link-list">
            {(document.links ?? []).map((link, index) => (
              <code key={`${link.raw}-${index}`}>{link.raw}</code>
            ))}
            {(document.unresolvedLinks ?? []).map((link, index) => (
              <code className="unresolved" key={`${link.raw}-${index}`}>
                unresolved: {link.raw}
              </code>
            ))}
          </div>
        ) : null}
      </div>
      <footer className="note-actions">
        {!editing ? (
          <button
            className="button ghost"
            onClick={() => {
              setEditing(true);
              setTab("markdown");
            }}
          >
            Edit
          </button>
        ) : (
          <>
            <button
              className="button primary"
              disabled={loading}
              onClick={() => void preview()}
            >
              {loading ? "Building diff..." : "Preview diff"}
            </button>
            <button
              className="button ghost"
              onClick={() => {
                setDraft(document.content ?? "");
                setEditing(false);
              }}
            >
              Cancel edit
            </button>
          </>
        )}
        <span>No auto-save. Content is treated as untrusted data.</span>
      </footer>
    </section>
  );
}
