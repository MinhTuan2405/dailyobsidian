import {
  FrontmatterValueSchema,
  type FrontmatterValue,
  type Heading,
  type TaskStatus,
  type WikiLink,
} from "@obsidian-workbench/shared";
import { applyPatch } from "diff";
import { parseDocument } from "yaml";

import { validationError } from "./errors.js";
import { normalizeContent } from "./hash.js";

export interface ParsedFrontmatter {
  values: Record<string, FrontmatterValue>;
  endLine: number;
}

export interface ParsedTask {
  line: number;
  text: string;
  status: TaskStatus;
  blockId?: string;
  dueDate?: string;
  scheduledDate?: string;
  priority: "lowest" | "low" | "normal" | "medium" | "high" | "highest";
  tags: string[];
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const lines = normalizeContent(content).split("\n");
  if (lines[0] !== "---") return { values: {}, endLine: 0 };
  const closing = lines.findIndex(
    (line, index) => index > 0 && (line === "---" || line === "..."),
  );
  if (closing < 0)
    throw validationError("The note contains invalid YAML frontmatter.");
  const document = parseDocument(lines.slice(1, closing).join("\n"), {
    prettyErrors: false,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw validationError("The note contains invalid YAML frontmatter.");
  }
  const value: unknown = document.toJS({ maxAliasCount: 50 });
  if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
    throw validationError("The note contains invalid YAML frontmatter.");
  }
  const values: Record<string, FrontmatterValue> = {};
  for (const [key, child] of Object.entries(value ?? {})) {
    const parsed = FrontmatterValueSchema.safeParse(child);
    if (parsed.success) values[key] = parsed.data;
  }
  return { values, endLine: closing + 1 };
}

function anchorFor(value: string): string {
  const anchor = value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return anchor || "heading";
}

export function parseHeadings(content: string, startLine = 0): Heading[] {
  const lines = normalizeContent(content).split("\n");
  const anchors = new Map<string, number>();
  const headings: Heading[] = [];
  let fence: string | undefined;
  for (let index = startLine; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceMatch !== undefined) {
      if (fence === undefined) fence = fenceMatch[0];
      else if (fence === fenceMatch[0]) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const text = match[2]
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/[*_~]/g, "")
      .trim();
    const base = anchorFor(text);
    const count = anchors.get(base) ?? 0;
    anchors.set(base, count + 1);
    headings.push({
      text,
      level: match[1].length,
      line: index + 1,
      anchor: count === 0 ? base : `${base}-${count}`,
    });
  }
  return headings;
}

export function parseWikiLinks(
  content: string,
  sourcePath: string,
): WikiLink[] {
  const links: WikiLink[] = [];
  const lines = normalizeContent(content).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const pattern = /(!)?\[\[([^\]]+)\]\]/g;
    for (const match of line.matchAll(pattern)) {
      const rawTarget = match[2] ?? "";
      const [destination = "", alias] = rawTarget.split("|", 2);
      const [targetValue = "", fragment] = destination.split("#", 2);
      const target = targetValue.trim() || sourcePath.replace(/\.md$/i, "");
      if (target.length === 0) continue;
      links.push({
        raw: match[0],
        target,
        ...(alias?.trim() ? { alias: alias.trim() } : {}),
        ...(fragment?.startsWith("^")
          ? { blockId: fragment.slice(1) }
          : fragment
            ? { heading: fragment }
            : {}),
        embedded: match[1] === "!",
        line: index + 1,
      });
    }
  }
  return links;
}

function taskStatus(marker: string): TaskStatus | undefined {
  if (marker === " ") return "open";
  if (marker.toLocaleLowerCase("en-US") === "x") return "completed";
  if (marker === "-") return "cancelled";
  if (marker === "/") return "in_progress";
  return undefined;
}

function priority(text: string): ParsedTask["priority"] {
  if (text.includes("\u{1F53A}")) return "highest";
  if (text.includes("\u{23EB}")) return "high";
  if (text.includes("\u{1F53C}")) return "medium";
  if (text.includes("\u{1F53D}")) return "low";
  if (text.includes("\u{23EC}")) return "lowest";
  return "normal";
}

export function parseTasks(content: string, startLine = 0): ParsedTask[] {
  const lines = normalizeContent(content).split("\n");
  const tasks: ParsedTask[] = [];
  for (let index = startLine; index < lines.length; index += 1) {
    const match = /^\s*(?:[-*+]|\d+[.)])\s+\[([^\]])\]\s+(.*)$/.exec(
      lines[index] ?? "",
    );
    const status = match?.[1] === undefined ? undefined : taskStatus(match[1]);
    if (status === undefined || match?.[2] === undefined) continue;
    const text = match[2];
    const blockId = /(?:^|\s)\^([a-zA-Z0-9][a-zA-Z0-9_-]*)\s*$/.exec(text)?.[1];
    const dueDate = /\u{1F4C5}\s*(\d{4}-\d{2}-\d{2})/u.exec(text)?.[1];
    const scheduledDate = /\u{23F3}\s*(\d{4}-\d{2}-\d{2})/u.exec(text)?.[1];
    const tags = [
      ...text.matchAll(/(^|\s)#([\p{Letter}\p{Number}_/-]+)/gu),
    ].map((tag) => `#${tag[2] ?? ""}`);
    tasks.push({
      line: index + 1,
      text,
      status,
      ...(blockId === undefined ? {} : { blockId }),
      ...(dueDate === undefined ? {} : { dueDate }),
      ...(scheduledDate === undefined ? {} : { scheduledDate }),
      priority: priority(text),
      tags: [...new Set(tags)].sort(),
    });
  }
  return tasks;
}

