import {
  FrontmatterValueSchema,
  HeadingSchema,
  WikiLinkSchema,
  WorkbenchError,
  type FrontmatterValue,
  type Heading,
  type WikiLink,
} from "@obsidian-workbench/shared";
import { fromMarkdown } from "mdast-util-from-markdown";
import { parseDocument } from "yaml";

export interface ParsedFrontmatter {
  frontmatter: Record<string, FrontmatterValue>;
  endLine: number;
}

export interface ParsedTaskLine {
  line: number;
  text: string;
  status: "open" | "completed" | "cancelled" | "in_progress";
  blockId?: string;
  dueDate?: string;
  scheduledDate?: string;
  priority: "lowest" | "low" | "normal" | "medium" | "high" | "highest";
  tags: string[];
}

export interface ParsedMarkdown {
  frontmatter: Record<string, FrontmatterValue>;
  frontmatterEndLine: number;
  headings: Heading[];
  links: WikiLink[];
  tags: string[];
  tasks: ParsedTaskLine[];
}

function frontmatterError(): WorkbenchError {
  return new WorkbenchError({
    code: "VALIDATION_ERROR",
    message: "A note contains invalid YAML frontmatter.",
    recoverable: true,
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const lines = content.split("\n");
  if (lines[0] !== "---") {
    return { frontmatter: {}, endLine: 0 };
  }

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && (line === "---" || line === "..."),
  );
  if (closingIndex < 0) {
    throw frontmatterError();
  }

  try {
    const document = parseDocument(lines.slice(1, closingIndex).join("\n"), {
      prettyErrors: false,
      schema: "core",
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw frontmatterError();
    }
    const value: unknown = document.toJS({ maxAliasCount: 50 });
    if (value === null) {
      return { frontmatter: {}, endLine: closingIndex + 1 };
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      throw frontmatterError();
    }

    const frontmatter: Record<string, FrontmatterValue> = {};
    for (const [key, child] of Object.entries(value)) {
      frontmatter[key] = FrontmatterValueSchema.parse(child);
    }
    return { frontmatter, endLine: closingIndex + 1 };
  } catch (error) {
    if (error instanceof WorkbenchError) {
      throw error;
    }
    throw frontmatterError();
  }
}

interface FenceState {
  marker: "`" | "~";
  length: number;
}

function updateFence(
  line: string,
  fence: FenceState | undefined,
): FenceState | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) {
    return fence;
  }
  const run = match[1];
  if (run === undefined) {
    return fence;
  }
  const marker = run[0] as "`" | "~";
  if (fence === undefined) {
    return { marker, length: run.length };
  }
  if (marker === fence.marker && run.length >= fence.length) {
    return undefined;
  }
  return fence;
}

function maskInlineCode(line: string): string {
  const characters = line.split("");
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    let runEnd = index + 1;
    while (line[runEnd] === "`") {
      runEnd += 1;
    }
    const delimiter = line.slice(index, runEnd);
    const closing = line.indexOf(delimiter, runEnd);
    if (closing < 0) {
      index = runEnd;
      continue;
    }
    for (let masked = index; masked < closing + delimiter.length; masked += 1) {
      characters[masked] = " ";
    }
    index = closing + delimiter.length;
  }
  return characters.join("");
}

function isEscaped(line: string, index: number): boolean {
  let slashCount = 0;
  for (
    let current = index - 1;
    current >= 0 && line[current] === "\\";
    current -= 1
  ) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function headingText(value: string): string {
  return value
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~]/g, "")
    .trim();
}

function headingAnchor(value: string): string {
  const anchor = headingText(value)
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return anchor || "heading";
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  depth?: number;
  position?: { start: { line: number } };
}

function markdownText(node: MarkdownNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(markdownText).join("");
}

