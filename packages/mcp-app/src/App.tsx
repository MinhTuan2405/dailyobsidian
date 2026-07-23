import { useEffect, useState } from "react";

import type {
  MutationPlan,
  MutationResult,
  NoteDocument,
  Task,
  VaultInfo,
} from "@obsidian-workbench/shared";

import type { WorkbenchBridge } from "./bridge/workbench-bridge.js";
import { StatusPanel } from "./components/StatusPanel.js";
import { CaptureForm, type CaptureProposal } from "./screens/CaptureForm.js";
import { DiffConfirmation } from "./screens/DiffConfirmation.js";
import { MaintenanceReport } from "./screens/MaintenanceReport.js";
import { NoteViewer } from "./screens/NoteViewer.js";
import { SearchBrowser } from "./screens/SearchBrowser.js";
import { TaskDashboard } from "./screens/TaskDashboard.js";
import { VaultSelector } from "./screens/VaultSelector.js";
import type { PendingMutation, ScreenId } from "./state/types.js";

const NAVIGATION: Array<{ id: ScreenId; label: string; mark: string }> = [
  { id: "vault", label: "Vault", mark: "V" },
  { id: "search", label: "Search", mark: "S" },
  { id: "note", label: "Note", mark: "N" },
  { id: "diff", label: "Diff", mark: "D" },
  { id: "capture", label: "Capture", mark: "C" },
  { id: "tasks", label: "Tasks", mark: "T" },
  { id: "maintenance", label: "Maintain", mark: "M" },
];

function operationKey(prefix: string): string {
  const random =
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}

