import { describe, expect, it } from "vitest";

import { VaultPermissions, normalizeVaultPath } from "../src/permissions.js";

function policy(): VaultPermissions {
  return new VaultPermissions({
    allowedRoots: ["Projects"],
    excludedRoots: ["Projects/Private"],
    scopes: ["notes.read", "notes.move"],
  });
}

describe("VaultPermissions", () => {
  it.each([
    "../secret.md",
    "Projects/../secret.md",
    "/Projects/note.md",
    "C:\\Projects\\note.md",
    "\\\\server\\share\\note.md",
    "Projects/%2e%2e/secret.md",
    "Projects/%252e%252e/secret.md",
  ])(
    "rejects traversal, absolute, Windows, UNC, and encoded path %s",
    (path) => {
      expect(() => normalizeVaultPath(path)).toThrow();
    },
  );

  it.each([
    ".obsidian/config",
    ".OBSIDIAN/plugins/example/main.js",
    "Projects/.ObSiDiAn/workspace.json",
  ])("blocks .obsidian case-insensitively at any depth", (path) => {
    const rootPolicy = new VaultPermissions({
      allowedRoots: ["."],
      excludedRoots: [],
      scopes: ["notes.read"],
    });
    expect(() => rootPolicy.assertPath(path)).toThrow(/configuration/i);
  });

  it("uses segment comparisons instead of prefix comparisons", () => {
    expect(policy().assertPath("Projects/note.md")).toBe("Projects/note.md");
    expect(() => policy().assertPath("Projects-Archive/note.md")).toThrow(
      /outside the allowed roots/i,
    );
  });

  it("applies exclusions to a destination path", () => {
    expect(() => policy().assertPath("Projects/Private/moved.md")).toThrow(
      /excluded/i,
    );
    expect(policy().assertPath("Projects/Public/moved.md")).toBe(
      "Projects/Public/moved.md",
    );
  });
});