function lineOffset(content: string, line: number): number {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const newline = content.indexOf("\n", offset);
    if (newline < 0) return content.length;
    offset = newline + 1;
  }
  return offset;
}

function sectionRange(
  content: string,
  heading: string,
): { start: number; end: number } {
  const frontmatter = parseFrontmatter(content);
  const headings = parseHeadings(content, frontmatter.endLine);
  const matches = headings.filter((candidate) => candidate.text === heading);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw validationError(
      matches.length === 0
        ? "The requested heading could not be found."
        : "The requested heading is ambiguous.",
    );
  }
  const selected = matches[0];
  const headingOffset = lineOffset(content, selected.line);
  const headingEnd = content.indexOf("\n", headingOffset);
  const start = headingEnd < 0 ? content.length : headingEnd + 1;
  const next = headings.find(
    (candidate) =>
      candidate.line > selected.line && candidate.level <= selected.level,
  );
  return {
    start,
    end: next === undefined ? content.length : lineOffset(content, next.line),
  };
}

function insertAt(content: string, offset: number, addition: string): string {
  const normalized = normalizeContent(addition);
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
  const normalized = normalizeContent(content);
  return insertAt(
    normalized,
    heading === undefined
      ? normalized.length
      : sectionRange(normalized, heading).end,
    addition,
  );
}

export function applyUpdate(
  content: string,
  operation:
    | { type: "replace_range"; start: number; end: number; content: string }
    | { type: "replace_section"; heading: string; content: string }
    | { type: "apply_patch"; patch: string }
    | { type: "replace_document"; content: string },
): string {
  const normalized = normalizeContent(content);
  if (operation.type === "replace_range") {
    if (
      operation.end < operation.start ||
      operation.start > normalized.length ||
      operation.end > normalized.length
    ) {
      throw validationError("The replacement range is outside the note.");
    }
    return `${normalized.slice(0, operation.start)}${normalizeContent(operation.content)}${normalized.slice(operation.end)}`;
  }
  if (operation.type === "replace_section") {
    const range = sectionRange(normalized, operation.heading);
    const replacement = normalizeContent(operation.content);
    const suffix = normalized.slice(range.end);
    const newline =
      suffix !== "" && replacement !== "" && !replacement.endsWith("\n")
        ? "\n"
        : "";
    return `${normalized.slice(0, range.start)}${replacement}${newline}${suffix}`;
  }
  if (operation.type === "apply_patch") {
    const patched = applyPatch(normalized, operation.patch, { fuzzFactor: 0 });
    if (patched === false)
      throw validationError(
        "The patch does not apply exactly to this revision.",
      );
    return normalizeContent(patched);
  }
  return normalizeContent(operation.content);
}

export function setFrontmatter(
  content: string,
  values: Record<string, FrontmatterValue>,
  remove: readonly string[],
): string {
  const overlap = remove.find((key) => Object.hasOwn(values, key));
  if (overlap !== undefined) {
    throw validationError(
      "A frontmatter key cannot be set and removed together.",
    );
  }
  const normalized = normalizeContent(content);
  const parsed = parseFrontmatter(normalized);
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
  const normalized = normalizeContent(content);
  return Object.keys(frontmatter).length === 0
    ? normalized
    : setFrontmatter(normalized, frontmatter, []);
}

const STATUS_MARKERS: Record<TaskStatus, string> = {
  open: " ",
  completed: "x",
  cancelled: "-",
  in_progress: "/",
};

export function updateTaskLine(
  content: string,
  task: ParsedTask,
  update: { status?: TaskStatus; text?: string; dueDate?: string | null },
): string {
  const lines = normalizeContent(content).split("\n");
  const original = lines[task.line - 1];
  const match =
    original === undefined
      ? undefined
      : /^(\s*(?:[-*+]|\d+[.)])\s+\[)([^\]])(\]\s+)(.*)$/.exec(original);
  if (match?.[4] === undefined)
    throw validationError("The task could not be located safely.");
  let text = update.text ?? match[4];
  text = text.replace(/\s+\^[a-zA-Z0-9][a-zA-Z0-9_-]*\s*$/, "").trimEnd();
  if (update.dueDate !== undefined) {
    text = text.replace(/\s*\u{1F4C5}\s*\d{4}-\d{2}-\d{2}/gu, "").trimEnd();
    if (update.dueDate !== null) text += ` \u{1F4C5} ${update.dueDate}`;
  } else if (
    update.text !== undefined &&
    task.dueDate !== undefined &&
    !/\u{1F4C5}/u.test(text)
  ) {
    text += ` \u{1F4C5} ${task.dueDate}`;
  }
  if (task.blockId !== undefined) text += ` ^${task.blockId}`;
  lines[task.line - 1] =
    `${match[1]}${update.status === undefined ? match[2] : STATUS_MARKERS[update.status]}${match[3]}${text}`;
  return lines.join("\n");
}
