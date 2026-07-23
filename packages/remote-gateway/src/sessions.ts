import { Buffer } from "node:buffer";

import {
  PermissionScopeSchema,
  GatewayReadySchema,
  ProtocolRequestSchema,
  ProtocolResponseSchema,
  VaultEventSchema,
  type PermissionScope,
  type ProtocolRequest,
  type ProtocolResponse,
  type VaultEvent,
} from "@obsidian-workbench/shared";
import { z } from "zod";

import { GatewayError } from "./errors.js";
import type { GatewayRepository } from "./repository.js";
import type { TokenService } from "./tokens.js";

const HelloSchema = z
  .object({
    type: z.literal("hello"),
    protocolVersion: z.literal(1),
    deviceId: z.string().min(1).max(256),
    vaultId: z.string().min(1).max(256),
    deviceToken: z.string().min(16).max(8192),
    vaultToken: z.string().min(16).max(8192),
    scopes: z.array(PermissionScopeSchema),
  })
  .strict();

const SOCKET_OPEN = 1;

export interface GatewaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(
    event: "message",
    listener: (data: unknown, isBinary: boolean) => void,
  ): this;
  on(event: "close" | "error", listener: () => void): this;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface SessionIdentity {
  deviceId: string;
  userId: string;
  vaultId: string;
  scopes: readonly PermissionScope[];
}

export interface SessionRegistryOptions {
  repository: GatewayRepository;
  tokens: TokenService;
  eventSink?: GatewayEventSink;
  now?: () => number;
  requestTimeoutMs?: number;
  helloTimeoutMs?: number;
  maxMessageBytes?: number;
  maxInflightRequests?: number;
  maxBufferedBytes?: number;
}

interface ConnectionState {
  phase: "hello" | "authenticating" | "authenticated" | "closed";
  helloTimer: ReturnType<typeof setTimeout>;
  authentication?: Promise<void>;
  session?: GatewayOutboundSession;
}

export interface GatewayEventSink {
  publish(identity: SessionIdentity, event: VaultEvent): Promise<void>;
}

interface PendingRequest {
  resolve(response: ProtocolResponse): void;
  reject(error: GatewayError): void;
  timer: ReturnType<typeof setTimeout>;
}

export class GatewayOutboundSession {
  readonly identity: SessionIdentity;
  readonly connectedAt: number;
  readonly #socket: GatewaySocket;
  readonly #requestTimeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #maxInflightRequests: number;
  readonly #maxBufferedBytes: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #completedIds = new Set<string>();
  readonly #completedOrder: string[] = [];
  #closed = false;

  constructor(
    identity: SessionIdentity,
    socket: GatewaySocket,
    connectedAt: number,
    options: {
      requestTimeoutMs: number;
      maxMessageBytes: number;
      maxInflightRequests: number;
      maxBufferedBytes: number;
    },
  ) {
    this.identity = { ...identity, scopes: [...identity.scopes] };
    this.#socket = socket;
    this.connectedAt = connectedAt;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#maxMessageBytes = options.maxMessageBytes;
    this.#maxInflightRequests = options.maxInflightRequests;
    this.#maxBufferedBytes = options.maxBufferedBytes;
  }

  get isOpen(): boolean {
    return !this.#closed && this.#socket.readyState === SOCKET_OPEN;
  }

