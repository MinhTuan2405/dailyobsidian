import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  MutationPlan,
  MutationResult,
  PermissionScope,
} from "@obsidian-workbench/shared";
import { createPatch } from "diff";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FilesystemVaultAdapter } from "../src/index.js";

const WRITE_SCOPES: readonly PermissionScope[] = [
  "vault.metadata.read",
  "notes.read",
  "notes.create",
  "notes.update",
  "notes.move",
  "notes.trash",
  "tasks.read",
  "tasks.create",
  "tasks.update",
];

const FIXTURE = `---
keep: yes
remove: old
---
# Alpha
Body line
## Tasks
- [ ] Existing task 📅 2026-07-24 ^existing-task
# Omega
End
`;

let root: string;
let outside: string;
let now: number;
let adapter: FilesystemVaultAdapter;
let keyNumber: number;

function key(): string {
  keyNumber += 1;
  return `write-key-${keyNumber.toString().padStart(4, "0")}`;
}

async function writeNote(relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

async function file(relativePath: string): Promise<string> {
  return await readFile(path.join(root, ...relativePath.split("/")), "utf8");
}

async function alpha() {
  const listed = await adapter.listNotes({ vaultId: "write-vault" });
  const identity = listed.items.find((note) => note.path === "Notes/Alpha.md");
  if (identity === undefined) throw new Error("Fixture note was not indexed");
  return identity;
}

function requirePlan(result: MutationResult): MutationPlan {
  if (result.plan === undefined)
    throw new Error("Mutation plan was not returned");
  return result.plan;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "workbench-writes-"));
  outside = await mkdtemp(path.join(tmpdir(), "workbench-writes-outside-"));
  now = Date.parse("2026-07-23T12:00:00.000Z");
  keyNumber = 0;
  await writeNote("Notes/Alpha.md", FIXTURE);
  await mkdir(path.join(root, "Notes", "Excluded"), { recursive: true });
  adapter = new FilesystemVaultAdapter({
    vaultId: "write-vault",
    rootPath: root,
    allowedRoots: ["Notes"],
    excludedRoots: ["Notes/Excluded"],
    scopes: WRITE_SCOPES,
    localUserId: "local-user",
    confirmation: { secret: "test-confirmation-secret", now: () => now },
    now: () => now,
  });
});

afterEach(async () => {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]);
});

