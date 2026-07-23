import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PathSecurity,
  normalizeVaultPath,
} from "../src/security/path-security.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("path normalization", () => {
  it.each([
    "../secret.md",
    "folder/../../secret.md",
    "/etc/passwd",
    "C:\\secret.md",
    "C:secret.md",
    "\\\\server\\share\\secret.md",
    "folder\\..\\secret.md",
    "%2e%2e/secret.md",
    "%252e%252e%252fsecret.md",
    "folder/%5c../secret.md",
  ])("rejects unsafe path %s", (candidate) => {
    expect(() => normalizeVaultPath(candidate)).toThrow();
  });

  it("normalizes mixed separators without using string-prefix authorization", () => {
    expect(normalizeVaultPath("Projects\\Alpha.md")).toBe("Projects/Alpha.md");
  });
});

describe("path policy", () => {
  it("enforces allowed roots, excluded roots, and .obsidian case-insensitively", async () => {
    const root = await temporaryDirectory("workbench-policy-");
    await mkdir(path.join(root, "Notes", "Private"), { recursive: true });
    const policy = await PathSecurity.create({
      vaultRoot: root,
      allowedRoots: ["Notes"],
      excludedRoots: ["Notes/Private"],
    });

    expect(policy.assertAuthorizedRelativePath("Notes/Alpha.md")).toBe(
      "Notes/Alpha.md",
    );
    expect(() =>
      policy.assertAuthorizedRelativePath("Notes-private/Alpha.md"),
    ).toThrow();
    expect(() =>
      policy.assertAuthorizedRelativePath("Notes/Private/Secret.md"),
    ).toThrow();
    expect(() =>
      policy.assertAuthorizedRelativePath("Notes/.ObSiDiAn/plugins/x.js"),
    ).toThrow();
  });

  it("blocks a directory symlink or junction that escapes the vault", async () => {
    const root = await temporaryDirectory("workbench-vault-");
    const outside = await temporaryDirectory("workbench-outside-");
    await mkdir(path.join(root, "Notes"), { recursive: true });
    await writeFile(path.join(outside, "secret.md"), "secret", "utf8");
    await symlink(
      outside,
      path.join(root, "Notes", "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const policy = await PathSecurity.create({
      vaultRoot: root,
      allowedRoots: ["Notes"],
    });

    await expect(
      policy.resolveAuthorizedPath("Notes/escape/secret.md"),
    ).rejects.toMatchObject({
      toolError: { code: "SYMLINK_ESCAPE_BLOCKED" },
    });
  });

  it("blocks a nonexistent destination beneath an escaping symlink", async () => {
    const root = await temporaryDirectory("workbench-vault-destination-");
    const outside = await temporaryDirectory("workbench-outside-destination-");
    await mkdir(path.join(root, "Notes"), { recursive: true });
    await symlink(
      outside,
      path.join(root, "Notes", "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const policy = await PathSecurity.create({
      vaultRoot: root,
      allowedRoots: ["Notes"],
    });

    await expect(
      policy.resolveAuthorizedDestination("Notes/escape/new/deep.md"),
    ).rejects.toMatchObject({
      toolError: { code: "SYMLINK_ESCAPE_BLOCKED" },
    });
  });

  it("authorizes a nonexistent destination from its deepest physical parent", async () => {
    const root = await temporaryDirectory("workbench-destination-");
    await mkdir(path.join(root, "Notes", "Existing"), { recursive: true });
    const policy = await PathSecurity.create({
      vaultRoot: root,
      allowedRoots: ["Notes"],
    });

    const destination = await policy.resolveAuthorizedDestination(
      "Notes/Existing/new/deep.md",
    );
    expect(destination.relativePath).toBe("Notes/Existing/new/deep.md");
    expect(destination.absolutePath).toBe(
      path.join(root, "Notes", "Existing", "new", "deep.md"),
    );
  });
});