  async request(value: ProtocolRequest): Promise<ProtocolResponse> {
    const request = ProtocolRequestSchema.parse(value);
    if (!this.isOpen) throw offlineError();
    if (
      this.#pending.size >= this.#maxInflightRequests ||
      this.#socket.bufferedAmount > this.#maxBufferedBytes
    ) {
      throw new GatewayError(
        "CAPACITY_EXCEEDED",
        "The companion connection is busy; the request was not queued.",
        503,
      );
    }
    if (this.#pending.has(request.id) || this.#completedIds.has(request.id)) {
      throw new GatewayError(
        "INVALID_REQUEST",
        "The protocol request ID has already been used.",
        409,
      );
    }
    const serialized = JSON.stringify(request);
    if (Buffer.byteLength(serialized, "utf8") > this.#maxMessageBytes) {
      throw new GatewayError(
        "INVALID_REQUEST",
        "The protocol request exceeds the message size limit.",
        413,
      );
    }

    return await new Promise<ProtocolResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(request.id)) return;
        this.#rememberCompleted(request.id);
        reject(
          new GatewayError(
            "REQUEST_TIMEOUT",
            "The companion did not respond before the request timeout.",
            504,
          ),
        );
      }, this.#requestTimeoutMs);
      this.#pending.set(request.id, { resolve, reject, timer });
      try {
        this.#socket.send(serialized, (error) => {
          if (error === undefined) return;
          const pending = this.#pending.get(request.id);
          if (pending === undefined) return;
          clearTimeout(pending.timer);
          this.#pending.delete(request.id);
          this.#rememberCompleted(request.id);
          pending.reject(offlineError());
        });
      } catch {
        clearTimeout(timer);
        this.#pending.delete(request.id);
        this.#rememberCompleted(request.id);
        reject(offlineError());
      }
    });
  }

  receive(value: unknown): void {
    const parsed = ProtocolResponseSchema.safeParse(value);
    if (!parsed.success) {
      this.close(1008, "Invalid protocol response");
      return;
    }
    const response = parsed.data;
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      this.close(1008, "Unknown or replayed response");
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(response.id);
    this.#rememberCompleted(response.id);
    pending.resolve(response);
  }

  close(code = 1000, reason = "Session closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#socket.close(code, reason);
    } catch {
      this.#socket.terminate();
    }
    this.dispose();
  }

  dispose(): void {
    if (this.#closed && this.#pending.size === 0) return;
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#rememberCompleted(id);
      pending.reject(offlineError());
    }
    this.#pending.clear();
  }

  #rememberCompleted(id: string): void {
    this.#completedIds.add(id);
    this.#completedOrder.push(id);
    if (this.#completedOrder.length > 2_048) {
      const oldest = this.#completedOrder.shift();
      if (oldest !== undefined) this.#completedIds.delete(oldest);
    }
  }
}

export class GatewaySessionRegistry {
  readonly #repository: GatewayRepository;
  readonly #tokens: TokenService;
  readonly #eventSink: GatewayEventSink | undefined;
  readonly #now: () => number;
  readonly #requestTimeoutMs: number;
  readonly #helloTimeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #maxInflightRequests: number;
  readonly #maxBufferedBytes: number;
  readonly #connections = new WeakMap<GatewaySocket, ConnectionState>();
  readonly #sessions = new Map<string, GatewayOutboundSession>();

  constructor(options: SessionRegistryOptions) {
    this.#repository = options.repository;
    this.#tokens = options.tokens;
    this.#eventSink = options.eventSink;
    this.#now = options.now ?? Date.now;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.#helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
    this.#maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
    this.#maxInflightRequests = options.maxInflightRequests ?? 32;
    this.#maxBufferedBytes = options.maxBufferedBytes ?? 2 * 1024 * 1024;
    if (
      this.#requestTimeoutMs <= 0 ||
      this.#helloTimeoutMs <= 0 ||
      this.#maxMessageBytes <= 0 ||
      this.#maxInflightRequests <= 0 ||
      this.#maxBufferedBytes <= 0
    ) {
      throw new TypeError("Session limits must be positive.");
    }
  }

