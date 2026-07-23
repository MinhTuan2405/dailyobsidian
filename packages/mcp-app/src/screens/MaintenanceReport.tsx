import { useEffect, useState } from "react";

import type { NoteSummary } from "@obsidian-workbench/shared";

import type { WorkbenchBridge } from "../bridge/workbench-bridge.js";

export function MaintenanceReport({
  bridge,
  vaultId,
}: {
  bridge: WorkbenchBridge;
  vaultId: string;
}) {
  const [orphans, setOrphans] = useState<NoteSummary[]>([]);
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    void bridge
      .findOrphans(vaultId)
      .then((notes) => {
        if (current) setOrphans(notes);
      })
      .catch(() => {
        if (current) setError("The maintenance report is incomplete.");
      });
    return () => {
      current = false;
    };
  }, [bridge, vaultId]);

  return (
    <section className="screen maintenance-screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">07 / Condition report</p>
          <h1>Inspect before repair</h1>
        </div>
        <span className="report-only">MODE: REPORT ONLY</span>
      </header>
      {error ? <p className="inline-error">{error}</p> : null}
      <div className="finding-summary">
        {[
          ["Broken links", "not scanned"],
          ["Orphan notes", orphans.length.toString()],
          ["Duplicate titles", "not scanned"],
          ["Invalid frontmatter", "not scanned"],
          ["Empty notes", "not scanned"],
          ["Convention violations", "not scanned"],
        ].map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="finding-list">
        {orphans
          .filter((note) => !ignored.has(note.noteId))
          .map((note) => (
            <article key={note.noteId}>
              <span className="finding-id">ORPHAN</span>
              <div>
                <strong>{note.title}</strong>
                <code>{note.path}</code>
              </div>
              <div className="finding-actions">
                <button
                  className="text-button"
                  onClick={() =>
                    setIgnored((previous) => new Set(previous).add(note.noteId))
                  }
                >
                  Ignore
                </button>
                <button className="text-button">Open note</button>
                <button className="text-button">Generate fix</button>
                <button className="text-button" disabled>
                  Apply fix
                </button>
              </div>
            </article>
          ))}
      </div>
    </section>
  );
}
