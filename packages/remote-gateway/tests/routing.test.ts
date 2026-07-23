import type { ProtocolRequest } from "@obsidian-workbench/shared";
import { describe, expect, it } from "vitest";

import { RequestRoutingService } from "../src/routing.js";
import { GatewaySessionRegistry } from "../src/sessions.js";
import {
  connectDevice,
  createTestContext,
  FakeSocket,
  pairDevice,
  waitFor,
} from "./helpers.js";

describe("RequestRoutingService", () => {
  it("denies cross-user, cross-vault, and unauthorized-scope requests", async () => {
    const context = createTestContext();
    const paired = await pairDevice(context, {
      userId: "vault-owner",
      vaultId: "private-vault",
      scopes: ["notes.read"],
    });
    const { registry } = await connectDevice(context, paired.exchange);
    const router = new RequestRoutingService({
      repository: context.repository,
      sessions: registry,
      now: () => context.clock.now,
    });
    await context.repository.saveAccount({
      id: "other-account",
      createdAt: context.clock.now,
    });
    const other = context.auth.createSession(
      "other-account",
      context.clock.now,
    ).session;

    await expect(
      router.route({
        user: other,
        vaultId: "private-vault",
        method: "obsidian.get_note",
        params: { vaultId: "private-vault", noteId: "note" },
        scopes: ["notes.read"],
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      router.route({
        user: paired.session,
        vaultId: "private-vault",
        method: "obsidian.get_note",
        params: { vaultId: "different-vault", noteId: "note" },
        scopes: ["notes.read"],
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      router.route({
        user: paired.session,
        vaultId: "private-vault",
        method: "obsidian.update_note",
        params: {
          vaultId: "private-vault",
          idempotencyKey: "mutation-unauthorized",
        },
        scopes: ["notes.update"],
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      router.route({
        user: paired.session,
        vaultId: "private-vault",
        method: "obsidian.execute",
        params: { vaultId: "private-vault", command: "anything" },
        scopes: ["notes.read"],
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("returns VAULT_OFFLINE immediately and never queues destructive writes", async () => {
    const context = createTestContext();
    const paired = await pairDevice(context, {
      userId: "offline-owner",
      vaultId: "offline-vault",
      scopes: ["notes.create"],
    });
    const registry = new GatewaySessionRegistry({
      repository: context.repository,
      tokens: context.tokens,
    });
    const router = new RequestRoutingService({
      repository: context.repository,
      sessions: registry,
      now: () => context.clock.now,
    });
    await expect(
      router.route({
        user: paired.session,
        vaultId: "offline-vault",
        method: "obsidian.create_note",
        params: {
          vaultId: "offline-vault",
          path: "Never Queued.md",
          content: "must not be retained",
          idempotencyKey: "offline-mutation",
        },
        scopes: ["notes.create"],
      }),
    ).rejects.toMatchObject({
      code: "VAULT_OFFLINE",
      message: expect.stringMatching(/not queued/i),
    });
    expect(registry.onlineCount).toBe(0);
    expect(
      JSON.stringify(await context.repository.metadataInventory()),
    ).not.toContain("must not be retained");
  });

  it("routes a request to the matching companion response", async () => {
    const context = createTestContext();
    const paired = await pairDevice(context, {
      userId: "route-owner",
      vaultId: "route-vault",
      scopes: ["notes.read"],
    });
    const { registry, socket } = await connectDevice(context, paired.exchange);
    const router = new RequestRoutingService({
      repository: context.repository,
      sessions: registry,
      now: () => context.clock.now,
      newRequestId: () => "request-routing-1",
      newNonce: () => "nonce-routing-0000000001",
    });
    const responsePromise = router.route({
      user: paired.session,
      vaultId: "route-vault",
      method: "obsidian.get_note",
      params: { vaultId: "route-vault", noteId: "note-1" },
      scopes: ["notes.read"],
    });
    await waitFor(() => socket.sent.length === 1);
    const request = JSON.parse(socket.sent[0] ?? "{}") as ProtocolRequest;
    expect(request).toMatchObject({
      jsonrpc: "2.0",
      id: "request-routing-1",
      userId: "route-owner",
      deviceId: paired.exchange.deviceId,
      vaultId: "route-vault",
      nonce: "nonce-routing-0000000001",
    });
    socket.receive({
      jsonrpc: "2.0",
      id: request.id,
      result: { path: "Safe.md", content: "transient response" },
    });
    await expect(responsePromise).resolves.toMatchObject({
      id: request.id,
      result: { path: "Safe.md", content: "transient response" },
    });
    expect(
      JSON.stringify(await context.repository.metadataInventory()),
    ).not.toContain("transient response");
  });

  it("times out requests and rejects replayed responses", async () => {
    const context = createTestContext();
    const paired = await pairDevice(context, {
      userId: "timeout-owner",
      vaultId: "timeout-vault",
      scopes: ["notes.read"],
    });
    const { registry, socket } = await connectDevice(context, paired.exchange, {
      requestTimeoutMs: 10,
    });
    const router = new RequestRoutingService({
      repository: context.repository,
      sessions: registry,
      now: () => context.clock.now,
      newRequestId: () => "request-timeout-1",
    });
    await expect(
      router.route({
        user: paired.session,
        vaultId: "timeout-vault",
        method: "obsidian.get_note",
        params: { vaultId: "timeout-vault", noteId: "slow-note" },
        scopes: ["notes.read"],
      }),
    ).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    const timedOut = JSON.parse(socket.sent[0] ?? "{}") as ProtocolRequest;
    socket.receive({ jsonrpc: "2.0", id: timedOut.id, result: {} });
    expect(socket.closes.at(-1)?.code).toBe(1008);
  });

  it("rejects duplicate in-flight mutation IDs", async () => {
    const context = createTestContext();
    const paired = await pairDevice(context, {
      userId: "mutation-owner",
      vaultId: "mutation-vault",
      scopes: ["notes.create"],
    });
    const { registry, socket } = await connectDevice(context, paired.exchange);
    let requestNumber = 0;
    const router = new RequestRoutingService({
      repository: context.repository,
      sessions: registry,
      now: () => context.clock.now,
      newRequestId: () => `mutation-request-${++requestNumber}`,
    });
    const mutation = {
      user: paired.session,
      vaultId: "mutation-vault",
      method: "obsidian.create_note",
      params: {
        vaultId: "mutation-vault",
        path: "Created.md",
        content: "not persisted",
        idempotencyKey: "same-mutation-id",
      },
      scopes: ["notes.create"] as const,
    };
    const first = router.route(mutation);
    await waitFor(() => socket.sent.length === 1);
    await expect(router.route(mutation)).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    const request = JSON.parse(socket.sent[0] ?? "{}") as ProtocolRequest;
    socket.receive({
      jsonrpc: "2.0",
      id: request.id,
      result: { status: "applied" },
    });
    await expect(first).resolves.toMatchObject({ id: request.id });
    expect(socket.sent).toHaveLength(1);
    expect(
      JSON.stringify(await context.repository.metadataInventory()),
    ).not.toContain("not persisted");
  });

  it("keeps only the current session for a device and vault", async () => {
    const context = createTestContext();
    const paired = await pairDevice(context, {
      userId: "replacement-owner",
      vaultId: "replacement-vault",
      scopes: ["notes.read"],
    });
    const registry = new GatewaySessionRegistry({
      repository: context.repository,
      tokens: context.tokens,
    });
    const first = new FakeSocket();
    const second = new FakeSocket();
    const hello = {
      type: "hello",
      protocolVersion: 1,
      deviceId: paired.exchange.deviceId,
      vaultId: paired.exchange.vaultId,
      deviceToken: paired.exchange.deviceToken,
      vaultToken: paired.exchange.vaultToken,
      scopes: paired.exchange.scopes,
    };
    registry.accept(first);
    first.receive(hello);
    await waitFor(() => registry.onlineCount === 1);
    registry.accept(second);
    second.receive(hello);
    await waitFor(() => first.closes.length === 1);
    expect(first.closes[0]?.code).toBe(4001);
    expect(registry.onlineCount).toBe(1);
  });

  it("accepts an event sent immediately after hello through the typed event boundary", async () => {
    const context = createTestContext();
    const paired = await pairDevice(context, {
      userId: "event-owner",
      vaultId: "event-vault",
      scopes: ["notes.read"],
    });
    const events: Array<{ userId: string; type: string }> = [];
    const registry = new GatewaySessionRegistry({
      repository: context.repository,
      tokens: context.tokens,
      eventSink: {
        async publish(identity, event) {
          events.push({ userId: identity.userId, type: event.type });
        },
      },
    });
    const socket = new FakeSocket();
    registry.accept(socket);
    socket.receive({
      type: "hello",
      protocolVersion: 1,
      deviceId: paired.exchange.deviceId,
      vaultId: paired.exchange.vaultId,
      deviceToken: paired.exchange.deviceToken,
      vaultToken: paired.exchange.vaultToken,
      scopes: paired.exchange.scopes,
    });
    socket.receive({
      type: "vault.connected",
      vaultId: paired.exchange.vaultId,
      occurredAt: "2026-07-24T00:00:00.000Z",
    });

    await waitFor(() => events.length === 1);
    expect(events).toEqual([
      { userId: "event-owner", type: "vault.connected" },
    ]);
    expect(registry.onlineCount).toBe(1);
    expect(socket.closes).toHaveLength(0);
  });

  it("rejects hello credentials with a different vault or scope set", async () => {
    const context = createTestContext();
    const paired = await pairDevice(context, {
      userId: "hello-owner",
      vaultId: "hello-vault",
      scopes: ["notes.read"],
    });
    const registry = new GatewaySessionRegistry({
      repository: context.repository,
      tokens: context.tokens,
    });
    const wrongVault = new FakeSocket();
    registry.accept(wrongVault);
    wrongVault.receive({
      type: "hello",
      protocolVersion: 1,
      deviceId: paired.exchange.deviceId,
      vaultId: "other-vault",
      deviceToken: paired.exchange.deviceToken,
      vaultToken: paired.exchange.vaultToken,
      scopes: paired.exchange.scopes,
    });
    await waitFor(() => wrongVault.closes.length === 1);

    const wrongScopes = new FakeSocket();
    registry.accept(wrongScopes);
    wrongScopes.receive({
      type: "hello",
      protocolVersion: 1,
      deviceId: paired.exchange.deviceId,
      vaultId: paired.exchange.vaultId,
      deviceToken: paired.exchange.deviceToken,
      vaultToken: paired.exchange.vaultToken,
      scopes: [],
    });
    await waitFor(() => wrongScopes.closes.length === 1);
    expect(registry.onlineCount).toBe(0);
    expect(wrongVault.closes[0]?.reason).toBe("Authentication failed");
    expect(wrongScopes.closes[0]?.reason).toBe("Authentication failed");
  });
});