  accept(socket: GatewaySocket): void {
    if (this.#connections.has(socket)) {
      socket.close(1008, "Connection already registered");
      return;
    }
    const state: ConnectionState = {
      phase: "hello",
      helloTimer: setTimeout(() => {
        socket.close(1008, "Authentication timeout");
      }, this.#helloTimeoutMs),
    };
    this.#connections.set(socket, state);
    socket.on("message", (data, isBinary) => {
      void this.#receive(socket, data, isBinary);
    });
    socket.on("close", () => this.#cleanup(socket));
    socket.on("error", () => this.#cleanup(socket));
  }

  get(deviceId: string, vaultId: string): GatewayOutboundSession | undefined {
    const session = this.#sessions.get(sessionKey(deviceId, vaultId));
    if (session !== undefined && !session.isOpen) {
      this.#sessions.delete(sessionKey(deviceId, vaultId));
      session.dispose();
      return undefined;
    }
    return session;
  }

  revokeDevice(deviceId: string): void {
    for (const [key, session] of this.#sessions) {
      if (session.identity.deviceId === deviceId) {
        this.#sessions.delete(key);
        session.close(4003, "Device revoked");
      }
    }
  }

  get onlineCount(): number {
    return this.#sessions.size;
  }

  async #receive(
    socket: GatewaySocket,
    data: unknown,
    isBinary: boolean,
  ): Promise<void> {
    const state = this.#connections.get(socket);
    if (state === undefined || state.phase === "closed") return;
    const bytes = messageBuffer(data);
    if (
      isBinary ||
      bytes === undefined ||
      bytes.length > this.#maxMessageBytes
    ) {
      socket.close(1009, "Invalid message");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      socket.close(1007, "Invalid JSON");
      return;
    }

    if (state.phase === "hello") {
      state.phase = "authenticating";
      const authentication = this.#authenticate(socket, state, value);
      state.authentication = authentication;
      await authentication;
      delete state.authentication;
      return;
    }
    if (state.phase === "authenticating") {
      await state.authentication;
    }
    if (state.phase !== "authenticated" || state.session === undefined) {
      return;
    }
    const event = VaultEventSchema.safeParse(value);
    if (event.success) {
      if (event.data.vaultId !== state.session.identity.vaultId) {
        socket.close(1008, "Invalid vault event");
        return;
      }
      try {
        await this.#eventSink?.publish(state.session.identity, event.data);
      } catch {
        socket.close(1011, "Event delivery failed");
      }
      return;
    }
    state.session.receive(value);
  }

  async #authenticate(
    socket: GatewaySocket,
    state: ConnectionState,
    value: unknown,
  ): Promise<void> {
    const hello = HelloSchema.safeParse(value);
    if (
      !hello.success ||
      new Set(hello.data.scopes).size !== hello.data.scopes.length
    ) {
      socket.close(1008, "Authentication failed");
      return;
    }
    try {
      const [deviceClaims, vaultClaims] = await Promise.all([
        this.#tokens.verify(hello.data.deviceToken, "device_identity"),
        this.#tokens.verify(hello.data.vaultToken, "vault_authorization"),
      ]);
      const [account, device, authorization] = await Promise.all([
        this.#repository.getAccount(deviceClaims.user),
        this.#repository.getDevice(hello.data.deviceId),
        this.#repository.getVaultAuthorization(
          hello.data.deviceId,
          hello.data.vaultId,
        ),
      ]);
      if (
        state.phase !== "authenticating" ||
        socket.readyState !== SOCKET_OPEN ||
        account === undefined ||
        account.disabledAt !== undefined ||
        device === undefined ||
        device.revokedAt !== undefined ||
        device.id !== deviceClaims.id ||
        device.userId !== deviceClaims.user ||
        deviceClaims.scopes.length !== 0 ||
        authorization === undefined ||
        authorization.revokedAt !== undefined ||
        authorization.userId !== deviceClaims.user ||
        authorization.userId !== vaultClaims.user ||
        authorization.vaultId !== vaultClaims.vault ||
        vaultClaims.id !== deviceClaims.id ||
        vaultClaims.user !== deviceClaims.user ||
        hello.data.deviceId !== deviceClaims.id ||
        hello.data.vaultId !== vaultClaims.vault ||
        !sameScopes(hello.data.scopes, vaultClaims.scopes) ||
        !sameScopes(authorization.scopes, vaultClaims.scopes)
      ) {
        socket.close(1008, "Authentication failed");
        return;
      }
      const identity: SessionIdentity = {
        deviceId: deviceClaims.id,
        userId: deviceClaims.user,
        vaultId: vaultClaims.vault,
        scopes: [...vaultClaims.scopes],
      };
      const session = new GatewayOutboundSession(
        identity,
        socket,
        this.#now(),
        {
          requestTimeoutMs: this.#requestTimeoutMs,
          maxMessageBytes: this.#maxMessageBytes,
          maxInflightRequests: this.#maxInflightRequests,
          maxBufferedBytes: this.#maxBufferedBytes,
        },
      );
      const key = sessionKey(identity.deviceId, identity.vaultId);
      const previous = this.#sessions.get(key);
      this.#sessions.set(key, session);
      state.session = session;
      state.phase = "authenticated";
      clearTimeout(state.helloTimer);
      socket.send(
        JSON.stringify(
          GatewayReadySchema.parse({
            type: "ready",
            protocolVersion: 1,
            deviceId: identity.deviceId,
            vaultId: identity.vaultId,
          }),
        ),
      );
      previous?.close(4001, "Connection replaced");
    } catch {
      socket.close(1008, "Authentication failed");
    }
  }

  #cleanup(socket: GatewaySocket): void {
    const state = this.#connections.get(socket);
    if (state === undefined || state.phase === "closed") return;
    state.phase = "closed";
    clearTimeout(state.helloTimer);
    const session = state.session;
    if (session !== undefined) {
      const key = sessionKey(
        session.identity.deviceId,
        session.identity.vaultId,
      );
      if (this.#sessions.get(key) === session) this.#sessions.delete(key);
      session.dispose();
    }
    this.#connections.delete(socket);
  }
}

function sessionKey(deviceId: string, vaultId: string): string {
  return `${deviceId}\0${vaultId}`;
}

function messageBuffer(data: unknown): Buffer | undefined {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
    return Buffer.concat(data);
  }
  return undefined;
}

function sameScopes(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length && left.every((scope) => right.includes(scope))
  );
}

function offlineError(): GatewayError {
  return new GatewayError(
    "VAULT_OFFLINE",
    "The vault companion is offline; the request was not queued.",
    503,
  );
}