export function WorkbenchApp({ bridge }: { bridge: WorkbenchBridge }) {
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  const [selectedVaultId, setSelectedVaultId] = useState<string>();
  const [screen, setScreen] = useState<ScreenId>("vault");
  const [openNote, setOpenNote] = useState<NoteDocument>();
  const [pending, setPending] = useState<PendingMutation>();
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setOffline(false);
    void bridge
      .listVaults()
      .then((available) => {
        if (!current) return;
        setVaults(available);
        setSelectedVaultId((selected) => selected ?? available[0]?.vaultId);
        setLoading(false);
      })
      .catch(() => {
        if (!current) return;
        setOffline(true);
        setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [bridge, reload]);

  const selectedVault = vaults.find(
    (vault) => vault.vaultId === selectedVaultId,
  );

  async function previewNoteUpdate(document: NoteDocument, markdown: string) {
    if (markdown === (document.content ?? "")) return;
    const request = {
      vaultId: document.identity.vaultId,
      noteId: document.identity.noteId,
      expectedRevision: document.identity.revision,
      operation: { type: "replace_document" as const, content: markdown },
      idempotencyKey: operationKey("note-update"),
    };
    const preview = await bridge.updateNote({ ...request, dryRun: true });
    setPending({
      previews: [preview],
      editScreen: "note",
      apply: async (_plan: MutationPlan, confirmationToken?: string) =>
        await bridge.updateNote({
          ...request,
          dryRun: false,
          ...(confirmationToken ? { confirmationToken } : {}),
        }),
    });
    setScreen("diff");
  }

  async function previewCapture(proposal: CaptureProposal) {
    if (!selectedVaultId) return;
    const request = {
      vaultId: selectedVaultId,
      path: proposal.path,
      content: proposal.content,
      frontmatter: {
        title: proposal.title,
        ...(proposal.tags.length > 0 ? { tags: proposal.tags } : {}),
        ...(proposal.sourceUrl ? { source: proposal.sourceUrl } : {}),
      },
      createFolders: true,
      idempotencyKey: operationKey("capture"),
    };
    const preview = await bridge.createNote({ ...request, dryRun: true });
    setPending({
      previews: [preview],
      editScreen: "capture",
      apply: async (_plan: MutationPlan, confirmationToken?: string) =>
        await bridge.createNote({
          ...request,
          dryRun: false,
          ...(confirmationToken ? { confirmationToken } : {}),
        }),
    });
    setScreen("diff");
  }

  async function previewTaskToggle(task: Task) {
    const document = await bridge.getNote(task.vaultId, task.noteId);
    const request = {
      vaultId: task.vaultId,
      taskId: task.taskId,
      expectedRevision: document.identity.revision,
      status:
        task.status === "completed"
          ? ("open" as const)
          : ("completed" as const),
      idempotencyKey: operationKey("task-update"),
    };
    const preview = await bridge.updateTask({ ...request, dryRun: true });
    setPending({
      previews: [preview],
      editScreen: "tasks",
      apply: async (_plan: MutationPlan, confirmationToken?: string) =>
        await bridge.updateTask({
          ...request,
          dryRun: false,
          ...(confirmationToken ? { confirmationToken } : {}),
        }),
    });
    setScreen("diff");
  }

  async function applied(results: MutationResult[]) {
    const last = results.at(-1);
    setPending(undefined);
    if (last?.note !== undefined && last.note.path.endsWith(".md")) {
      try {
        setOpenNote(await bridge.getNote(last.note.vaultId, last.note.noteId));
        setScreen("note");
        return;
      } catch {
        // A create can be followed from search if the host has a stale read cache.
      }
    }
    setScreen("search");
  }

  if (loading) {
    return (
      <main className="connection-stage">
        <StatusPanel
          title="Opening the workbench"
          message="Negotiating a typed, vault-scoped MCP connection."
        />
      </main>
    );
  }

  if (offline) {
    return (
      <main className="connection-stage">
        <StatusPanel
          title="Vault bridge offline"
          message="No note data was loaded. Reconnect the local server or companion, then retry."
          action={{
            label: "Retry connection",
            onClick: () => setReload((value) => value + 1),
          }}
        />
      </main>
    );
  }

  return (
    <div className="workbench-shell">
      <aside className="rail">
        <div className="wordmark">
          <span>OW</span>
          <div>
            <strong>Obsidian</strong>
            <small>Workbench</small>
          </div>
        </div>
        <nav aria-label="Workbench screens">
          {NAVIGATION.map((item) => (
            <button
              key={item.id}
              className={screen === item.id ? "active" : ""}
              onClick={() => setScreen(item.id)}
              aria-current={screen === item.id ? "page" : undefined}
            >
              <span>{item.mark}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="active-vault">
          <span
            className={`signal ${selectedVault?.status.state ?? "offline"}`}
          />
          <div>
            <small>Active vault</small>
            <strong>{selectedVault?.name ?? "None"}</strong>
          </div>
        </div>
      </aside>
      <main className="workspace">
        {screen === "vault" ? (
          <VaultSelector
            vaults={vaults}
            selectedVaultId={selectedVaultId}
            onSelect={(vaultId) => {
              setSelectedVaultId(vaultId);
              setOpenNote(undefined);
            }}
          />
        ) : null}
        {screen === "search" && selectedVaultId ? (
          <SearchBrowser
            bridge={bridge}
            vaultId={selectedVaultId}
            onOpen={(document) => {
              setOpenNote(document);
              setScreen("note");
            }}
          />
        ) : null}
        {screen === "note" ? (
          <NoteViewer document={openNote} onPreviewDiff={previewNoteUpdate} />
        ) : null}
        {screen === "diff" ? (
          <DiffConfirmation
            pending={pending}
            confirm={(plan) => bridge.confirmMutation(plan)}
            onApplied={(results) => void applied(results)}
            onEdit={() => setScreen(pending?.editScreen ?? "search")}
            onCancel={() => {
              setPending(undefined);
              setScreen("search");
            }}
          />
        ) : null}
        {screen === "capture" && selectedVault ? (
          <CaptureForm
            inboxFolder={selectedVault.conventions.inboxFolder}
            onPreview={previewCapture}
          />
        ) : null}
        {screen === "tasks" && selectedVaultId ? (
          <TaskDashboard
            bridge={bridge}
            vaultId={selectedVaultId}
            onToggle={previewTaskToggle}
          />
        ) : null}
        {screen === "maintenance" && selectedVaultId ? (
          <MaintenanceReport bridge={bridge} vaultId={selectedVaultId} />
        ) : null}
      </main>
    </div>
  );
}
