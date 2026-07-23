import { describe, expect, it } from "vitest";

import { createTestContext } from "./helpers.js";

describe("TokenService", () => {
  it("enforces token expiry", async () => {
    const context = createTestContext(1_000_500);
    const issued = await context.tokens.issue({
      type: "vault_authorization",
      id: "expiry-device",
      userId: "expiry-user",
      vaultId: "expiry-vault",
      scopes: ["notes.read"],
      ttlMs: 1_000,
    });
    context.clock.now += 999;
    await expect(
      context.tokens.verify(issued.token, "vault_authorization"),
    ).resolves.toMatchObject({ id: "expiry-device" });
    context.clock.now += 1;
    await expect(
      context.tokens.verify(issued.token, "vault_authorization"),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });

  it("enforces metadata revocation", async () => {
    const context = createTestContext();
    const issued = await context.tokens.issue({
      type: "vault_authorization",
      id: "revoked-device",
      userId: "revoked-user",
      vaultId: "revoked-vault",
      scopes: ["notes.read"],
      ttlMs: 60_000,
    });
    expect(await context.tokens.revoke(issued.claims.jti)).toBe(true);
    await expect(
      context.tokens.verify(issued.token, "vault_authorization"),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });

  it("does not accept a device identity token as vault authorization", async () => {
    const context = createTestContext();
    const issued = await context.tokens.issue({
      type: "device_identity",
      id: "identity-device",
      userId: "identity-user",
      vaultId: "identity-vault",
      scopes: [],
      ttlMs: 60_000,
    });
    await expect(
      context.tokens.verify(issued.token, "vault_authorization"),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });

  it("does not accept vault authorization as device identity", async () => {
    const context = createTestContext();
    const issued = await context.tokens.issue({
      type: "vault_authorization",
      id: "authorization-device",
      userId: "authorization-user",
      vaultId: "authorization-vault",
      scopes: ["notes.read"],
      ttlMs: 60_000,
    });
    await expect(
      context.tokens.verify(issued.token, "device_identity"),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });
});
