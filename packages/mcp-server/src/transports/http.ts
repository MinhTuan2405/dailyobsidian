import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Express } from "express";

import type { VaultRegistry } from "../adapters/vault-registry.js";
import { createMcpServer } from "../server.js";

export interface HttpServerOptions {
  host?: string;
  port?: number;
  allowedHosts?: string[];
}

export function createHttpApp(
  registry: VaultRegistry,
  options: HttpServerOptions = {},
): Express {
  const host = options.host ?? "127.0.0.1";
  const app = createMcpExpressApp({
    host,
    ...(options.allowedHosts !== undefined
      ? { allowedHosts: options.allowedHosts }
      : {}),
  });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });
  app.all("/mcp", async (request, response) => {
    const server = createMcpServer(registry);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });
  return app;
}

export function serveHttp(
  registry: VaultRegistry,
  options: HttpServerOptions = {},
): void {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8000;
  createHttpApp(registry, options).listen(port, host, () => {
    console.error(
      `Obsidian Workbench MCP listening on http://${host}:${port}/mcp`,
    );
  });
}
