import { useState } from "react";

import type { MutationPlan, MutationResult } from "@obsidian-workbench/shared";

import { BridgeError } from "../bridge/workbench-bridge.js";
import type { PendingMutation } from "../state/types.js";

export function DiffConfirmation({
  pending,
  confirm,
  onApplied,
  onEdit,
  onCancel,
}: {
  pending?: PendingMutation;
  confirm: (plan: MutationPlan) => Promise<string>;
  onApplied: (results: MutationResult[]) => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const count = pending?.previews.length ?? 0;
  const [selected, setSelected] = useState<Set<number>>(
    count === 1 ? new Set([0]) : new Set(),
  );
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string>();

  if (!pending || count === 0) {
    return (
      <section className="screen diff-screen">
        <p className="eyebrow">04 / Change proof</p>
        <h1>No mutation to review</h1>
      </section>
    );
  }
  const current = pending;

  function toggle(index: number) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function applySelected() {
    setApplying(true);
    setError(undefined);
    try {
      const results: MutationResult[] = [];
      for (const index of [...selected].sort()) {
        const preview = current.previews[index];
        if (preview?.plan === undefined) continue;
        const token = preview.plan.diff.confirmationRequired
          ? await confirm(preview.plan)
          : undefined;
        results.push(await current.apply(preview.plan, token));
      }
      onApplied(results);
    } catch (caught) {
      if (
        caught instanceof BridgeError &&
        caught.code === "REVISION_CONFLICT"
      ) {
        setError(
          "Revision conflict: the source changed. Re-open it and build a new diff.",
        );
      } else {
        setError("The selected mutation could not be applied.");
      }
    } finally {
      setApplying(false);
    }
  }

  return (
    <section className="screen diff-screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">04 / Change proof</p>
          <h1>Review before write</h1>
        </div>
        <span className="risk-stamp">
          {current.previews.some(
            (preview) => preview.diff?.riskLevel === "high",
          )
            ? "HIGH RISK"
            : "REVIEW"}
        </span>
      </header>
      {error ? <p className="inline-error conflict-state">{error}</p> : null}
      <div className="diff-stack">
        {current.previews.map((preview, index) => (
          <article className="diff-card" key={preview.operationId}>
            <header>
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(index)}
                  onChange={() => toggle(index)}
                  aria-label={`Apply ${preview.diff?.path ?? index}`}
                />
                <strong>{preview.diff?.path}</strong>
              </label>
              <span>
                +{preview.diff?.additions ?? 0} / -
                {preview.diff?.deletions ?? 0}
              </span>
            </header>
            <div className="diff-meta">
              <code>
                current {preview.diff?.originalRevision?.slice(7, 19) ?? "new"}
              </code>
              <code>
                proposed {preview.diff?.proposedRevision.slice(7, 19)}
              </code>
              <span>{preview.diff?.changedSections.join(", ")}</span>
            </div>
            <pre className="unified-diff">
              {(preview.diff?.unifiedDiff ?? "")
                .split("\n")
                .map((line, lineIndex) => (
                  <span
                    className={
                      line.startsWith("+") && !line.startsWith("+++")
                        ? "addition"
                        : line.startsWith("-") && !line.startsWith("---")
                          ? "deletion"
                          : "context"
                    }
                    key={`${lineIndex}-${line}`}
                  >
                    {line || " "}
                  </span>
                ))}
            </pre>
          </article>
        ))}
      </div>
      <footer className="diff-actions">
        <button
          className="button primary"
          disabled={selected.size === 0 || applying}
          onClick={() => void applySelected()}
        >
          {applying ? "Applying..." : count > 1 ? "Apply selected" : "Apply"}
        </button>
        <button className="button ghost" onClick={onEdit}>
          Edit proposal
        </button>
        <button className="button ghost" onClick={onCancel}>
          Cancel
        </button>
        {count > 1 ? (
          <span>Nothing is selected by default for a batch.</span>
        ) : null}
      </footer>
    </section>
  );
}