export function parseHeadings(
  content: string,
  frontmatterEndLine = 0,
): Heading[] {
  const body = content.split("\n").slice(frontmatterEndLine).join("\n");
  const root = fromMarkdown(body) as MarkdownNode;
  const headings: Heading[] = [];
  const anchors = new Map<string, number>();

  for (const node of root.children ?? []) {
    if (
      node.type !== "heading" ||
      node.depth === undefined ||
      node.position === undefined
    ) {
      continue;
    }
    const text = markdownText(node);
    const baseAnchor = headingAnchor(text);
    const count = anchors.get(baseAnchor) ?? 0;
    anchors.set(baseAnchor, count + 1);
    headings.push(
      HeadingSchema.parse({
        text: headingText(text),
        level: node.depth,
        line: node.position.start.line + frontmatterEndLine,
        anchor: count === 0 ? baseAnchor : `${baseAnchor}-${count}`,
      }),
    );
  }
  return headings;
}

function splitLinkContent(value: string): {
  target: string;
  alias?: string;
  heading?: string;
  blockId?: string;
} | null {
  const aliasSeparator = value.indexOf("|");
  const destination = (
    aliasSeparator < 0 ? value : value.slice(0, aliasSeparator)
  ).trim();
  const aliasValue =
    aliasSeparator < 0 ? undefined : value.slice(aliasSeparator + 1).trim();
  const fragmentSeparator = destination.indexOf("#");
  const target = (
    fragmentSeparator < 0
      ? destination
      : destination.slice(0, fragmentSeparator)
  ).trim();
  const fragment =
    fragmentSeparator < 0
      ? undefined
      : destination.slice(fragmentSeparator + 1).trim();
  if (target.includes("[[") || target.includes("]]")) {
    return null;
  }
  return {
    target,
    ...(aliasValue ? { alias: aliasValue } : {}),
    ...(fragment && !fragment.startsWith("^") ? { heading: fragment } : {}),
    ...(fragment?.startsWith("^") && fragment.length > 1
      ? { blockId: fragment.slice(1) }
      : {}),
  };
}

export function parseWikiLinks(
  content: string,
  sourcePath: string,
  frontmatterEndLine = 0,
): WikiLink[] {
  const lines = content.split("\n");
  const links: WikiLink[] = [];
  const sameNoteTarget = sourcePath.replace(/\.md$/i, "");
  let fence: FenceState | undefined;

  for (
    let lineIndex = frontmatterEndLine;
    lineIndex < lines.length;
    lineIndex += 1
  ) {
    const line = lines[lineIndex] ?? "";
    const previousFence = fence;
    fence = updateFence(line, fence);
    if (previousFence !== undefined || fence !== previousFence) {
      continue;
    }
    const visible = maskInlineCode(line);
    let cursor = 0;
    while (cursor < visible.length) {
      const opening = visible.indexOf("[[", cursor);
      if (opening < 0) {
        break;
      }
      if (isEscaped(visible, opening)) {
        cursor = opening + 2;
        continue;
      }
      const closing = visible.indexOf("]]", opening + 2);
      if (closing < 0) {
        break;
      }
      const parsed = splitLinkContent(line.slice(opening + 2, closing));
      if (parsed) {
        const embedded = opening > 0 && line[opening - 1] === "!";
        const rawStart = embedded ? opening - 1 : opening;
        links.push(
          WikiLinkSchema.parse({
            raw: line.slice(rawStart, closing + 2),
            target: parsed.target || sameNoteTarget,
            ...(parsed.alias !== undefined ? { alias: parsed.alias } : {}),
            ...(parsed.heading !== undefined
              ? { heading: parsed.heading }
              : {}),
            ...(parsed.blockId !== undefined
              ? { blockId: parsed.blockId }
              : {}),
            embedded,
            line: lineIndex + 1,
          }),
        );
      }
      cursor = closing + 2;
    }
  }
  return links;
}

function normalizeTag(value: string): string | undefined {
  const withoutHash = value.startsWith("#") ? value.slice(1) : value;
  if (
    withoutHash.length === 0 ||
    withoutHash.startsWith("/") ||
    withoutHash.endsWith("/") ||
    withoutHash.includes("//") ||
    /\s/.test(withoutHash) ||
    /^\d+$/.test(withoutHash)
  ) {
    return undefined;
  }
  return `#${withoutHash}`;
}

