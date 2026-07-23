import { applyPatch, createTwoFilesPatch, diffLines } from "diff";
import { parseDocument } from "yaml";

import {
  MutationPlanSchema,
  WorkbenchError,
  type FrontmatterValue,
  type MutationPlan,
} from "@obsidian-workbench/shared";

import { parseFrontmatter, parseHeadings } from "../markdown/parser.js";
import { requestFingerprint } from "../pagination/cursor.js";
import {
  createRevision,
  normalizeNoteContent,
} from "../revisions/revisions.js";

export interface MutationPlanInput {
  vaultId: string;
  targetNoteId?: string;
  sourcePath: string;
  targetPath?: string;
  operation: string;
  requestHash: string;
  originalContent?: string;
  proposedContent: string;
  changedSections: string[];
  riskLevel: "low" | "medium" | "high";
  confirmationRequired: boolean;
  now?: number;
}

interface DiffChange {
  value: string;
  count?: number;
  added?: boolean;
  removed?: boolean;
}

function validationError(message: string): WorkbenchError {
  return new WorkbenchError({
    code: "VALIDATION_ERROR",
    message,
    recoverable: true,
  });
}

function changedLineCount(value: string, count: number | undefined): number {
  if (count !== undefined) return count;
  if (value === "") return 0;
  const lines = value.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export function mutationRequestHash(value: unknown): string {
  return `sha256:${requestFingerprint(value)}`;
}

export function buildMutationPlan(input: MutationPlanInput): MutationPlan {
  const original = normalizeNoteContent(input.originalContent ?? "");
  const proposed = normalizeNoteContent(input.proposedContent);
  const targetPath = input.targetPath ?? input.sourcePath;
  const changes: DiffChange[] = diffLines(original, proposed);
  const additions = changes
    .filter((change) => change.added)
    .reduce(
      (total, change) => total + changedLineCount(change.value, change.count),
      0,
    );
  const deletions = changes
    .filter((change) => change.removed)
    .reduce(
      (total, change) => total + changedLineCount(change.value, change.count),
      0,
    );
  const originalRevision =
    input.originalContent === undefined ? undefined : createRevision(original);
  const proposedRevision = createRevision(proposed);
  const unifiedDiff = createTwoFilesPatch(
    input.sourcePath,
    targetPath,
    original,
    proposed,
    "original",
    "proposed",
    { context: 3 },
  );
  const mutationHash = mutationRequestHash({
    vaultId: input.vaultId,
    targetNoteId: input.targetNoteId,
    sourcePath: input.sourcePath,
    targetPath,
    operation: input.operation,
    originalRevision,
    proposedRevision,
    unifiedDiff,
  });
  const mutationId = `mutation_${requestFingerprint({
    requestHash: input.requestHash,
    mutationHash,
  })}`;
  return MutationPlanSchema.parse({
    mutationId,
    vaultId: input.vaultId,
    ...(input.targetNoteId !== undefined
      ? { targetNoteId: input.targetNoteId }
      : {}),
    targetPath,
    operation: input.operation,
    requestHash: input.requestHash,
    mutationHash,
    diff: {
      path: targetPath,
      ...(originalRevision !== undefined ? { originalRevision } : {}),
      proposedRevision,
      unifiedDiff,
      changedSections: [...new Set(input.changedSections)],
      additions,
      deletions,
      riskLevel: input.riskLevel,
      confirmationRequired: input.confirmationRequired,
    },
    expiresAt: new Date(
      (input.now ?? Date.now()) + 5 * 60 * 1000,
    ).toISOString(),
  });
}

interface SectionRange {
  bodyStart: number;
  bodyEnd: number;
}

function offsetAtLine(content: string, line: number): number {
  if (line <= 1) return 0;
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const newline = content.indexOf("\n", offset);
    if (newline < 0) return content.length;
    offset = newline + 1;
  }
  return offset;
}

function findSection(content: string, heading: string): SectionRange {
  const headings = parseHeadings(content, parseFrontmatter(content).endLine);
  const matches = headings.filter((candidate) => candidate.text === heading);
  if (matches.length !== 1) {
    throw validationError(
      matches.length === 0
        ? "The requested heading could not be found."
        : "The requested heading is ambiguous.",
    );
  }
  const selected = matches[0];
  if (selected === undefined) throw validationError("The heading is invalid.");
  const headingStart = offsetAtLine(content, selected.line);
  const headingEndIndex = content.indexOf("\n", headingStart);
  const bodyStart = headingEndIndex < 0 ? content.length : headingEndIndex + 1;
  const next = headings.find(
    (candidate) =>
      candidate.line > selected.line && candidate.level <= selected.level,
  );
  return {
    bodyStart,
    bodyEnd:
      next === undefined ? content.length : offsetAtLine(content, next.line),
  };
}

function joinAt(content: string, offset: number, addition: string): string {
  const normalized = normalizeNoteContent(addition);
  if (normalized === "") return content;
  const before = content.slice(0, offset);
  const after = content.slice(offset);
  const leading = before === "" || before.endsWith("\n") ? "" : "\n";
  const trailing = after === "" || normalized.endsWith("\n") ? "" : "\n";
  return `${before}${leading}${normalized}${trailing}${after}`;
}