describe("filesystem mutations", () => {
  it("returns a complete dry-run plan without modifying the note", async () => {
    const note = await alpha();
    const before = await file(note.path);
    const result = await adapter.appendToNote({
      vaultId: "write-vault",
      noteId: note.noteId,
      expectedRevision: note.revision,
      content: "Preview only",
      idempotencyKey: key(),
      dryRun: true,
    });

    expect(await file(note.path)).toBe(before);
    expect(result).toMatchObject({
      status: "preview",
      idempotentReplay: false,
      diff: {
        originalRevision: note.revision,
        additions: 1,
        confirmationRequired: false,
      },
      plan: {
        requestHash: expect.stringMatching(/^sha256:/),
        mutationHash: expect.stringMatching(/^sha256:/),
      },
    });
    expect(result.diff?.proposedRevision).not.toBe(note.revision);
    expect(result.diff?.unifiedDiff).toContain("Preview only");
  });

  it("creates markdown notes with optional folders and rejects duplicates", async () => {
    const created = await adapter.createNote({
      vaultId: "write-vault",
      path: "Notes/New/Nested.md",
      content: "# Nested\r\nBody\r\n",
      frontmatter: { kind: "test" },
      createFolders: true,
      idempotencyKey: key(),
      dryRun: false,
    });

    expect(created.note).toMatchObject({ path: "Notes/New/Nested.md" });
    expect(await file("Notes/New/Nested.md")).toBe(
      "---\nkind: test\n---\n# Nested\nBody\n",
    );
    await expect(
      adapter.createNote({
        vaultId: "write-vault",
        path: "Notes/New/Nested.md",
        idempotencyKey: key(),
        dryRun: false,
      }),
    ).rejects.toMatchObject({ toolError: { code: "VALIDATION_ERROR" } });
  });

  it("appends at the end or directly under a heading", async () => {
    const note = await alpha();
    await adapter.appendToNote({
      vaultId: "write-vault",
      noteId: note.noteId,
      expectedRevision: note.revision,
      heading: "Alpha",
      content: "Under alpha",
      idempotencyKey: key(),
      dryRun: false,
    });
    const refreshed = await alpha();
    await adapter.appendToNote({
      vaultId: "write-vault",
      noteId: refreshed.noteId,
      expectedRevision: refreshed.revision,
      content: "At end\r\n",
      idempotencyKey: key(),
      dryRun: false,
    });

    const content = await file(note.path);
    expect(content.indexOf("Under alpha")).toBeLessThan(
      content.indexOf("# Omega"),
    );
    expect(content).toMatch(/At end\n$/);
    expect(content).not.toContain("\r");
  });

  it("sets and removes frontmatter while preserving unrelated YAML and body", async () => {
    const note = await alpha();
    await adapter.setFrontmatter({
      vaultId: "write-vault",
      noteId: note.noteId,
      expectedRevision: note.revision,
      set: { added: ["one", "two"] },
      remove: ["remove"],
      idempotencyKey: key(),
      dryRun: false,
    });

    const content = await file(note.path);
    expect(content).toContain("keep: yes");
    expect(content).toContain("added:");
    expect(content).not.toContain("remove: old");
    expect(content).toContain("# Alpha\nBody line");
  });

  it.each(["replace_range", "replace_section", "apply_patch"] as const)(
    "applies the explicit %s operation",
    async (operationType) => {
      const note = await alpha();
      const original = await file(note.path);
      const operation =
        operationType === "replace_range"
          ? {
              type: operationType,
              start: original.indexOf("Body line"),
              end: original.indexOf("Body line") + "Body line".length,
              content: "Range body",
            }
          : operationType === "replace_section"
            ? {
                type: operationType,
                heading: "Alpha",
                content: "Section body\n",
              }
            : {
                type: operationType,
                patch: createPatch(
                  note.path,
                  original,
                  original.replace("Body line", "Patch body"),
                ),
              };
      await adapter.updateNote({
        vaultId: "write-vault",
        noteId: note.noteId,
        expectedRevision: note.revision,
        operation,
        idempotencyKey: key(),
        dryRun: false,
      });

      const content = await file(note.path);
      expect(content).toContain(
        operationType === "replace_range"
          ? "Range body"
          : operationType === "replace_section"
            ? "Section body"
            : "Patch body",
      );
      if (operationType === "replace_section") {
        expect(content).toContain("# Alpha\nSection body\n# Omega");
      }
    },
  );

  it("requires a bound confirmation for replace_document", async () => {
    const note = await alpha();
    const request = {
      vaultId: "write-vault",
      noteId: note.noteId,
      expectedRevision: note.revision,
      operation: { type: "replace_document" as const, content: "# Replaced\n" },
      idempotencyKey: key(),
    };
    const preview = await adapter.updateNote({ ...request, dryRun: true });
    expect(preview.diff?.confirmationRequired).toBe(true);
    await expect(
      adapter.updateNote({ ...request, dryRun: false }),
    ).rejects.toMatchObject({ toolError: { code: "CONFIRMATION_REQUIRED" } });

    const token = adapter.confirmations.issueFromPlan(
      requirePlan(preview),
      "local-user",
    );
    await adapter.updateNote({
      ...request,
      dryRun: false,
      confirmationToken: token,
    });
    expect(await file(note.path)).toBe("# Replaced\n");
  });

  it("returns structured stale-revision conflicts without retrying", async () => {
    const note = await alpha();
    await writeNote(note.path, `${FIXTURE}External change\n`);

    await expect(
      adapter.appendToNote({
        vaultId: "write-vault",
        noteId: note.noteId,
        expectedRevision: note.revision,
        content: "Must not apply",
        idempotencyKey: key(),
        dryRun: false,
      }),
    ).rejects.toMatchObject({
      toolError: {
        code: "REVISION_CONFLICT",
        recoverable: true,
        details: {
          expectedRevision: note.revision,
          currentRevision: expect.stringMatching(/^sha256:/),
        },
      },
    });
    expect(await file(note.path)).not.toContain("Must not apply");
  });

  it("replays identical idempotent writes and rejects a changed payload", async () => {
    const note = await alpha();
    const idempotencyKey = key();
    const request = {
      vaultId: "write-vault",
      noteId: note.noteId,
      expectedRevision: note.revision,
      content: "Exactly once",
      idempotencyKey,
      dryRun: false,
    };
    const first = await adapter.appendToNote(request);
    const replay = await adapter.appendToNote(request);
    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect((await file(note.path)).match(/Exactly once/g)).toHaveLength(1);

    await expect(
      adapter.appendToNote({ ...request, content: "Different payload" }),
    ).rejects.toMatchObject({
      toolError: { code: "IDEMPOTENCY_CONFLICT" },
    });
  });

  it("binds confirmation tokens, expires them, and prevents replay", async () => {
    const note = await alpha();
    const preview = await adapter.trashNote({
      vaultId: "write-vault",
      noteId: note.noteId,
      expectedRevision: note.revision,
      idempotencyKey: key(),
      dryRun: true,
    });
    const plan = requirePlan(preview);
    const token = adapter.confirmations.issueFromPlan(plan, "local-user", 1000);
    expect(() =>
      adapter.confirmations.consume(token, {
        userId: "different-user",
        vaultId: plan.vaultId,
        targetPath: plan.targetPath,
        mutationHash: plan.mutationHash,
      }),
    ).toThrowError(
      expect.objectContaining({
        toolError: expect.objectContaining({ code: "CONFIRMATION_REQUIRED" }),
      }),
    );
    adapter.confirmations.consume(token, {
      userId: "local-user",
      vaultId: plan.vaultId,
      targetPath: plan.targetPath,
      mutationHash: plan.mutationHash,
    });
    expect(() =>
      adapter.confirmations.consume(token, {
        userId: "local-user",
        vaultId: plan.vaultId,
        targetPath: plan.targetPath,
        mutationHash: plan.mutationHash,
      }),
    ).toThrowError(
      expect.objectContaining({
        toolError: expect.objectContaining({ code: "CONFIRMATION_REQUIRED" }),
      }),
    );

    const expiring = adapter.confirmations.issueFromPlan(
      plan,
      "local-user",
      10,
    );
    now += 11;
    expect(() =>
      adapter.confirmations.consume(expiring, {
        userId: "local-user",
        vaultId: plan.vaultId,
        targetPath: plan.targetPath,
        mutationHash: plan.mutationHash,
      }),
    ).toThrowError(
      expect.objectContaining({
        toolError: expect.objectContaining({ code: "CONFIRMATION_REQUIRED" }),
      }),
    );
  });

  it("denies moves into excluded roots before confirmation", async () => {
    const note = await alpha();
    await expect(
      adapter.moveNote({
        vaultId: "write-vault",
        noteId: note.noteId,
        expectedRevision: note.revision,
        destinationPath: "Notes/Excluded/Alpha.md",
        idempotencyKey: key(),
        dryRun: true,
      }),
    ).rejects.toMatchObject({ toolError: { code: "PATH_NOT_ALLOWED" } });
    expect(await file(note.path)).toBe(FIXTURE);
  });

  it("moves only with confirmation and preserves content and revision", async () => {
    const note = await alpha();
    const request = {
      vaultId: "write-vault",
      noteId: note.noteId,
      expectedRevision: note.revision,
      destinationPath: "Notes/Moved.md",
      idempotencyKey: key(),
    };
    const preview = await adapter.moveNote({ ...request, dryRun: true });
    const token = adapter.confirmations.issueFromPlan(
      requirePlan(preview),
      "local-user",
    );
    const moved = await adapter.moveNote({
      ...request,
      dryRun: false,
      confirmationToken: token,
    });

    await expect(
      access(path.join(root, "Notes", "Alpha.md")),
    ).rejects.toThrow();
    expect(await file("Notes/Moved.md")).toBe(FIXTURE);
    expect(moved.note).toMatchObject({
      noteId: note.noteId,
      path: "Notes/Moved.md",
      revision: note.revision,
    });
  });

  it("trashes by moving to a non-indexed suffix and never hard deletes", async () => {
    const note = await alpha();
    const request = {
      vaultId: "write-vault",
      noteId: note.noteId,
      expectedRevision: note.revision,
      idempotencyKey: key(),
    };
    const preview = await adapter.trashNote({ ...request, dryRun: true });
    expect(preview.plan?.targetPath).toMatch(/\.trashed$/);
    await expect(
      adapter.trashNote({ ...request, dryRun: false }),
    ).rejects.toMatchObject({ toolError: { code: "CONFIRMATION_REQUIRED" } });
    const plan = requirePlan(preview);
    const token = adapter.confirmations.issueFromPlan(plan, "local-user");
    await adapter.trashNote({
      ...request,
      dryRun: false,
      confirmationToken: token,
    });

    await expect(
      access(path.join(root, "Notes", "Alpha.md")),
    ).rejects.toThrow();
    expect(await file(plan.targetPath)).toBe(FIXTURE);
    expect(
      (await adapter.listNotes({ vaultId: "write-vault" })).items,
    ).toHaveLength(0);
  });

  it("creates tasks safely and updates task status, text, and due date", async () => {
    const note = await alpha();
    await adapter.createTask({
      vaultId: "write-vault",
      noteId: note.noteId,
      expectedRevision: note.revision,
      text: "Created task",
      heading: "Tasks",
      dueDate: "2026-08-01",
      idempotencyKey: key(),
      dryRun: false,
    });
    const refreshed = await alpha();
    const existing = (
      await adapter.listTasks({ vaultId: "write-vault", noteId: note.noteId })
    ).items.find((task) => task.blockId === "existing-task");
    expect(existing).toBeDefined();
    if (existing === undefined) throw new Error("Fixture task was not indexed");
    await adapter.updateTask({
      vaultId: "write-vault",
      taskId: existing.taskId,
      expectedRevision: refreshed.revision,
      status: "completed",
      text: "Updated task",
      dueDate: null,
      idempotencyKey: key(),
      dryRun: false,
    });

    const content = await file(note.path);
    expect(content).toContain("- [ ] Created task 📅 2026-08-01");
    expect(content).toContain("- [x] Updated task ^existing-task");
    expect(content).not.toContain("Updated task 📅");
  });

  it("denies operations outside configured scopes", async () => {
    const readOnly = new FilesystemVaultAdapter({
      vaultId: "write-vault",
      rootPath: root,
      allowedRoots: ["Notes"],
    });
    await expect(
      readOnly.createNote({
        vaultId: "write-vault",
        path: "Notes/Denied.md",
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ toolError: { code: "PERMISSION_DENIED" } });
    expect((await readOnly.getVaultInfo()).capabilities).toMatchObject({
      scopes: ["vault.metadata.read", "notes.read", "tasks.read"],
      supportsTrash: false,
    });

    const notesOnly = new FilesystemVaultAdapter({
      vaultId: "write-vault",
      rootPath: root,
      allowedRoots: ["Notes"],
      scopes: ["notes.read"],
    });
    await expect(notesOnly.getVaultInfo()).rejects.toMatchObject({
      toolError: { code: "PERMISSION_DENIED" },
    });
    await expect(
      notesOnly.listTasks({ vaultId: "write-vault" }),
    ).rejects.toMatchObject({ toolError: { code: "PERMISSION_DENIED" } });

    expect((await adapter.getVaultInfo()).capabilities).toMatchObject({
      scopes: WRITE_SCOPES,
      supportsTrash: true,
    });
  });

  it("blocks nonexistent destinations below a symlink escape", async () => {
    await symlink(
      outside,
      path.join(root, "Notes", "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      adapter.createNote({
        vaultId: "write-vault",
        path: "Notes/escape/new/deep.md",
        createFolders: true,
        idempotencyKey: key(),
        dryRun: true,
      }),
    ).rejects.toMatchObject({
      toolError: { code: "SYMLINK_ESCAPE_BLOCKED" },
    });
    await expect(
      access(path.join(outside, "new", "deep.md")),
    ).rejects.toThrow();
  });
});