function tagsFromText(value: string): string[] {
  const tags: string[] = [];
  const pattern = /(^|[\s([{>,"'])#([\p{Letter}\p{Number}_/-]+)/gu;
  for (const match of value.matchAll(pattern)) {
    const tag = normalizeTag(match[2] ?? "");
    if (tag !== undefined) {
      tags.push(tag);
    }
  }
  return tags;
}

function tagsFromFrontmatter(
  frontmatter: Record<string, FrontmatterValue>,
): string[] {
  const value = frontmatter.tags ?? frontmatter.tag;
  const candidates = Array.isArray(value) ? value : [value];
  const tags: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    for (const part of candidate.split(/[\s,]+/)) {
      const tag = normalizeTag(part);
      if (tag !== undefined) {
        tags.push(tag);
      }
    }
  }
  return tags;
}

export function extractTags(
  content: string,
  frontmatter: Record<string, FrontmatterValue>,
  frontmatterEndLine = 0,
): string[] {
  const lines = content.split("\n");
  const tags = tagsFromFrontmatter(frontmatter);
  let fence: FenceState | undefined;
  for (let index = frontmatterEndLine; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const previousFence = fence;
    fence = updateFence(line, fence);
    if (previousFence !== undefined || fence !== previousFence) {
      continue;
    }
    let visible = maskInlineCode(line);
    visible = visible.replace(/!?\[\[[^\]]*\]\]/g, " ");
    tags.push(...tagsFromText(visible));
  }
  return [...new Set(tags)].sort(compareText);
}

function taskStatus(marker: string): ParsedTaskLine["status"] | undefined {
  if (marker === " ") return "open";
  if (marker === "x" || marker === "X") return "completed";
  if (marker === "-") return "cancelled";
  if (marker === "/") return "in_progress";
  return undefined;
}

function taskPriority(text: string): ParsedTaskLine["priority"] {
  if (text.includes("\u{1F53A}")) return "highest";
  if (text.includes("\u{23EB}")) return "high";
  if (text.includes("\u{1F53C}")) return "medium";
  if (text.includes("\u{1F53D}")) return "low";
  if (text.includes("\u{23EC}")) return "lowest";
  return "normal";
}

export function parseTaskLines(
  content: string,
  frontmatterEndLine = 0,
): ParsedTaskLine[] {
  const lines = content.split("\n");
  const tasks: ParsedTaskLine[] = [];
  let fence: FenceState | undefined;
  for (let index = frontmatterEndLine; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const previousFence = fence;
    fence = updateFence(line, fence);
    if (previousFence !== undefined || fence !== previousFence) {
      continue;
    }
    const match = /^\s*(?:[-*+]|\d+[.)])\s+\[([^\]])\]\s+(.*)$/.exec(line);
    const status = match ? taskStatus(match[1] ?? "") : undefined;
    if (!match || status === undefined) {
      continue;
    }
    const text = match[2] ?? "";
    const blockMatch = /(?:^|\s)\^([a-zA-Z0-9][a-zA-Z0-9_-]*)\s*$/.exec(text);
    const dueMatch = /\u{1F4C5}\s*(\d{4}-\d{2}-\d{2})/u.exec(text);
    const scheduledMatch = /\u{23F3}\s*(\d{4}-\d{2}-\d{2})/u.exec(text);
    tasks.push({
      line: index + 1,
      text,
      status,
      ...(blockMatch?.[1] !== undefined ? { blockId: blockMatch[1] } : {}),
      ...(dueMatch?.[1] !== undefined ? { dueDate: dueMatch[1] } : {}),
      ...(scheduledMatch?.[1] !== undefined
        ? { scheduledDate: scheduledMatch[1] }
        : {}),
      priority: taskPriority(text),
      tags: [...new Set(tagsFromText(maskInlineCode(text)))].sort(compareText),
    });
  }
  return tasks;
}

export function parseMarkdown(
  content: string,
  sourcePath: string,
): ParsedMarkdown {
  const { frontmatter, endLine } = parseFrontmatter(content);
  return {
    frontmatter,
    frontmatterEndLine: endLine,
    headings: parseHeadings(content, endLine),
    links: parseWikiLinks(content, sourcePath, endLine),
    tags: extractTags(content, frontmatter, endLine),
    tasks: parseTaskLines(content, endLine),
  };
}
