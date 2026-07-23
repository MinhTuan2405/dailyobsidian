import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer } from "ws";
import { ZodError } from "zod";

import type { AuthProvider } from "./auth.js";
import { GatewayError, safeGatewayError } from "./errors.js";
import type { PairingService } from "./pairing.js";
import type { GatewaySessionRegistry, GatewaySocket } from "./sessions.js";

export interface GatewayServerOptions {
  auth: AuthProvider;
  pairing: PairingService;
  sessions: GatewaySessionRegistry;
  now?: () => number;
  webSocketPath?: string;
  maxJsonBytes?: number;
  maxWebSocketBytes?: number;
  corsAllowedOrigins?: readonly string[];
  trustProxyTlsHeader?: boolean;
  allowInsecureHttpForDevelopment?: boolean;
}

export interface GatewayServer {
  httpServer: ReturnType<typeof createServer>;
  webSocketServer: WebSocketServer;
}

export function createGatewayServer(
  options: GatewayServerOptions,
): GatewayServer {
  const now = options.now ?? Date.now;
  const webSocketPath = options.webSocketPath ?? "/v1/gateway";
  const maxJsonBytes = options.maxJsonBytes ?? 64 * 1024;
  const maxWebSocketBytes = options.maxWebSocketBytes ?? 1024 * 1024;
  const allowedOrigins = new Set(options.corsAllowedOrigins ?? []);
  if (allowedOrigins.has("*")) {
    throw new TypeError("Wildcard CORS origins are not supported.");
  }
  if (maxJsonBytes <= 0 || maxWebSocketBytes <= 0) {
    throw new TypeError("Server size limits must be positive.");
  }

  const httpServer = createServer((request, response) => {
    void handleHttpRequest(request, response, {
      ...options,
      now,
      maxJsonBytes,
      allowedOrigins,
    });
  });
  const webSocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: maxWebSocketBytes,
    perMessageDeflate: false,
  });

  webSocketServer.on("connection", (socket) => {
    options.sessions.accept(socket as unknown as GatewaySocket);
  });
  httpServer.on("upgrade", (request, socket, head) => {
    if (
      !isSecureRequest(request, options) ||
      request.url === undefined ||
      safePathname(request.url) !== webSocketPath ||
      !originAllowed(request.headers.origin, allowedOrigins)
    ) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });

  return { httpServer, webSocketServer };
}

interface HttpContext extends GatewayServerOptions {
  now: () => number;
  maxJsonBytes: number;
  allowedOrigins: ReadonlySet<string>;
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: HttpContext,
): Promise<void> {
  setSecurityHeaders(response);
  try {
    if (!isSecureRequest(request, context)) {
      throw new GatewayError(
        "INVALID_REQUEST",
        "TLS is required for gateway requests.",
        426,
      );
    }
    const origin = request.headers.origin;
    if (!originAllowed(origin, context.allowedOrigins)) {
      throw new GatewayError(
        "PERMISSION_DENIED",
        "The request origin is not allowed.",
        403,
      );
    }
    applyCors(origin, response, context.allowedOrigins);
    const pathname = safePathname(request.url ?? "");
    if (request.method === "OPTIONS") {
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader(
        "access-control-allow-headers",
        "authorization, content-type",
      );
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === "GET" && pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "POST" && pathname === "/v1/pairing/create") {
      const sessionToken = bearerToken(request);
      const session = await context.auth.authenticate({
        sessionToken,
        now: context.now(),
      });
      if (session === undefined) throw authenticationError();
      const body = await readJson(request, context.maxJsonBytes);
      const result = await context.pairing.createCode(session, body);
      sendJson(response, 201, result);
      return;
    }
    if (request.method === "POST" && pathname === "/v1/pairing/exchange") {
      const body = await readJson(request, context.maxJsonBytes);
      const result = await context.pairing.exchangeCode(body);
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "POST" && pathname === "/v1/devices/revoke") {
      const deviceToken = bearerToken(request);
      const body = await readJson(request, context.maxJsonBytes);
      const deviceId = objectString(body, "deviceId");
      await context.pairing.revokeDevice(deviceToken, deviceId);
      context.sessions.revokeDevice(deviceId);
      sendJson(response, 200, { revoked: true });
      return;
    }
    sendJson(response, 404, {
      error: { code: "NOT_FOUND", message: "The endpoint was not found." },
    });
  } catch (error) {
    const safe = httpError(error);
    if (!response.headersSent) {
      sendJson(response, safe.status, {
        error: { code: safe.code, message: safe.message },
      });
    } else {
      response.end();
    }
  }
}

async function readJson(
  request: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new GatewayError(
      "INVALID_REQUEST",
      "A JSON request body is required.",
      415,
    );
  }
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (
    !Number.isFinite(declaredLength) ||
    declaredLength < 0 ||
    declaredLength > limit
  ) {
    request.resume();
    throw new GatewayError(
      "INVALID_REQUEST",
      "The JSON request body is too large.",
      413,
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value as Uint8Array);
    total += chunk.length;
    if (total > limit) {
      request.resume();
      throw new GatewayError(
        "INVALID_REQUEST",
        "The JSON request body is too large.",
        413,
      );
    }
    chunks.push(chunk);
  }
  if (total === 0) {
    throw new GatewayError(
      "INVALID_REQUEST",
      "A JSON request body is required.",
      400,
    );
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new GatewayError(
      "INVALID_REQUEST",
      "The JSON request body is invalid.",
      400,
    );
  }
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  const match =
    typeof authorization === "string"
      ? /^Bearer ([^\s]{16,8192})$/.exec(authorization)
      : null;
  if (match?.[1] === undefined) throw authenticationError();
  return match[1];
}

function objectString(value: unknown, key: string): string {
  if (value === null || typeof value !== "object") {
    throw invalidRequest();
  }
  const field = (value as Record<string, unknown>)[key];
  if (typeof field !== "string" || field.length < 1 || field.length > 256) {
    throw invalidRequest();
  }
  return field;
}

function safePathname(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl, "http://gateway.invalid").pathname;
  } catch {
    return undefined;
  }
}

function isSecureRequest(
  request: IncomingMessage,
  options: Pick<
    GatewayServerOptions,
    "allowInsecureHttpForDevelopment" | "trustProxyTlsHeader"
  >,
): boolean {
  if (options.allowInsecureHttpForDevelopment === true) return true;
  if ((request.socket as { encrypted?: boolean }).encrypted === true)
    return true;
  if (options.trustProxyTlsHeader !== true) return false;
  const forwarded = request.headers["x-forwarded-proto"];
  return (
    typeof forwarded === "string" &&
    forwarded.split(",", 1)[0]?.trim() === "https"
  );
}

function originAllowed(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  return origin === undefined || allowedOrigins.has(origin);
}

function applyCors(
  origin: string | undefined,
  response: ServerResponse,
  allowedOrigins: ReadonlySet<string>,
): void {
  if (origin !== undefined && allowedOrigins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'");
  response.setHeader("x-content-type-options", "nosniff");
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body, "utf8"));
  response.end(body);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function httpError(error: unknown): GatewayError {
  if (error instanceof ZodError) return invalidRequest();
  return safeGatewayError(error);
}

function invalidRequest(): GatewayError {
  return new GatewayError("INVALID_REQUEST", "The request is invalid.", 400);
}

function authenticationError(): GatewayError {
  return new GatewayError(
    "AUTHENTICATION_REQUIRED",
    "A valid credential is required.",
    401,
  );
}
