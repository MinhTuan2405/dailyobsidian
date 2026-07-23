import type { ProtocolRequest, VaultInfo } from "@obsidian-workbench/shared";
import type { VaultAdapter } from "@obsidian-workbench/vault-core";
import { describe, expect, it, vi } from "vitest";

import { AuditLog } from "../src/audit.js";
import { GatewayClient, type WebSocketLike } from "../src/gateway.js";
import { RequestRouter } from "../src/router.js";

const vaultInfo: VaultInfo = {
  vaultId: "vault-1",
  name: "Test",
  status: { state: "online", mode: "companion" },
  capabilities: {
    scopes: ["vault.metadata.read", "notes.read"],
    supportsTrash: false,
    supportsFileManagerMoves: true,
    supportsEvents: true,
    supportsOpenInObsidian: true,
  },
  allowedRoots: ["."],
  excludedRoots: [".obsidian"],
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

function request(overrides: Partial<ProtocolRequest> = {}): ProtocolRequest {
  return {
    jsonrpc: "2.0",
    id: "request-1",
    method: "obsidian.get_vault_info",
    params: { vaultId: "vault-1" },
    userId: "user-1",
    deviceId: "device-1",
    vaultId: "vault-1",
    scopes: ["vault.metadata.read"],
    issuedAt: new Date().toISOString(),
    nonce: "nonce-0000000000000001",
    ...overrides,
  };
}

function setupRouter() {
  const getVaultInfo = vi.fn(async () => vaultInfo);
  const listNotes = vi.fn(async () => ({ items: [], total: 0 }));
  const adapter = { getVaultInfo, listNotes } as unknown as VaultAdapter;
  const audit = new AuditLog(
    [],
    () => 100,
    () => undefined,
  );
  const router = new RequestRouter({
    adapter,
    audit,
    identity: () => ({
      deviceId: "device-1",
      userId: "user-1",
      vaultId: "vault-1",
      scopes: ["vault.metadata.read", "notes.read"],
    }),
    enabledScopes: () => ["vault.metadata.read", "notes.read"],
  });
  return { router, audit, getVaultInfo, listNotes };
}

describe("RequestRouter", () => {
  it("rejects a replayed nonce", async () => {
    const { router, getVaultInfo } = setupRouter();
    expect((await router.route(request())).error).toBeUndefined();
    const replay = await router.route(request());
    expect(replay.error?.code).toBe("PERMISSION_DENIED");
    expect(getVaultInfo).toHaveBeenCalledOnce();
  });

  it("rejects a missing or unauthorized method scope", async () => {
    const { router, listNotes } = setupRouter();
    const response = await router.route(
      request({
        id: "request-2",
        nonce: "nonce-0000000000000002",
        method: "obsidian.list_notes",
        params: { vaultId: "vault-1" },
        scopes: ["vault.metadata.read"],
      }),
    );
    expect(response.error?.code).toBe("PERMISSION_DENIED");
    expect(listNotes).not.toHaveBeenCalled();
  });

  it("routes only explicit allowlisted methods", async () => {
    const { router } = setupRouter();
    const response = await router.route(
      request({
        id: "request-3",
        nonce: "nonce-0000000000000003",
        method: "obsidian.execute",
        params: { vaultId: "vault-1", command: "anything" },
      }),
    );
    expect(response.error?.code).toBe("UNSUPPORTED_OPERATION");
  });

  it("rejects a parameter vault that differs from the authenticated vault", async () => {
    const { router, getVaultInfo } = setupRouter();
    const response = await router.route(
      request({
        id: "request-4",
        nonce: "nonce-0000000000000004",
        params: { vaultId: "vault-2" },
      }),
    );
    expect(response.error?.code).toBe("PERMISSION_DENIED");
    expect(getVaultInfo).not.toHaveBeenCalled();
  });
});

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  receive(value: unknown): void {
    this.onmessage?.(
      new MessageEvent("message", {
        data: typeof value === "string" ? value : JSON.stringify(value),
      }),
    );
  }
}

describe("GatewayClient", () => {
  it("does not queue protocol responses or events while offline", () => {
    const gateway = new GatewayClient({
      onRequest: vi.fn(),
      onStatus: vi.fn(),
    });
    expect(() => gateway.send({ jsonrpc: "2.0", id: "x", result: {} })).toThrow(
      /not queued/i,
    );
    expect(
      gateway.sendEvent({
        type: "vault.connected",
        vaultId: "vault-1",
        occurredAt: new Date().toISOString(),
      }),
    ).toBe(false);
  });

  it("sends an authenticated hello and emergency disconnect prevents reuse", () => {
    const socket = new FakeSocket();
    const gateway = new GatewayClient({
      onRequest: vi.fn(),
      onStatus: vi.fn(),
      createSocket: () => socket,
    });
    gateway.connect({
      gatewayUrl: "wss://gateway.example.test/device",
      deviceId: "device-1",
      vaultId: "vault-1",
      deviceToken: "device-token-value-1234567890",
      vaultToken: "vault-token-value-123456789012",
      scopes: ["notes.read"],
    });
    socket.open();
    expect(gateway.state).toBe("connecting");
    expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({
      type: "hello",
      deviceId: "device-1",
      vaultId: "vault-1",
      deviceToken: "device-token-value-1234567890",
      vaultToken: "vault-token-value-123456789012",
    });
    socket.receive({
      type: "ready",
      protocolVersion: 1,
      deviceId: "device-1",
      vaultId: "vault-1",
    });
    expect(gateway.state).toBe("online");
    gateway.emergencyDisconnect();
    expect(gateway.state).toBe("offline");
    expect(() =>
      gateway.send({ jsonrpc: "2.0", id: "x", result: {} }),
    ).toThrow();
  });
});
