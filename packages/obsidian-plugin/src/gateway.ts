import {
  ProtocolRequestSchema,
  ProtocolResponseSchema,
  GatewayReadySchema,
  VaultEventSchema,
  WorkbenchError,
  type PermissionScope,
  type ProtocolRequest,
  type ProtocolResponse,
  type VaultEvent,
} from "@obsidian-workbench/shared";
import { z } from "zod";

import { validationError, workbenchError } from "./errors.js";

const AuthenticatedHelloSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.literal(1),
  deviceId: z.string().min(1).max(256),
  vaultId: z.string().min(1).max(256),
  deviceToken: z.string().min(16).max(8192),
  vaultToken: z.string().min(16).max(8192),
  scopes: z.array(z.string().min(1).max(128)),
});

export type GatewayState = "offline" | "connecting" | "online" | "error";

export interface GatewayStatus {
  state: GatewayState;
  message?: string;
}

export interface GatewayCredentials {
  gatewayUrl: string;
  deviceId: string;
  vaultId: string;
  deviceToken: string;
  vaultToken: string;
  scopes: PermissionScope[];
}

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface GatewayClientOptions {
  onRequest(
    request: ProtocolRequest,
    signal: AbortSignal,
  ): Promise<ProtocolResponse>;
  onStatus(status: GatewayStatus): void;
  createSocket?: (url: string) => WebSocketLike;
  requestTimeoutMs?: number;
  random?: () => number;
  setTimer?: typeof globalThis.setTimeout;
  clearTimer?: typeof globalThis.clearTimeout;
}

const SOCKET_OPEN = 1;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_INFLIGHT_REQUESTS = 32;

function validateGatewayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw validationError("The gateway URL is invalid.");
  }
  if (url.protocol !== "wss:") {
    throw validationError(
      "The gateway URL must use secure WebSocket transport (wss).",
    );
  }
  url.username = "";
  url.password = "";
  return url.toString();
}

function timeoutResponse(id: string): ProtocolResponse {
  return ProtocolResponseSchema.parse({
    jsonrpc: "2.0",
    id,
    error: {
      code: "INTERNAL_ERROR",
      message: "The companion request timed out.",
    },
  });
}

export class GatewayClient {
  readonly #onRequest: GatewayClientOptions["onRequest"];
  readonly #onStatus: GatewayClientOptions["onStatus"];
  readonly #createSocket: (url: string) => WebSocketLike;
  readonly #requestTimeoutMs: number;
  readonly #random: () => number;
  readonly #setTimer: typeof globalThis.setTimeout;
  readonly #clearTimer: typeof globalThis.clearTimeout;
  readonly #inflightIds = new Set<string>();
  #credentials: GatewayCredentials | undefined;
  #socket: WebSocketLike | undefined;
  #reconnectTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #attempt = 0;
  #generation = 0;
  #desired = false;
  #emergency = false;
  #state: GatewayState = "offline";

