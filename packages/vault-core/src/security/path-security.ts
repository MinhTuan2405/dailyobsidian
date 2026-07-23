import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { WorkbenchError } from "@obsidian-workbench/shared";

export interface PathSecurityOptions {
  vaultRoot: string;
  allowedRoots?: readonly string[];
  excludedRoots?: readonly string[];
  blockObsidian?: boolean;
}

export interface AuthorizedPath {
  relativePath: string;
  absolutePath: string;
}

const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:/;
const ENCODED_AMBIGUOUS_CHARACTER = /%(?:25|2e|2f|3a|5c)/i;

function pathError(
  code:
    "PATH_NOT_ALLOWED" | "PATH_TRAVERSAL_BLOCKED" | "SYMLINK_ESCAPE_BLOCKED",
  message: string,
): WorkbenchError {
  return new WorkbenchError({ code, message, recoverable: true });
}

function notFoundError(kind: "vault" | "note"): WorkbenchError {
  return new WorkbenchError({
    code: kind === "vault" ? "VAULT_NOT_FOUND" : "NOTE_NOT_FOUND",
    message:
      kind === "vault"
        ? "The configured vault could not be found."
        : "The requested note could not be found.",
    recoverable: true,
  });
}

function hasTraversalSegment(value: string): boolean {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

function assertUnambiguousEncoding(input: string): void {
  let candidate = input;
  for (let pass = 0; pass < 3; pass += 1) {
    if (!/%[0-9a-fA-F]{2}/.test(candidate)) {
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      throw pathError(
        "PATH_TRAVERSAL_BLOCKED",
        "Encoded or ambiguous path syntax is not allowed.",
      );
    }
    if (decoded === candidate) {
      return;
    }
    if (
      ENCODED_AMBIGUOUS_CHARACTER.test(candidate) ||
      hasTraversalSegment(decoded) ||
      decoded.startsWith("/") ||
      decoded.startsWith("\\") ||
      WINDOWS_DRIVE_PATH.test(decoded)
    ) {
      throw pathError(
        "PATH_TRAVERSAL_BLOCKED",
        "Encoded or ambiguous path syntax is not allowed.",
      );
    }
    candidate = decoded;
  }
  if (/%[0-9a-fA-F]{2}/.test(candidate)) {
    throw pathError(
      "PATH_TRAVERSAL_BLOCKED",
      "Encoded or ambiguous path syntax is not allowed.",
    );
  }
}

export function normalizeVaultPath(input: string): string {
  if (
    input.length === 0 ||
    input.length > 4096 ||
    // eslint-disable-next-line no-control-regex -- control characters are invalid path input.
    /[\u0000-\u001f\u007f]/.test(input)
  ) {
    throw pathError("PATH_NOT_ALLOWED", "The vault path is invalid.");
  }

  assertUnambiguousEncoding(input);
  if (
    input.startsWith("/") ||
    input.startsWith("\\") ||
    WINDOWS_DRIVE_PATH.test(input)
  ) {
    throw pathError(
      "PATH_TRAVERSAL_BLOCKED",
      "Absolute paths are not allowed.",
    );
  }

  const normalizedSeparators = input.replaceAll("\\", "/");
  if (normalizedSeparators.startsWith("//")) {
    throw pathError("PATH_TRAVERSAL_BLOCKED", "UNC paths are not allowed.");
  }

  const segments = normalizedSeparators.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":"),
    )
  ) {
    throw pathError(
      "PATH_TRAVERSAL_BLOCKED",
      "Path traversal or ambiguous path segments are not allowed.",
    );
  }
  if (
    process.platform === "win32" &&
    segments.some((segment) => segment.endsWith(".") || segment.endsWith(" "))
  ) {
    throw pathError("PATH_NOT_ALLOWED", "The vault path is invalid.");
  }
  return segments.join("/");
}

function normalizePolicyRoot(input: string): string {
  if (input === "" || input === ".") {
    return "";
  }
  return normalizeVaultPath(input).replace(/\/$/, "");
}

function portableSegments(value: string): string[] {
  return value === "" ? [] : value.split("/");
}

