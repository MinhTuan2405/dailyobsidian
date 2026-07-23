import { describe, expect, it, vi } from "vitest";

import { AuditLog } from "../src/audit.js";

describe("AuditLog", () => {
  it("retains only whitelisted metadata and never bodies or tokens", () => {
    const changed = vi.fn();
    const log = new AuditLog([], () => 20, changed);
    log.record({
      operationId: "op-1",
      method: "obsidian.update_note",
      target: "Notes/a.md",
      resultCode: "OK",
      durationMs: 12,
      confirmationUsed: true,
      body: "private note body",
      deviceToken: "secret-token",
    } as Parameters<AuditLog["record"]>[0]);

    const serialized = JSON.stringify(log.entries);
    expect(serialized).not.toContain("private note body");
    expect(serialized).not.toContain("secret-token");
    expect(Object.keys(log.entries[0] ?? {})).toEqual([
      "timestamp",
      "operationId",
      "method",
      "target",
      "resultCode",
      "durationMs",
      "confirmationUsed",
    ]);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("enforces bounded retention for new and loaded entries", () => {
    const loaded = Array.from({ length: 30 }, (_, index) => ({
      timestamp: new Date(index * 1000).toISOString(),
      operationId: `op-${index}`,
      method: "obsidian.get_note",
      target: `note-${index}`,
      resultCode: "OK",
      durationMs: index,
      confirmationUsed: false,
      token: "must-be-dropped",
    }));
    const log = new AuditLog(
      loaded,
      () => 10,
      () => undefined,
    );
    expect(log.entries).toHaveLength(10);
    expect(JSON.stringify(log.entries)).not.toContain("must-be-dropped");

    log.record({
      operationId: "new",
      method: "obsidian.list_notes",
      resultCode: "OK",
      durationMs: 1,
      confirmationUsed: false,
    });
    expect(log.entries).toHaveLength(10);
    expect(log.entries[0]?.operationId).toBe("new");
  });
});
