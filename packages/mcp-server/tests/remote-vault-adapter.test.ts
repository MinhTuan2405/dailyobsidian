import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import {
  MutationResultSchema,
  WorkbenchError,
  toToolError,
  type MutationPlan,
  type PermissionScope,
  type ProtocolResponse,
  type VaultInfo,
} from "@obsidian-workbench/shared";

import {
  RemoteVaultAdapter,
  createRemoteVaultRegistry,
  type RemoteRouteRequest,
  type RemoteRoutingBoundary,
  type RemoteUserSession,
  type RemoteVaultDescriptor,
} from "../src/adapters/remote-vault-adapter.js";
import { createMcpServer } from "../src/server.js";

const USER: RemoteUserSession = {
  sessionId: "remote-session",
  userId: "remote-user",
  authenticatedAt: 1_750_000_000_000,
  expiresAt: 1_850_000_000_000,
};

const SCOPES: PermissionScope[] = [
  "vault.metadata.read",
  "notes.read",
  "notes.update",
  "notes.move",
  "notes.trash",
];

const VAULT: RemoteVaultDescriptor = {
  vaultId: "remote-vault",
  name: "Remote Vault",
  scopes: SCOPES,
  allowedRoots: ["Notes"],
  excludedRoots: ["Private"],
};

const REVISION_A = `sha256:${"a".repeat(64)}`;
const MUTATION_HASH = `sha256:${"c".repeat(64)}`;
const NOW = Date.parse("2026-07-23T12:00:00.000Z");

function vaultInfo(): VaultInfo {
  return {
    vaultId: VAULT.vaultId,
    name: VAULT.name,
    status: { state: "online", mode: "companion" },
    capabilities: {
      scopes: SCOPES,
      supportsTrash: true,
      supportsFileManagerMoves: true,
      supportsEvents: true,
      supportsOpenInObsidian: true,
    },
    allowedRoots: ["Notes"],
    excludedRoots: ["Private", ".obsidian"],
    conventions: {
      inboxFolder: "Inbox",
      dailyNotesFolder: "Daily",
      dailyNoteFormat: "YYYY-MM-DD",
      dateFormat: "YYYY-MM-DD",
      templatePaths: [],
      taskSyntax: "- [ ]",
      preferredLinkStyle: "wikilink",
      defaultFrontmatter: {},
    },
  };
}

function response(result: unknown): ProtocolResponse {
  return { jsonrpc: "2.0", id: "remote-response", result };
}

function routingWith(
  handler: (request: RemoteRouteRequest) => Promise<ProtocolResponse>,
): { routing: RemoteRoutingBoundary; requests: RemoteRouteRequest[] } {
  const requests: RemoteRouteRequest[] = [];
  return {
    requests,
    routing: {
      async route(request) {
        requests.push(request);
        return await handler(request);
      },
    },
  };
}

