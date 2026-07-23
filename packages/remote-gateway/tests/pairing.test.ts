import { describe, expect, it } from "vitest";

import { GatewayError } from "../src/errors.js";
import type { ExchangePairingInput } from "../src/pairing.js";
import { createTestContext, pairDevice } from "./helpers.js";

describe("PairingService", () => {
  it("expires pairing codes and consumes successful codes exactly once", async () => {
    const context = createTestContext();
    await context.repository.saveAccount({
      id: "account-expiry",
      createdAt: context.clock.now,
    });
    const { session } = context.auth.createSession(
      "account-expiry",
      context.clock.now,
    );
    const expiring = await context.pairing.createCode(session, {
      vaultId: "vault-expiry",
      scopes: ["notes.read"],
      ttlMs: 30_000,
    });
    context.clock.now = expiring.expiresAt;
    await expect(
      context.pairing.exchangeCode({
        code: expiring.code,
        vaultId: "vault-expiry",
        vaultName: "Expiry Vault",
        scopes: ["notes.read"],
      }),
    ).rejects.toMatchObject({ code: "PAIRING_INVALID" });

    context.clock.now += 1;
    const singleUse = await context.pairing.createCode(session, {
      vaultId: "vault-once",
      scopes: ["notes.read"],
    });
    const request: ExchangePairingInput = {
      code: singleUse.code,
      vaultId: "vault-once",
      vaultName: "Single Use",
      scopes: ["notes.read"],
    };
    await expect(context.pairing.exchangeCode(request)).resolves.toMatchObject({
      userId: "account-expiry",
      vaultId: "vault-once",
      scopes: ["notes.read"],
    });
    await expect(context.pairing.exchangeCode(request)).rejects.toMatchObject({
      code: "PAIRING_INVALID",
    });
  });

  it("does not exchange a code for another vault or unselected scopes", async () => {
    const context = createTestContext();
    await context.repository.saveAccount({
      id: "pairing-owner",
      createdAt: context.clock.now,
    });
    const { session } = context.auth.createSession(
      "pairing-owner",
      context.clock.now,
    );
    const created = await context.pairing.createCode(session, {
      vaultId: "owned-vault",
      scopes: ["notes.read"],
    });
    await expect(
      context.pairing.exchangeCode({
        code: created.code,
        vaultId: "other-vault",
        vaultName: "Other",
        scopes: ["notes.read"],
      }),
    ).rejects.toBeInstanceOf(GatewayError);
    await expect(
      context.pairing.exchangeCode({
        code: created.code,
        vaultId: "owned-vault",
        vaultName: "Owned",
        scopes: ["notes.update"],
      }),
    ).rejects.toMatchObject({ code: "PAIRING_INVALID" });

    await expect(
      context.pairing.exchangeCode({
        code: created.code,
        vaultId: "owned-vault",
        vaultName: "Owned",
        scopes: ["notes.read"],
      }),
    ).resolves.toMatchObject({ userId: "pairing-owner" });
  });

  it("revokes device and token records together", async () => {
    const context = createTestContext();
    const paired = await pairDevice(context, {
      userId: "revoke-owner",
      vaultId: "revoke-vault",
      scopes: ["notes.read"],
    });
    await context.pairing.revokeDevice(
      paired.exchange.deviceToken,
      paired.exchange.deviceId,
    );
    await expect(
      context.tokens.verify(paired.exchange.deviceToken, "device_identity"),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    await expect(
      context.tokens.verify(paired.exchange.vaultToken, "vault_authorization"),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(
      (await context.repository.getDevice(paired.exchange.deviceId))?.revokedAt,
    ).toBe(context.clock.now);
  });
});
