import { createHash } from "node:crypto";

export function normalizeNoteContent(content: string): string {
  const withoutBom = content.startsWith("\uFEFF") ? content.slice(1) : content;
  return withoutBom.replace(/\r\n?/g, "\n");
}

export function createRevision(content: string): string {
  const digest = createHash("sha256")
    .update(normalizeNoteContent(content), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

export function createStableId(namespace: string, identity: string): string {
  const digest = createHash("sha256")
    .update(namespace, "utf8")
    .update("\0", "utf8")
    .update(identity, "utf8")
    .digest("hex");
  return `${namespace}_${digest}`;
}
