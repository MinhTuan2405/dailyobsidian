import { randomBytes } from "node:crypto";

import type { PermissionScope } from "@obsidian-workbench/shared";

import { InMemoryAuthProvider } from "../src/auth.js";
import { InMemoryGatewayRepository } from "../src/memory.js";
import { PairingService } from "../src/pairing.js";
import { GatewaySessionRegistry, type GatewaySocket } from "../src/sessions.js";
import { TokenService } from "../src/tokens.js";

type MessageListener = (data: unknown, isBinary: boolean) => void;
type EventListener = () => void;

export class FakeSocket implements GatewaySocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  readonly #messages: MessageListener[] = [];
  readonly #closes: EventListener[] = [];
  readonly #errors: EventListener[] = [];

  on(event: "message", listener: MessageListener): this;
  on(event: "close" | "error", listener: EventListener): this;
  on(
    event: "message" | "close" | "error",
    listener: MessageListener | EventListener,
  ): this {
    if (event === "message") this.#messages.push(listener as MessageListener);
    if (event === "close") this.#closes.push(listener as EventListener);
    if (event === "error") this.#errors.push(listener as EventListener);
    return this;
  }

  send(data: string, callback?: (error?: Error) => void): void {
    if (this.readyState !== 1) {
      callback?.(new Error("closed"));
      return;
    }
    this.sent.push(data);
    callback?.();
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.closes.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
    this.readyState = 3;
    for (const listener of this.#closes) listener();
  }

  terminate(): void {
    this.close();
  }

  receive(value: unknown): void {
    const data = typeof value === "string" ? value : JSON.stringify(value);
    for (const listener of this.#messages) listener(data, false);
  }
}

export interface TestContext {
  clock: { now: number };
  repository: InMemoryGatewayRepository;
  auth: InMemoryAuthProvider;
  tokens: TokenService;
  pairing: PairingService;
}

export function createTestContext(initialNow = 1_000_000): TestContext {
  const clock = { now: initialNow };
  const repository = new InMemoryGatewayRepository();
  const auth = new InMemoryAuthProvider();
  const tokens = new TokenService({
    repository,
    signingKey: randomBytes(32),
    issuer: "test-gateway",
    audience: "test-companion",
    now: () => clock.now,
  });
  const pairing = new PairingService({
    repository,
    tokens,
    codeHmacKey: randomBytes(32),
    now: () => clock.now,
  });
  return { clock, repository, auth, tokens, pairing };
}

export async function pairDevice(
  context: TestContext,
  input: {
    userId: string;
    vaultId: string;
    scopes: PermissionScope[];
    vaultName?: string;
  },
) {
  await context.repository.saveAccount({
    id: input.userId,
    createdAt: context.clock.now,
  });
  const { session } = context.auth.createSession(
    input.userId,
    context.clock.now,
  );
  const created = await context.pairing.createCode(session, {
    vaultId: input.vaultId,
    scopes: input.scopes,
  });
  const exchange = await context.pairing.exchangeCode({
    code: created.code,
    vaultId: input.vaultId,
    vaultName: input.vaultName ?? "Test Vault",
    scopes: input.scopes,
  });
  return { session, created, exchange };
}

export async function connectDevice(
  context: TestContext,
  exchange: Awaited<ReturnType<typeof pairDevice>>["exchange"],
  options: { requestTimeoutMs?: number } = {},
) {
  const registry = new GatewaySessionRegistry({
    repository: context.repository,
    tokens: context.tokens,
    now: () => context.clock.now,
    requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
  });
  const socket = new FakeSocket();
  registry.accept(socket);
  socket.receive({
    type: "hello",
    protocolVersion: 1,
    deviceId: exchange.deviceId,
    vaultId: exchange.vaultId,
    deviceToken: exchange.deviceToken,
    vaultToken: exchange.vaultToken,
    scopes: exchange.scopes,
  });
  await waitFor(() => registry.onlineCount === 1);
  socket.sent.length = 0;
  return { registry, socket };
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached.");
}