  constructor(options: GatewayClientOptions) {
    this.#onRequest = options.onRequest;
    this.#onStatus = options.onStatus;
    this.#createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as WebSocketLike);
    this.#requestTimeoutMs = Math.max(
      1_000,
      options.requestTimeoutMs ?? 20_000,
    );
    this.#random = options.random ?? Math.random;
    this.#setTimer = options.setTimer ?? globalThis.setTimeout.bind(globalThis);
    this.#clearTimer =
      options.clearTimer ?? globalThis.clearTimeout.bind(globalThis);
  }

  get state(): GatewayState {
    return this.#state;
  }

  connect(credentials: GatewayCredentials): void {
    this.#credentials = {
      ...credentials,
      gatewayUrl: validateGatewayUrl(credentials.gatewayUrl),
      scopes: [...credentials.scopes],
    };
    this.#emergency = false;
    this.#desired = true;
    this.#attempt = 0;
    this.#replaceSocket();
  }

  disconnect(): void {
    this.#desired = false;
    this.#generation += 1;
    this.#cancelReconnect();
    this.#closeSocket(1000, "User disconnected");
    this.#setStatus({ state: "offline" });
  }

  emergencyDisconnect(): void {
    this.#emergency = true;
    this.#desired = false;
    this.#credentials = undefined;
    this.#generation += 1;
    this.#cancelReconnect();
    this.#closeSocket(4000, "Emergency disconnect");
    this.#setStatus({
      state: "offline",
      message: "Emergency disconnect active.",
    });
  }

  sendEvent(event: VaultEvent): boolean {
    const parsed = VaultEventSchema.parse(event);
    if (!this.#isOpen()) return false;
    this.#socket?.send(JSON.stringify(parsed));
    return true;
  }

  send(message: ProtocolResponse): void {
    if (!this.#isOpen()) {
      throw workbenchError(
        "VAULT_OFFLINE",
        "The gateway is offline; the message was not queued.",
      );
    }
    this.#socket?.send(JSON.stringify(ProtocolResponseSchema.parse(message)));
  }

  #replaceSocket(): void {
    if (!this.#desired || this.#emergency || this.#credentials === undefined)
      return;
    this.#generation += 1;
    const generation = this.#generation;
    this.#cancelReconnect();
    this.#closeSocket(1000, "Connection replaced");
    this.#setStatus({ state: "connecting" });
    let socket: WebSocketLike;
    try {
      socket = this.#createSocket(this.#credentials.gatewayUrl);
    } catch {
      this.#setStatus({
        state: "error",
        message: "The gateway connection failed.",
      });
      this.#scheduleReconnect(generation);
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      if (generation !== this.#generation || this.#credentials === undefined)
        return;
      const hello = AuthenticatedHelloSchema.parse({
        type: "hello",
        protocolVersion: 1,
        deviceId: this.#credentials.deviceId,
        vaultId: this.#credentials.vaultId,
        deviceToken: this.#credentials.deviceToken,
        vaultToken: this.#credentials.vaultToken,
        scopes: this.#credentials.scopes,
      });
      socket.send(JSON.stringify(hello));
    };
    socket.onmessage = (event) => {
      if (generation === this.#generation)
        void this.#handleMessage(event.data, socket);
    };
    socket.onerror = () => {
      if (generation === this.#generation) {
        this.#setStatus({
          state: "error",
          message: "The gateway connection failed.",
        });
      }
    };
    socket.onclose = () => {
      if (generation !== this.#generation) return;
      if (this.#socket === socket) this.#socket = undefined;
      if (this.#desired && !this.#emergency) {
        this.#setStatus({
          state: "offline",
          message: "Reconnecting to the gateway.",
        });
        this.#scheduleReconnect(generation);
      } else {
        this.#setStatus({ state: "offline" });
      }
    };
  }

  async #handleMessage(data: unknown, socket: WebSocketLike): Promise<void> {
    if (
      typeof data !== "string" ||
      new TextEncoder().encode(data).length > MAX_MESSAGE_BYTES
    ) {
      socket.close(1009, "Invalid message");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(data) as unknown;
    } catch {
      socket.close(1007, "Invalid JSON");
      return;
    }
    const parsed = ProtocolRequestSchema.safeParse(value);
    const ready = GatewayReadySchema.safeParse(value);
    if (ready.success) {
      if (
        this.#state !== "connecting" ||
        this.#credentials === undefined ||
        ready.data.deviceId !== this.#credentials.deviceId ||
        ready.data.vaultId !== this.#credentials.vaultId
      ) {
        socket.close(1008, "Invalid gateway acknowledgement");
        return;
      }
      this.#attempt = 0;
      this.#setStatus({ state: "online" });
      return;
    }
    if (this.#state !== "online") {
      socket.close(1008, "Gateway authentication is incomplete");
      return;
    }
    if (!parsed.success) {
      socket.close(1008, "Invalid protocol request");
      return;
    }
    const request = parsed.data;
    if (
      this.#inflightIds.has(request.id) ||
      this.#inflightIds.size >= MAX_INFLIGHT_REQUESTS
    ) {
      this.#sendIfCurrent(socket, {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: "VALIDATION_ERROR",
          message: "The request is duplicate or the companion is busy.",
        },
      });
      return;
    }
    this.#inflightIds.add(request.id);
    const controller = new AbortController();
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    try {
      const timeout = new Promise<ProtocolResponse>((resolve) => {
        timer = this.#setTimer(() => {
          controller.abort();
          resolve(timeoutResponse(request.id));
        }, this.#requestTimeoutMs);
      });
      let response: ProtocolResponse;
      try {
        response = await Promise.race([
          this.#onRequest(request, controller.signal),
          timeout,
        ]);
      } catch (error) {
        const toolError =
          error instanceof WorkbenchError
            ? error.toolError
            : {
                code: "INTERNAL_ERROR",
                message: "The companion request failed.",
              };
        response = {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: toolError.code, message: toolError.message },
        };
      }
      this.#sendIfCurrent(socket, response);
    } finally {
      if (timer !== undefined) this.#clearTimer(timer);
      this.#inflightIds.delete(request.id);
    }
  }

  #sendIfCurrent(socket: WebSocketLike, response: ProtocolResponse): void {
    if (this.#socket !== socket || socket.readyState !== SOCKET_OPEN) return;
    socket.send(JSON.stringify(ProtocolResponseSchema.parse(response)));
  }

  #scheduleReconnect(generation: number): void {
    if (!this.#desired || this.#emergency || generation !== this.#generation)
      return;
    const base = Math.min(30_000, 500 * 2 ** Math.min(this.#attempt, 6));
    const delay = Math.round(base * (0.75 + this.#random() * 0.5));
    this.#attempt += 1;
    this.#reconnectTimer = this.#setTimer(() => this.#replaceSocket(), delay);
  }

  #cancelReconnect(): void {
    if (this.#reconnectTimer !== undefined) {
      this.#clearTimer(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
  }

  #closeSocket(code: number, reason: string): void {
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket !== undefined) {
      socket.onclose = null;
      socket.close(code, reason);
    }
  }

  #isOpen(): boolean {
    return this.#socket?.readyState === SOCKET_OPEN && this.#state === "online";
  }

  #setStatus(status: GatewayStatus): void {
    this.#state = status.state;
    this.#onStatus(status);
  }
}
