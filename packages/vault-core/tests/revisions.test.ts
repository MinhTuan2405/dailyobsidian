import { describe, expect, it } from "vitest";

import { createRevision, normalizeNoteContent } from "../src/index.js";

describe("content revisions", () => {
  it("normalizes BOM and newline forms before hashing", () => {
    const normalized = "alpha\nbeta\n";
    expect(normalizeNoteContent(`\uFEFFalpha\r\nbeta\r`)).toBe(normalized);
    expect(createRevision(`\uFEFFalpha\r\nbeta\r`)).toBe(
      createRevision(normalized),
    );
    expect(createRevision(normalized)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
