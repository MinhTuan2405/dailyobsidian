import type { MutationPlan, MutationResult } from "@obsidian-workbench/shared";
import { describe, expect, it } from "vitest";

import { ConfirmationService } from "../src/mutations/confirmation-service.js";
import { InMemoryIdempotencyStore } from "../src/mutations/idempotency-store.js";

function plan(expiresAt: string): MutationPlan {
  return {
    mutationId: "mutation-1",
    vaultId: "vault-1",
    targetPath: "Notes/Target.md",
    operation: "trash",
    requestHash: `sha256:${"a".repeat(64)}`,
    mutationHash: `sha256:${"b".repeat(64)}`,
    diff: {
      path: "Notes/Target.md",
      originalRevision: `sha256:${"c".repeat(64)}`,
      proposedRevision: `sha256:${"c".repeat(64)}`,
      unifiedDiff: "",
      changedSections: ["path"],
      additions: 0,
      deletions: 0,
      riskLevel: "high",
      confirmationRequired: true,
    },
    expiresAt,
  };
}

function result(): MutationResult {
  return {
    operationId: "mutation-1",
    status: "applied",
    idempotentReplay: false,
  };
}

describe("write safety services", () => {
  it("serializes concurrent identical idempotent requests", async () => {
    const store = new InMemoryIdempotencyStore();
    let applyCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = async () => {
      applyCount += 1;
      await gate;
      return result();
    };

    const first = store.execute(
      "user",
      "vault",
      "tool",
      "key",
      "hash",
      operation,
    );
    const second = store.execute(
      "user",
      "vault",
      "tool",
      "key",
      "hash",
      operation,
    );
    await Promise.resolve();
    expect(applyCount).toBe(1);
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.idempotentReplay).toBe(false);
    expect(secondResult.idempotentReplay).toBe(true);
  });

  it("rejects an idempotency key reused with a different request hash", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.execute("user", "vault", "tool", "key", "hash-1", async () =>
      result(),
    );
    await expect(
      store.execute("user", "vault", "tool", "key", "hash-2", async () =>
        result(),
      ),
    ).rejects.toMatchObject({
      toolError: { code: "IDEMPOTENCY_CONFLICT" },
    });
  });

  it("enforces confirmation binding, expiry, and single use", () => {
    let now = Date.parse("2026-07-23T12:00:00.000Z");
    const service = new ConfirmationService({
      secret: "confirmation-secret",
      now: () => now,
    });
    const mutation = plan("2026-07-23T12:05:00.000Z");
    const binding = {
      userId: "user-1",
      vaultId: mutation.vaultId,
      targetPath: mutation.targetPath,
      mutationHash: mutation.mutationHash,
    };
    const token = service.issueFromPlan(mutation, binding.userId, 1000);
    expect(() =>
      service.consume(token, { ...binding, userId: "user-2" }),
    ).toThrow();
    service.consume(token, binding);
    expect(() => service.consume(token, binding)).toThrow();

    const expiring = service.issueFromPlan(mutation, binding.userId, 10);
    now += 11;
    expect(() => service.consume(expiring, binding)).toThrow();
  });
});
