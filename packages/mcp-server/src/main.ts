import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadVaultRegistryFromEnvironment } from "./adapters/vault-registry.js";
import { createMcpServer } from "./server.js";
import { serveHttp } from "./transports/http.js";

async function main(): Promise<void> {
  const registry = loadVaultRegistryFromEnvironment();
  await registry.initialize();
  if ((process.env.MCP_TRANSPORT ?? "stdio") === "http") {
    serveHttp(registry, {
      host: process.env.MCP_HOST ?? "127.0.0.1",
      port: Number.parseInt(process.env.PORT ?? "8000", 10),
      ...(process.env.MCP_ALLOWED_HOSTS !== undefined
        ? {
            allowedHosts: process.env.MCP_ALLOWED_HOSTS.split(",")
              .map((host) => host.trim())
              .filter(Boolean),
          }
        : {}),
    });
    return;
  }
  await createMcpServer(registry).connect(new StdioServerTransport());
}

main().catch(() => {
  console.error("Obsidian Workbench MCP failed to start.");
  process.exitCode = 1;
});
