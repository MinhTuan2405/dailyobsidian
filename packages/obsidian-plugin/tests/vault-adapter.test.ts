import type { App, TFile } from "obsidian";
import { describe, expect, it } from "vitest";

import { createRevision } from "../src/hash.js";
import { StableNoteIds } from "../src/note-ids.js";
import { defaultSettings } from "../src/settings-data.js";
import { ObsidianVaultAdapter } from "../src/vault-adapter.js";

interface FakeFile extends TFile {
  path: string;
  basename: string;
  extension: string;
  stat: { ctime: number; mtime: number; size: number };
}

function fakeFile(path: string, content: string): FakeFile {
  return {
    path,
    basename: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, ""),
    extension: "md",
    stat: {
      ctime: 1_700_000_000_000,
      mtime: 1_700_000_000_000,
      size: content.length,
    },
  } as FakeFile;
}

function setup() {
  const initial = "# Note\n\nOriginal";
  const file = fakeFile("Notes/a.md", initial);
  const contents = new Map<string, string>([[file.path, initial]]);
  let processCalls = 0;
  const vault = {
    getName: () => "Test vault",
    getMarkdownFiles: () => [file],
    getAbstractFileByPath: (path: string) => (path === file.path ? file : null),
    cachedRead: async (target: FakeFile) => contents.get(target.path) ?? "",
    read: async (target: FakeFile) => contents.get(target.path) ?? "",
    process: async (target: FakeFile, change: (value: string) => string) => {
      processCalls += 1;
      const next = change(contents.get(target.path) ?? "");
      contents.set(target.path, next);
      target.stat.mtime += 1;
    },
    create: async () => file,
    createFolder: async () => undefined,
    trash: async () => undefined,
  };
  const app = {
    vault,
    metadataCache: {
      getFileCache: () => null,
      getFirstLinkpathDest: () => null,
    },
    fileManager: { renameFile: async () => undefined },
  } as unknown as App;
  const settings = defaultSettings();
  settings.vaultId = "vault-1";
  settings.allowedRoots = ["Notes"];
  settings.enabledScopes = ["notes.read", "notes.update"];
  const noteIds = new StableNoteIds(settings.noteIds, () => undefined);
  const adapter = new ObsidianVaultAdapter({
    app,
    settings: () => settings,
    noteIds,
    connectionState: () => "online",
  });
  return { adapter, contents, initial, getProcessCalls: () => processCalls };
}

describe("ObsidianVaultAdapter mutations", () => {
  it("creates standard SHA-256 content revisions", () => {
    expect(createRevision("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("checks expected revisions and replays an applied idempotent mutation", async () => {
    const { adapter, contents, initial, getProcessCalls } = setup();
    const listed = await adapter.listNotes({ vaultId: "vault-1", limit: 10 });
    const note = listed.items[0];
    expect(note).toBeDefined();
    const input = {
      vaultId: "vault-1",
      noteId: note?.noteId ?? "",
      expectedRevision: createRevision(initial),
      content: "\nAdded",
      idempotencyKey: "append-key-1",
      dryRun: false,
    };
    const applied = await adapter.appendToNote(input);
    const replay = await adapter.appendToNote(input);
    expect(applied.status).toBe("applied");
    expect(replay.idempotentReplay).toBe(true);
    expect(getProcessCalls()).toBe(1);
    expect(contents.get("Notes/a.md")).toContain("Added");

    await expect(
      adapter.appendToNote({ ...input, content: "different" }),
    ).rejects.toMatchObject({ toolError: { code: "IDEMPOTENCY_CONFLICT" } });

    await expect(
      adapter.appendToNote({
        ...input,
        content: "different",
        idempotencyKey: "append-key-2",
      }),
    ).rejects.toMatchObject({ toolError: { code: "REVISION_CONFLICT" } });
    expect(getProcessCalls()).toBe(1);
  });

  it("returns a schema-valid dry-run diff without writing", async () => {
    const { adapter, initial, getProcessCalls } = setup();
    const note = (await adapter.listNotes({ vaultId: "vault-1", limit: 10 }))
      .items[0];
    const preview = await adapter.updateNote({
      vaultId: "vault-1",
      noteId: note?.noteId ?? "",
      expectedRevision: createRevision(initial),
      operation: {
        type: "replace_range",
        start: 8,
        end: 16,
        content: "Preview",
      },
      idempotencyKey: "preview-key-1",
      dryRun: true,
    });
    expect(preview.status).toBe("preview");
    expect(preview.diff?.unifiedDiff).toContain("Preview");
    expect(preview.plan?.diff.proposedRevision).toBe(
      preview.diff?.proposedRevision,
    );
    expect(getProcessCalls()).toBe(0);
  });
});
