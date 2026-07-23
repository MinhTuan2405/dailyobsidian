import { describe, expect, it } from "vitest";

import {
  NoteIdentitySchema,
  MutationResultSchema,
  RevisionConflictSchema,
  ToolErrorSchema,
  VaultInfoSchema,
  toToolError,
} from "../src/index.js";

const revision = `sha256:${"a".repeat(64)}`;

describe("shared contracts", () => {
  it("requires stable note identity fields and a SHA-256 revision", () => {
    expect(
      NoteIdentitySchema.parse({
        noteId: "note-1",
        vaultId: "vault-1",
        path: "Projects/example.md",
        title: "Example",
        revision,
      }),
    ).toMatchObject({ noteId: "note-1", revision });

    expect(() =>
      NoteIdentitySchema.parse({
        noteId: "note-1",
        vaultId: "vault-1",
        path: "Example.md",
        title: "Example",
        revision: "stale",
      }),
    ).toThrow();
  });

  it("validates vault permission scopes", () => {
    expect(
      VaultInfoSchema.parse({
        vaultId: "vault-1",
        name: "Fixture",
        status: { state: "online", mode: "filesystem" },
        capabilities: {
          scopes: ["vault.metadata.read", "notes.read"],
          supportsTrash: true,
          supportsFileManagerMoves: false,
          supportsEvents: false,
          supportsOpenInObsidian: true,
        },
        allowedRoots: ["Notes"],
        excludedRoots: ["Private"],
        conventions: {},
      }).capabilities.scopes,
    ).toEqual(["vault.metadata.read", "notes.read"]);
  });

  it("models recoverable revision conflicts", () => {
    expect(
      RevisionConflictSchema.parse({
        error: {
          code: "REVISION_CONFLICT",
          message: "The note changed after it was read.",
          recoverable: true,
          details: { expectedRevision: revision, currentRevision: revision },
        },
      }).error.recoverable,
    ).toBe(true);
  });

  it("does not expose unknown exception details", () => {
    const error = toToolError(new Error("secret stack or token"));
    expect(ToolErrorSchema.parse(error)).toEqual({
      code: "INTERNAL_ERROR",
      message: "An internal error occurred.",
      recoverable: false,
    });
  });

  it("carries mutation plans and both deterministic hashes in previews", () => {
    const plan = {
      mutationId: "mutation-1",
      vaultId: "vault-1",
      targetPath: "Notes/example.md",
      operation: "append",
      requestHash: `sha256:${"b".repeat(64)}`,
      mutationHash: `sha256:${"c".repeat(64)}`,
      diff: {
        path: "Notes/example.md",
        originalRevision: revision,
        proposedRevision: `sha256:${"d".repeat(64)}`,
        unifiedDiff: "diff",
        changedSections: ["document"],
        additions: 1,
        deletions: 0,
        riskLevel: "low" as const,
        confirmationRequired: false,
      },
      expiresAt: "2026-07-23T12:05:00.000Z",
    };
    expect(
      MutationResultSchema.parse({
        operationId: "mutation-1",
        status: "preview",
        diff: plan.diff,
        plan,
        idempotentReplay: false,
      }).plan?.mutationHash,
    ).toBe(plan.mutationHash);
  });
});