function compareSegment(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function isAtOrBelow(candidate: string, root: string): boolean {
  const candidateSegments = portableSegments(candidate);
  const rootSegments = portableSegments(root);
  return (
    rootSegments.length <= candidateSegments.length &&
    rootSegments.every((segment, index) =>
      compareSegment(segment, candidateSegments[index] ?? ""),
    )
  );
}

function isAncestorOf(candidate: string, descendant: string): boolean {
  return isAtOrBelow(descendant, candidate);
}

function isInsideFilesystemPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export class PathSecurity {
  readonly vaultRoot: string;
  readonly realVaultRoot: string;
  readonly allowedRoots: readonly string[];
  readonly excludedRoots: readonly string[];
  readonly blockObsidian: boolean;

  private constructor(
    vaultRoot: string,
    realVaultRoot: string,
    allowedRoots: readonly string[],
    excludedRoots: readonly string[],
    blockObsidian: boolean,
  ) {
    this.vaultRoot = vaultRoot;
    this.realVaultRoot = realVaultRoot;
    this.allowedRoots = allowedRoots;
    this.excludedRoots = excludedRoots;
    this.blockObsidian = blockObsidian;
  }

  static async create(options: PathSecurityOptions): Promise<PathSecurity> {
    if (!path.isAbsolute(options.vaultRoot)) {
      throw new WorkbenchError({
        code: "VALIDATION_ERROR",
        message: "The configured vault root must be an absolute path.",
        recoverable: true,
      });
    }

    const vaultRoot = path.resolve(options.vaultRoot);
    let realVaultRoot: string;
    try {
      realVaultRoot = await realpath(vaultRoot);
      if (!(await stat(realVaultRoot)).isDirectory()) {
        throw notFoundError("vault");
      }
    } catch (error) {
      if (error instanceof WorkbenchError) {
        throw error;
      }
      throw notFoundError("vault");
    }

    const allowedRoots = unique(
      (options.allowedRoots ?? ["."]).map(normalizePolicyRoot),
    );
    if (allowedRoots.length === 0) {
      throw new WorkbenchError({
        code: "VALIDATION_ERROR",
        message: "At least one allowed vault root is required.",
        recoverable: true,
      });
    }
    const excludedRoots = unique(
      (options.excludedRoots ?? []).map(normalizePolicyRoot),
    );
    if (excludedRoots.includes("")) {
      throw new WorkbenchError({
        code: "VALIDATION_ERROR",
        message: "The entire vault cannot be configured as excluded.",
        recoverable: true,
      });
    }

    return new PathSecurity(
      vaultRoot,
      realVaultRoot,
      allowedRoots,
      excludedRoots,
      options.blockObsidian ?? true,
    );
  }

  assertAuthorizedRelativePath(input: string): string {
    const normalized = normalizeVaultPath(input);
    this.#assertPolicy(normalized);
    return normalized;
  }

  assertAuthorizedFolder(input: string): string {
    const normalized = normalizePolicyRoot(input);
    if (normalized === "") {
      this.#assertPolicy(normalized);
      return normalized;
    }
    this.#assertPolicy(normalized);
    return normalized;
  }

  shouldTraverseDirectory(relativePath: string): boolean {
    let normalized: string;
    try {
      normalized = normalizeVaultPath(relativePath);
    } catch {
      return false;
    }
    if (this.#isExcluded(normalized) || this.#containsObsidian(normalized)) {
      return false;
    }
    return this.allowedRoots.some(
      (root) => isAtOrBelow(normalized, root) || isAncestorOf(normalized, root),
    );
  }

  isAuthorizedRelativePath(relativePath: string): boolean {
    try {
      this.assertAuthorizedRelativePath(relativePath);
      return true;
    } catch {
      return false;
    }
  }

  pathsEqual(left: string, right: string): boolean {
    const normalizedLeft = normalizeVaultPath(left);
    const normalizedRight = normalizeVaultPath(right);
    const leftSegments = portableSegments(normalizedLeft);
    const rightSegments = portableSegments(normalizedRight);
    return (
      leftSegments.length === rightSegments.length &&
      leftSegments.every((segment, index) =>
        compareSegment(segment, rightSegments[index] ?? ""),
      )
    );
  }

  async resolveAuthorizedPath(input: string): Promise<AuthorizedPath> {
    const relativePath = this.assertAuthorizedRelativePath(input);
    const lexicalPath = path.resolve(
      this.vaultRoot,
      ...portableSegments(relativePath),
    );
    if (!isInsideFilesystemPath(this.vaultRoot, lexicalPath)) {
      throw pathError(
        "PATH_TRAVERSAL_BLOCKED",
        "The path must remain inside the configured vault.",
      );
    }

    let physicalPath: string;
    try {
      physicalPath = await realpath(lexicalPath);
    } catch {
      throw notFoundError("note");
    }
    if (!isInsideFilesystemPath(this.realVaultRoot, physicalPath)) {
      throw pathError(
        "SYMLINK_ESCAPE_BLOCKED",
        "The path resolves outside the configured vault.",
      );
    }

    const physicalRelativeNative = path.relative(
      this.realVaultRoot,
      physicalPath,
    );
    const physicalRelative = physicalRelativeNative.split(path.sep).join("/");
    if (physicalRelative === "") {
      throw pathError("PATH_NOT_ALLOWED", "The vault root is not a note.");
    }
    this.#assertPolicy(normalizeVaultPath(physicalRelative));
    return { relativePath, absolutePath: physicalPath };
  }

  async resolveAuthorizedDestination(input: string): Promise<AuthorizedPath> {
    const relativePath = this.assertAuthorizedRelativePath(input);
    const lexicalPath = path.resolve(
      this.vaultRoot,
      ...portableSegments(relativePath),
    );
    if (!isInsideFilesystemPath(this.vaultRoot, lexicalPath)) {
      throw pathError(
        "PATH_TRAVERSAL_BLOCKED",
        "The path must remain inside the configured vault.",
      );
    }

    let existingLexicalPath = lexicalPath;
    const missingSegments: string[] = [];
    let physicalAncestor: string | undefined;
    while (physicalAncestor === undefined) {
      try {
        physicalAncestor = await realpath(existingLexicalPath);
      } catch (error) {
        const code =
          error instanceof Error && "code" in error
            ? (error as NodeJS.ErrnoException).code
            : undefined;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          throw pathError(
            "PATH_NOT_ALLOWED",
            "The destination path cannot be authorized.",
          );
        }
        if (this.pathsEqualFilesystem(existingLexicalPath, this.vaultRoot)) {
          throw pathError(
            "PATH_NOT_ALLOWED",
            "The destination path cannot be authorized.",
          );
        }
        missingSegments.unshift(path.basename(existingLexicalPath));
        existingLexicalPath = path.dirname(existingLexicalPath);
      }
    }

    if (!isInsideFilesystemPath(this.realVaultRoot, physicalAncestor)) {
      throw pathError(
        "SYMLINK_ESCAPE_BLOCKED",
        "The destination resolves outside the configured vault.",
      );
    }
    if (
      missingSegments.length > 0 &&
      !(await stat(physicalAncestor)).isDirectory()
    ) {
      throw pathError(
        "PATH_NOT_ALLOWED",
        "The destination parent is not a directory.",
      );
    }

    const physicalPath = path.resolve(physicalAncestor, ...missingSegments);
    if (!isInsideFilesystemPath(this.realVaultRoot, physicalPath)) {
      throw pathError(
        "SYMLINK_ESCAPE_BLOCKED",
        "The destination resolves outside the configured vault.",
      );
    }
    const physicalRelative = path
      .relative(this.realVaultRoot, physicalPath)
      .split(path.sep)
      .join("/");
    if (physicalRelative === "") {
      throw pathError("PATH_NOT_ALLOWED", "The vault root is not a note.");
    }
    this.#assertPolicy(normalizeVaultPath(physicalRelative));
    return { relativePath, absolutePath: physicalPath };
  }

  authorizedRootFor(input: string): string {
    const relativePath = this.assertAuthorizedRelativePath(input);
    return this.allowedRoots
      .filter((root) => isAtOrBelow(relativePath, root))
      .sort(
        (left, right) =>
          portableSegments(right).length - portableSegments(left).length,
      )[0] as string;
  }

  private pathsEqualFilesystem(left: string, right: string): boolean {
    return process.platform === "win32"
      ? path.resolve(left).toLocaleLowerCase("en-US") ===
          path.resolve(right).toLocaleLowerCase("en-US")
      : path.resolve(left) === path.resolve(right);
  }

  #assertPolicy(relativePath: string): void {
    if (this.#containsObsidian(relativePath)) {
      throw pathError(
        "PATH_NOT_ALLOWED",
        "Obsidian configuration paths are not accessible.",
      );
    }
    if (this.#isExcluded(relativePath)) {
      throw pathError(
        "PATH_NOT_ALLOWED",
        "The path is excluded by vault policy.",
      );
    }
    if (!this.allowedRoots.some((root) => isAtOrBelow(relativePath, root))) {
      throw pathError(
        "PATH_NOT_ALLOWED",
        "The path is outside the allowed roots.",
      );
    }
  }

  #isExcluded(relativePath: string): boolean {
    return this.excludedRoots.some((root) => isAtOrBelow(relativePath, root));
  }

  #containsObsidian(relativePath: string): boolean {
    return (
      this.blockObsidian &&
      portableSegments(relativePath).some(
        (segment) => segment.toLocaleLowerCase("en-US") === ".obsidian",
      )
    );
  }
}
