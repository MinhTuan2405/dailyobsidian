import { describe, expect, it } from "vitest";

import { parseMarkdown } from "../src/index.js";

const markdown = `---
title: Alpha
tags: [project, test]
owner:
  name: Ada
---
# Heading One
Body #inline/tag with [[Beta|The beta]] and ![[Asset#Preview]].

Section two
-----------

- [ ] Ship the feature 🔺 📅 2026-07-24 #project ^ship-it
- [x] Completed task

\`[[Ignored inline]]\`

\`\`\`md
## Ignored heading
[[Ignored fenced]]
- [ ] Ignored task
\`\`\`
`;

describe("Markdown parsing", () => {
  it("parses frontmatter, Markdown headings, tags, links, and tasks", () => {
    const parsed = parseMarkdown(markdown, "Notes/Alpha.md");

    expect(parsed.frontmatter).toMatchObject({
      title: "Alpha",
      tags: ["project", "test"],
      owner: { name: "Ada" },
    });
    expect(parsed.headings.map(({ text, level }) => ({ text, level }))).toEqual(
      [
        { text: "Heading One", level: 1 },
        { text: "Section two", level: 2 },
      ],
    );
    expect(parsed.links.map((link) => link.target)).toEqual(["Beta", "Asset"]);
    expect(parsed.links[0]).toMatchObject({
      alias: "The beta",
      embedded: false,
    });
    expect(parsed.links[1]).toMatchObject({
      heading: "Preview",
      embedded: true,
    });
    expect(parsed.tags).toEqual(
      expect.arrayContaining(["#project", "#inline/tag"]),
    );
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0]).toMatchObject({
      status: "open",
      priority: "highest",
      dueDate: "2026-07-24",
      blockId: "ship-it",
    });
  });

  it("rejects duplicate or malformed YAML keys", () => {
    expect(() =>
      parseMarkdown("---\nkey: one\nkey: two\n---\nBody", "Bad.md"),
    ).toThrow();
  });
});
