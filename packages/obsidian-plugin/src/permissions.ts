import type { PermissionScope } from "@obsidian-workbench/shared";

import { workbenchError } from "./errors.js";

const WINDOWS_PATH = /^[a-zA-Z]:/;
const ENCODED_PATH = /%[0-9a-fA-F]{2}/;

function segments(path: string): string[] {
  return path === "" ? [] : path.split("/");
}

function segmentEquals(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

export function isAtOrBelow(candidate: string, root: string): boolean {
  const candidateSegments = segments(candidate);
  const rootSegments = segments(root);
  return (
    rootSegments.length <= candidateSegments.length &&
    rootSegments.every((segment, index) =>
      segmentEquals(segment, candidateSegments[index] ?? ""),
    )
  );
}

function pathFailure(message: string): never {
  throw workbenchError("PATH_TRAVERSAL_BLOCKED", message);
}

export function normalizeVaultPath(input: string): string {
  if (
    input.length === 0 ||
    input.length > 4096 ||
    // eslint-disable-next-line no-control-regex -- control characters are invalid path input.
    /[\u0000-\u001f\u007f]/.test(input)
  ) {
    throw workbenchError("PATH_NOT_ALLOWED", "The vault path is invalid.");
  }
  if (ENCODED_PATH.test(input)) {
    pathFailure("Encoded path syntax is not allowed.");
  }
  if (
    input.startsWith("/") ||
    input.startsWith("\\") ||
    WINDOWS_PATH.test(input)
  ) {
    pathFailure("Absolute and UNC paths are not allowed.");
  }
  const normalized = input.replaceAll("\\", "/");
  if (normalized.startsWith("//")) pathFailure("UNC paths are not allowed.");
  const pathSegments = normalized.split("/");
  if (
    pathSegments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":"),
    )
  ) {
    pathFailure("Traversal and ambiguous path segments are not allowed.");
  }
  if (
    pathSegments.some(
      (segment) => segment.endsWith(".") || segment.endsWith(" "),
    )
  ) {
    throw workbenchError("PATH_NOT_ALLOWED", "The vault path is invalid.");
  }
  return pathSegments.join("/");
}

function normalizeRoot(input: string): string {
  const trimmed = input.trim();
  return trimmed === "" || trimmed === "." ? "" : normalizeVaultPath(trimmed);
}

export interface PermissionOptions {
  allowedRoots: readonly string[];
  excludedRoots: readonly string[];
  scopes: readonly PermissionScope[];
}

export class VaultPermissions {
  readonly allowedRoots: readonly string[];
  readonly excludedRoots: readonly string[];
  readonly scopes: ReadonlySet<PermissionScope>;

  constructor(options: PermissionOptions) {
    const allowed = [...new Set(options.allowedRoots.map(normalizeRoot))];
    if (allowed.length === 0) {
      throw workbenchError(
        "VALIDATION_ERROR",
        "At least one allowed vault root is required.",
      );
    }
    const excluded = [...new Set(options.excludedRoots.map(normalizeRoot))];
    if (excluded.includes("")) {
      throw workbenchError(
        "VALIDATION_ERROR",
        "The entire vault cannot be excluded.",
      );
    }
    this.allowedRoots = allowed;
    this.excludedRoots = excluded;
    this.scopes = new Set(options.scopes);
  }

  assertScope(scope: PermissionScope): void {
    if (!this.scopes.has(scope)) {
      throw workbenchError(
        "PERMISSION_DENIED",
        "The requested operation is not enabled for this vault.",
      );
    }
  }

  assertPath(input: string): string {
    const normalized = normalizeVaultPath(input);
    const pathSegments = segments(normalized);
    if (pathSegments.some((segment) => segmentEquals(segment, ".obsidian"))) {
      throw workbenchError(
        "PATH_NOT_ALLOWED",
        "Obsidian configuration paths are not accessible.",
      );
    }
    if (this.excludedRoots.some((root) => isAtOrBelow(normalized, root))) {
      throw workbenchError(
        "PATH_NOT_ALLOWED",
        "The path is excluded by vault policy.",
      );
    }
    if (!this.allowedRoots.some((root) => isAtOrBelow(normalized, root))) {
      throw workbenchError(
        "PATH_NOT_ALLOWED",
        "The path is outside the allowed roots.",
      );
    }
    return normalized;
  }

  assertFolder(input: string): string {
    const normalized = normalizeRoot(input);
    if (normalized === "") {
      if (!this.allowedRoots.includes("")) {
        throw workbenchError(
          "PATH_NOT_ALLOWED",
          "The folder is outside the allowed roots.",
        );
      }
      return normalized;
    }
    return this.assertPath(normalized);
  }

  allowsPath(input: string): boolean {
    try {
      this.assertPath(input);
      return true;
    } catch {
      return false;
    }
  }
}