describe("RemoteVaultAdapter", () => {
  it("routes canonical methods with authenticated context, least scope, and parsed schemas", async () => {
    const { routing, requests } = routingWith(async () =>
      response({ items: [], total: 0 }),
    );
    const adapter = new RemoteVaultAdapter({
      routing,
      user: USER,
      vault: VAULT,
    });

    await expect(
      adapter.listNotes({ vaultId: VAULT.vaultId }),
    ).resolves.toEqual({ items: [], total: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      user: USER,
      vaultId: VAULT.vaultId,
      method: "obsidian.list_notes",
      params: {
        vaultId: VAULT.vaultId,
        tags: [],
        sort: "modified",
        order: "desc",
        limit: 50,
      },
      scopes: ["notes.read"],
    });
  });

  it("sanitizes structured remote errors and rejects invalid remote results", async () => {
    const errors = routingWith(async () => ({
      jsonrpc: "2.0",
      id: "remote-error",
      error: {
        code: "NOTE_NOT_FOUND",
        message: "C:\\Users\\owner\\Secret.md could not be read",
        data: { absolutePath: "C:\\Users\\owner\\Secret.md" },
      },
    }));
    const errorAdapter = new RemoteVaultAdapter({
      routing: errors.routing,
      user: USER,
      vault: VAULT,
    });
    const remoteError = await errorAdapter
      .readNote({ vaultId: VAULT.vaultId, noteId: "missing-note" })
      .catch((error: unknown) => error);

    expect(remoteError).toBeInstanceOf(WorkbenchError);
    expect(toToolError(remoteError)).toEqual({
      code: "NOTE_NOT_FOUND",
      message: "The requested note could not be found.",
      recoverable: true,
    });
    expect(JSON.stringify(toToolError(remoteError))).not.toContain("Secret.md");

    const invalid = routingWith(async () => response({ hits: [], total: 0 }));
    const invalidAdapter = new RemoteVaultAdapter({
      routing: invalid.routing,
      user: USER,
      vault: VAULT,
    });
    const invalidResult = await invalidAdapter
      .searchNotes({
        vaultId: VAULT.vaultId,
        search: { query: "needle" },
      })
      .catch((error: unknown) => error);
    expect(toToolError(invalidResult)).toEqual({
      code: "INTERNAL_ERROR",
      message: "The remote vault returned an invalid response.",
      recoverable: false,
    });
  });

  it("reports an offline inventory entry and fails operations without leaking routing errors", async () => {
    const { routing, requests } = routingWith(async () => {
      throw {
        code: "VAULT_OFFLINE",
        message: "socket failed at ws://internal-device:4312",
      };
    });
    const adapter = new RemoteVaultAdapter({
      routing,
      user: USER,
      vault: VAULT,
    });

    await expect(adapter.getVaultInfo()).resolves.toMatchObject({
      vaultId: VAULT.vaultId,
      name: VAULT.name,
      status: {
        state: "offline",
        mode: "remote",
        lastError: "The remote vault is offline or unavailable.",
      },
      capabilities: { scopes: SCOPES },
    });
    const error = await adapter
      .listNotes({ vaultId: VAULT.vaultId })
      .catch((caught: unknown) => caught);
    expect(toToolError(error)).toEqual({
      code: "VAULT_OFFLINE",
      message: "The remote vault is offline or unavailable.",
      recoverable: true,
    });
    expect(JSON.stringify(toToolError(error))).not.toContain("internal-device");
    expect(requests).toHaveLength(2);
  });

  it("enforces configured scopes before invoking remote routing", async () => {
    const { routing, requests } = routingWith(async () =>
      response({ items: [] }),
    );
    const adapter = new RemoteVaultAdapter({
      routing,
      user: USER,
      vault: { ...VAULT, scopes: ["vault.metadata.read"] },
    });

    const error = await adapter
      .listNotes({ vaultId: VAULT.vaultId })
      .catch((caught: unknown) => caught);
    expect(toToolError(error).code).toBe("PERMISSION_DENIED");
    expect(requests).toHaveLength(0);
  });

  it("gates a high-risk MCP confirmation round trip against the cached remote plan", async () => {
    const plans: MutationPlan[] = [];
    const { routing, requests } = routingWith(async (request) => {
      if (request.method === "obsidian.get_vault_info") {
        return response(vaultInfo());
      }
      if (request.method !== "obsidian.trash_note") {
        throw new Error(`Unexpected method: ${request.method}`);
      }
      if (request.params.dryRun !== false) {
        const plan: MutationPlan = {
          mutationId: "mutation_remote_trash",
          vaultId: VAULT.vaultId,
          targetNoteId: request.params.noteId,
          targetPath: "Notes/Reviewed.md",
          operation: "trash",
          requestHash: writeHash("trashNote", request.params),
          mutationHash: MUTATION_HASH,
          diff: {
            path: "Notes/Reviewed.md",
            originalRevision: REVISION_A,
            proposedRevision: REVISION_A,
            unifiedDiff: "reviewed remote trash",
            changedSections: ["path"],
            additions: 0,
            deletions: 0,
            riskLevel: "high",
            confirmationRequired: true,
          },
          expiresAt: new Date(NOW + 5 * 60 * 1000).toISOString(),
        };
        plans.push(plan);
        return response({
          operationId: "operation_remote_preview",
          status: "preview",
          diff: plan.diff,
          plan,
          idempotentReplay: false,
        });
      }
      return response({
        operationId: "operation_remote_applied",
        status: "applied",
        diff: plans[0]?.diff,
        idempotentReplay: false,
      });
    });
    const registry = createRemoteVaultRegistry({
      routing,
      user: USER,
      vaults: [VAULT],
      confirmation: { secret: "remote-confirmation-secret" },
      now: () => NOW,
    });
    const server = createMcpServer(registry);
    const client = new Client({ name: "remote-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    try {
      const mutation = {
        vaultId: VAULT.vaultId,
        noteId: "reviewed-note",
        expectedRevision: REVISION_A,
        idempotencyKey: "remote-trash-0001",
      };
      const previewCall = await client.callTool({
        name: "obsidian.trash_note",
        arguments: { ...mutation, dryRun: true },
      });
      const preview = MutationResultSchema.parse(previewCall.structuredContent);
      expect(preview.plan?.diff.confirmationRequired).toBe(true);
      if (preview.plan === undefined) throw new Error("Preview plan missing");

      const denied = await client.callTool({
        name: "obsidian.trash_note",
        arguments: { ...mutation, dryRun: false },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.content)).toContain("CONFIRMATION_REQUIRED");
      expect(
        requests.filter(
          (request) =>
            request.method === "obsidian.trash_note" &&
            request.params.dryRun === false,
        ),
      ).toHaveLength(0);

      const tampered = await client.callTool({
        name: "obsidian.ui.confirm_mutation",
        arguments: {
          plan: { ...preview.plan, targetPath: "Notes/Other.md" },
        },
      });
      expect(tampered.isError).toBe(true);

      const confirmation = await client.callTool({
        name: "obsidian.ui.confirm_mutation",
        arguments: { plan: preview.plan },
      });
      const confirmationToken = (
        confirmation.structuredContent as { confirmationToken: string }
      ).confirmationToken;
      expect(decodeConfirmation(confirmationToken)).toMatchObject({
        userId: USER.userId,
        vaultId: VAULT.vaultId,
        targetPath: preview.plan.targetPath,
        mutationHash: preview.plan.mutationHash,
      });

      const applied = await client.callTool({
        name: "obsidian.trash_note",
        arguments: {
          ...mutation,
          dryRun: false,
          confirmationToken,
        },
      });
      expect(MutationResultSchema.parse(applied.structuredContent).status).toBe(
        "applied",
      );
      const routedApplications = requests.filter(
        (request) =>
          request.method === "obsidian.trash_note" &&
          request.params.dryRun === false,
      );
      expect(routedApplications).toHaveLength(1);
      expect(routedApplications[0]).toMatchObject({
        params: { confirmationToken },
      });

      const replay = await client.callTool({
        name: "obsidian.trash_note",
        arguments: {
          ...mutation,
          dryRun: false,
          confirmationToken,
        },
      });
      expect(replay.isError).toBe(true);
      expect(
        requests.filter(
          (request) =>
            request.method === "obsidian.trash_note" &&
            request.params.dryRun === false,
        ),
      ).toHaveLength(1);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});

function writeHash(tool: string, input: object): string {
  const payload = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) =>
        key !== "confirmationToken" &&
        key !== "dryRun" &&
        key !== "idempotencyKey",
    ),
  );
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize({ tool, payload })), "utf8")
    .digest("hex")}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function decodeConfirmation(token: string): Record<string, unknown> {
  const encoded = token.split(".")[0];
  if (encoded === undefined) throw new Error("Invalid confirmation token");
  return JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}
