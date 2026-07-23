import {
  MutationPlanSchema,
  MutationResultSchema,
  type MutationPlan,
  type MutationResult,
  type NoteIdentity,
} from "@obsidian-workbench/shared";
import { createTwoFilesPatch, diffLines } from "diff";

import { createRevision, hashValue, normalizeContent } from "./hash.js";

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

function lineCount(value: string, count?: number): number {
  if (count !== undefined) return count;
  if (value === "") return 0;
  const lines = value.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export function mutationRequestHash(tool: string, input: object): string {
  const payload = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) =>
        key !== "confirmationToken" &&
        key !== "dryRun" &&
        key !== "idempotencyKey",
    ),
  );
  return `sha256:${hashValue({ tool, payload })}`;
}

export function buildMutationPlan(input: MutationPlanInput): MutationPlan {
  const original = normalizeContent(input.originalContent ?? "");
  const proposed = normalizeContent(input.proposedContent);
  const targetPath = input.targetPath ?? input.sourcePath;
  const changes = diffLines(original, proposed);
  const additions = changes
    .filter((change) => change.added)
    .reduce(
      (total, change) => total + lineCount(change.value, change.count),
      0,
    );
  const deletions = changes
    .filter((change) => change.removed)
    .reduce(
      (total, change) => total + lineCount(change.value, change.count),
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
  const mutationHash = `sha256:${hashValue({
    vaultId: input.vaultId,
    targetNoteId: input.targetNoteId,
    sourcePath: input.sourcePath,
    targetPath,
    operation: input.operation,
    originalRevision,
    proposedRevision,
    unifiedDiff,
  })}`;
  return MutationPlanSchema.parse({
    mutationId: `mutation_${hashValue({ requestHash: input.requestHash, mutationHash })}`,
    vaultId: input.vaultId,
    ...(input.targetNoteId === undefined
      ? {}
      : { targetNoteId: input.targetNoteId }),
    targetPath,
    operation: input.operation,
    requestHash: input.requestHash,
    mutationHash,
    diff: {
      path: targetPath,
      ...(originalRevision === undefined ? {} : { originalRevision }),
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

export function mutationResult(
  plan: MutationPlan,
  status: "preview" | "applied" | "unchanged",
  note?: NoteIdentity,
): MutationResult {
  return MutationResultSchema.parse({
    operationId: `operation_${hashValue({ mutationId: plan.mutationId, status })}`,
    status,
    ...(note === undefined ? {} : { note }),
    diff: plan.diff,
    ...(status === "preview" ? { plan } : {}),
    idempotentReplay: false,
  });
}