export function appendContent(
  content: string,
  addition: string,
  heading?: string,
): string {
  const normalized = normalizeNoteContent(content);
  if (heading === undefined)
    return joinAt(normalized, normalized.length, addition);
  return joinAt(normalized, findSection(normalized, heading).bodyEnd, addition);
}

export function applyExplicitUpdate(
  content: string,
  operation:
    | { type: "replace_range"; start: number; end: number; content: string }
    | { type: "replace_section"; heading: string; content: string }
    | { type: "apply_patch"; patch: string }
    | { type: "replace_document"; content: string },
): string {
  const normalized = normalizeNoteContent(content);
  if (operation.type === "replace_range") {
    if (
      operation.end < operation.start ||
      operation.start > normalized.length ||
      operation.end > normalized.length
    ) {
      throw validationError("The replacement range is outside the note.");
    }
    return normalizeNoteContent(
      `${normalized.slice(0, operation.start)}${normalizeNoteContent(operation.content)}${normalized.slice(operation.end)}`,
    );
  }
  if (operation.type === "replace_section") {
    const section = findSection(normalized, operation.heading);
    const replacement = normalizeNoteContent(operation.content);
    const suffix = normalized.slice(section.bodyEnd);
    const trailing =
      suffix !== "" && replacement !== "" && !replacement.endsWith("\n")
        ? "\n"
        : "";
    return `${normalized.slice(0, section.bodyStart)}${replacement}${trailing}${suffix}`;
  }
  if (operation.type === "apply_patch") {
    const patched = applyPatch(normalized, operation.patch, { fuzzFactor: 0 });
    if (patched === false) {
      throw validationError(
        "The patch does not apply exactly to this revision.",
      );
    }
    return normalizeNoteContent(patched);
  }
  return normalizeNoteContent(operation.content);
}

export function setFrontmatterContent(
  content: string,
  values: Record<string, FrontmatterValue>,
  remove: readonly string[],
): string {
  const normalized = normalizeNoteContent(content);
  const overlap = remove.find((key) => Object.hasOwn(values, key));
  if (overlap !== undefined) {
    throw validationError(
      "A frontmatter key cannot be set and removed together.",
    );
  }
  const parsed = parseFrontmatter(normalized);
  if (
    Object.entries(values).every(
      ([key, value]) =>
        Object.hasOwn(parsed.frontmatter, key) &&
        requestFingerprint(parsed.frontmatter[key]) ===
          requestFingerprint(value),
    ) &&
    remove.every((key) => !Object.hasOwn(parsed.frontmatter, key))
  ) {
    return normalized;
  }

  const lines = normalized.split("\n");
  const document = parseDocument(
    parsed.endLine === 0 ? "" : lines.slice(1, parsed.endLine - 1).join("\n"),
    { prettyErrors: false, schema: "core", uniqueKeys: true },
  );
  if (document.errors.length > 0) {
    throw validationError("The note contains invalid YAML frontmatter.");
  }
  for (const key of remove) document.delete(key);
  for (const [key, value] of Object.entries(values)) document.set(key, value);
  const yaml = document.toString({ lineWidth: 0 }).replace(/\n$/, "");
  const frontmatter = `---\n${yaml}${yaml === "" ? "" : "\n"}---`;
  const body =
    parsed.endLine === 0 ? normalized : lines.slice(parsed.endLine).join("\n");
  return `${frontmatter}\n${body}`;
}

export function createNoteContent(
  content: string,
  frontmatter: Record<string, FrontmatterValue>,
): string {
  const normalized = normalizeNoteContent(content);
  if (Object.keys(frontmatter).length === 0) return normalized;
  return setFrontmatterContent(normalized, frontmatter, []);
}

const STATUS_MARKERS = {
  open: " ",
  completed: "x",
  cancelled: "-",
  in_progress: "/",
} as const;

export function updateTaskContent(
  content: string,
  line: number,
  currentBlockId: string | undefined,
  currentDueDate: string | undefined,
  update: {
    status?: keyof typeof STATUS_MARKERS;
    text?: string;
    dueDate?: string | null;
  },
): string {
  const normalized = normalizeNoteContent(content);
  const lines = normalized.split("\n");
  const original = lines[line - 1];
  const match =
    original === undefined
      ? null
      : /^(\s*(?:[-*+]|\d+[.)])\s+\[)([^\]])(\]\s+)(.*)$/.exec(original);
  if (!match) throw validationError("The task could not be located safely.");
  let text = update.text ?? match[4] ?? "";
  text = text.replace(/\s+\^[a-zA-Z0-9][a-zA-Z0-9_-]*\s*$/, "").trimEnd();
  if (update.dueDate !== undefined) {
    text = text.replace(/\s*\u{1F4C5}\s*\d{4}-\d{2}-\d{2}/gu, "").trimEnd();
    if (update.dueDate !== null) text = `${text} \u{1F4C5} ${update.dueDate}`;
  } else if (
    update.text !== undefined &&
    currentDueDate !== undefined &&
    !/\u{1F4C5}\s*\d{4}-\d{2}-\d{2}/u.test(text)
  ) {
    text = `${text} \u{1F4C5} ${currentDueDate}`;
  }
  if (currentBlockId !== undefined) text = `${text} ^${currentBlockId}`;
  const marker =
    update.status === undefined
      ? (match[2] ?? " ")
      : STATUS_MARKERS[update.status];
  lines[line - 1] = `${match[1]}${marker}${match[3]}${text}`;
  return lines.join("\n");
}
