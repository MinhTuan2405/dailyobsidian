import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  MutationPlan,
  MutationResult,
  NoteSummary,
  VaultInfo,
} from "@obsidian-workbench/shared";

import { WorkbenchApp } from "../src/App.js";
import {
  BridgeError,
  type WorkbenchBridge,
} from "../src/bridge/workbench-bridge.js";
import { CaptureForm } from "../src/screens/CaptureForm.js";
import { DiffConfirmation } from "../src/screens/DiffConfirmation.js";
import { SearchBrowser } from "../src/screens/SearchBrowser.js";
import type { PendingMutation } from "../src/state/types.js";

const revision = `sha256:${"a".repeat(64)}`;

const vault: VaultInfo = {
  vaultId: "vault-1",
  name: "Field Notes",
  status: { state: "online", mode: "filesystem" },
  capabilities: {
    scopes: ["vault.metadata.read", "notes.read", "notes.create"],
    supportsTrash: false,
    supportsFileManagerMoves: false,
    supportsEvents: false,
    supportsOpenInObsidian: false,
  },
  allowedRoots: ["Notes"],
  excludedRoots: [".obsidian"],
  conventions: {
    inboxFolder: "Notes/Inbox",
    dailyNotesFolder: "Daily",
    dailyNoteFormat: "YYYY-MM-DD",
    dateFormat: "YYYY-MM-DD",
    templatePaths: [],
    taskSyntax: "- [ ]",
    preferredLinkStyle: "wikilink",
    defaultFrontmatter: {},
  },
};

const note: NoteSummary = {
  noteId: "note-1",
  vaultId: "vault-1",
  path: "Notes/Alpha.md",
  title: "Alpha",
  revision,
  createdAt: "2026-07-23T10:00:00.000Z",
  modifiedAt: "2026-07-23T10:00:00.000Z",
  tags: [],
};

function bridge(overrides: Partial<WorkbenchBridge> = {}): WorkbenchBridge {
  return {
    listVaults: vi.fn().mockResolvedValue([vault]),
    listNotes: vi.fn().mockResolvedValue([note]),
    searchNotes: vi.fn().mockResolvedValue({ hits: [], total: 0 }),
    getNote: vi.fn().mockRejectedValue(new Error("not used")),
    listTasks: vi.fn().mockResolvedValue([]),
    findOrphans: vi.fn().mockResolvedValue([]),
    createNote: vi.fn().mockRejectedValue(new Error("not used")),
    updateNote: vi.fn().mockRejectedValue(new Error("not used")),
    updateTask: vi.fn().mockRejectedValue(new Error("not used")),
    confirmMutation: vi.fn().mockResolvedValue("confirmation-token"),
    ...overrides,
  };
}

function mutation(index = 1): MutationResult {
  const plan: MutationPlan = {
    mutationId: `mutation-${index}`,
    vaultId: "vault-1",
    targetNoteId: `note-${index}`,
    targetPath: `Notes/Change-${index}.md`,
    operation: "replace_document",
    requestHash: `sha256:${index.toString(16).repeat(64).slice(0, 64)}`,
    mutationHash: `sha256:${(index + 1).toString(16).repeat(64).slice(0, 64)}`,
    diff: {
      path: `Notes/Change-${index}.md`,
      originalRevision: revision,
      proposedRevision: `sha256:${"b".repeat(64)}`,
      unifiedDiff: "--- old\n+++ new\n-old line\n+new line\n",
      changedSections: ["document"],
      additions: 1,
      deletions: 1,
      riskLevel: "high",
      confirmationRequired: true,
    },
    expiresAt: "2026-07-23T12:05:00.000Z",
  };
  return {
    operationId: plan.mutationId,
    status: "preview",
    diff: plan.diff,
    plan,
    idempotentReplay: false,
  };
}

describe("MCP App UI", () => {
  it("supports search-result selection", async () => {
    render(
      <SearchBrowser bridge={bridge()} vaultId="vault-1" onOpen={vi.fn()} />,
    );
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByLabelText("Select Alpha"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("shows an actionable offline state", async () => {
    render(
      <WorkbenchApp
        bridge={bridge({
          listVaults: vi.fn().mockRejectedValue(new Error("offline")),
        })}
      />,
    );
    expect(await screen.findByText("Vault bridge offline")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry connection" }),
    ).toBeEnabled();
  });

  it("renders a unified diff, confirms, and applies one mutation", async () => {
    const preview = mutation();
    const apply = vi.fn().mockResolvedValue({
      ...preview,
      status: "applied",
    });
    const confirm = vi.fn().mockResolvedValue("token");
    const onApplied = vi.fn();
    const pending: PendingMutation = {
      previews: [preview],
      apply,
      editScreen: "note",
    };
    render(
      <DiffConfirmation
        pending={pending}
        confirm={confirm}
        onApplied={onApplied}
        onEdit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("+new line")).toHaveClass("addition");
    expect(screen.getByText("-old line")).toHaveClass("deletion");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(preview.plan));
    expect(apply).toHaveBeenCalledWith(preview.plan, "token");
    expect(onApplied).toHaveBeenCalled();
  });

  it("shows revision conflicts and permits cancel without applying", async () => {
    const preview = mutation();
    const apply = vi
      .fn()
      .mockRejectedValue(
        new BridgeError("REVISION_CONFLICT", "The note changed."),
      );
    const cancel = vi.fn();
    render(
      <DiffConfirmation
        pending={{ previews: [preview], apply, editScreen: "note" }}
        confirm={vi.fn().mockResolvedValue("token")}
        onApplied={vi.fn()}
        onEdit={vi.fn()}
        onCancel={cancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText(/Revision conflict/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not select apply-all by default for multi-file review", () => {
    render(
      <DiffConfirmation
        pending={{
          previews: [mutation(1), mutation(2)],
          apply: vi.fn(),
          editScreen: "maintenance",
        }}
        confirm={vi.fn()}
        onApplied={vi.fn()}
        onEdit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Apply selected" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Nothing is selected by default for a batch."),
    ).toBeInTheDocument();
  });

  it("validates capture before requesting a preview", () => {
    const onPreview = vi.fn();
    render(<CaptureForm inboxFolder="Inbox" onPreview={onPreview} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview capture" }));
    expect(
      screen.getByText("Title and content are required before preview."),
    ).toBeInTheDocument();
    expect(onPreview).not.toHaveBeenCalled();
  });
});
