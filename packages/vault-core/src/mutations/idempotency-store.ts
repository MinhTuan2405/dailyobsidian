import {
  WorkbenchError,
  type MutationResult,
} from "@obsidian-workbench/shared";

interface StoredMutation {
  requestHash: string;
  result: Promise<MutationResult>;
  settled: boolean;
}

function idempotencyConflict(): WorkbenchError {
  return new WorkbenchError({
    code: "IDEMPOTENCY_CONFLICT",
    message: "The idempotency key was already used for a different request.",
    recoverable: true,
  });
}

export class InMemoryIdempotencyStore {
  readonly #entries = new Map<string, StoredMutation>();
  readonly #maxEntries: number;

  constructor(maxEntries = 10_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new WorkbenchError({
        code: "VALIDATION_ERROR",
        message: "The idempotency store size is invalid.",
        recoverable: true,
      });
    }
    this.#maxEntries = maxEntries;
  }

  async execute(
    userId: string,
    vaultId: string,
    tool: string,
    key: string,
    requestHash: string,
    operation: () => Promise<MutationResult>,
  ): Promise<MutationResult> {
    const storeKey = JSON.stringify([userId, vaultId, tool, key]);
    const existing = this.#entries.get(storeKey);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) throw idempotencyConflict();
      const result = await existing.result;
      return { ...result, idempotentReplay: true };
    }

    const stored: StoredMutation = {
      requestHash,
      result: Promise.resolve().then(operation),
      settled: false,
    };
    this.#entries.set(storeKey, stored);
    try {
      const result = await stored.result;
      stored.settled = true;
      this.#trim();
      return result;
    } catch (error) {
      if (this.#entries.get(storeKey) === stored) {
        this.#entries.delete(storeKey);
      }
      throw error;
    }
  }

  #trim(): void {
    if (this.#entries.size <= this.#maxEntries) return;
    for (const [key, entry] of this.#entries) {
      if (entry.settled) this.#entries.delete(key);
      if (this.#entries.size <= this.#maxEntries) return;
    }
  }
}
