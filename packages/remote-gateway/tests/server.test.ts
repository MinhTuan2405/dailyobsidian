import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createGatewayServer, type GatewayServer } from "../src/server.js";
import { GatewaySessionRegistry } from "../src/sessions.js";
import { createTestContext } from "./helpers.js";

const servers: GatewayServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      ({ httpServer }) =>
        new Promise<void>((resolve, reject) => {
          httpServer.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        }),
    ),
  );
});

describe("createGatewayServer", () => {
  it("requires TLS by default and never enables wildcard CORS", async () => {
    const context = createTestContext();
    const sessions = new GatewaySessionRegistry({
      repository: context.repository,
      tokens: context.tokens,
    });
    expect(() =>
      createGatewayServer({
        auth: context.auth,
        pairing: context.pairing,
        sessions,
        corsAllowedOrigins: ["*"],
      }),
    ).toThrow(/wildcard/i);

    const gateway = createGatewayServer({
      auth: context.auth,
      pairing: context.pairing,
      sessions,
    });
    servers.push(gateway);
    const baseUrl = await listen(gateway);
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(426);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("exposes authenticated pairing and opt-in exact-origin CORS", async () => {
    const context = createTestContext();
    await context.repository.saveAccount({
      id: "http-account",
      createdAt: context.clock.now,
    });
    const accountSession = context.auth.createSession(
      "http-account",
      context.clock.now,
    );
    const sessions = new GatewaySessionRegistry({
      repository: context.repository,
      tokens: context.tokens,
    });
    const gateway = createGatewayServer({
      auth: context.auth,
      pairing: context.pairing,
      sessions,
      now: () => context.clock.now,
      allowInsecureHttpForDevelopment: true,
      corsAllowedOrigins: ["https://app.example.test"],
    });
    servers.push(gateway);
    const baseUrl = await listen(gateway);

    const denied = await fetch(`${baseUrl}/health`, {
      headers: { origin: "https://untrusted.example.test" },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();

    const response = await fetch(`${baseUrl}/v1/pairing/create`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accountSession.sessionToken}`,
        "content-type": "application/json",
        origin: "https://app.example.test",
      },
      body: JSON.stringify({
        vaultId: "http-vault",
        scopes: ["notes.read"],
      }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.test",
    );
    await expect(response.json()).resolves.toMatchObject({
      vaultId: "http-vault",
      scopes: ["notes.read"],
      code: expect.stringMatching(/^[A-Z2-9-]+$/),
    });
  });
});

async function listen(gateway: GatewayServer): Promise<string> {
  await new Promise<void>((resolve) => {
    gateway.httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = gateway.httpServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
