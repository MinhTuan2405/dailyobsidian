import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { VaultRegistry } from "./adapters/vault-registry.js";
import { registerWorkbenchApp } from "./app/workbench-app.js";
import { registerReadTools } from "./tools/register-read-tools.js";
import { registerWriteTools } from "./tools/register-write-tools.js";

export function createMcpServer(registry: VaultRegistry): McpServer {
  const server = new McpServer({
    name: "obsidian-workbench",
    version: "0.1.0",
  });
  registerReadTools(server, registry);
  registerWriteTools(server, registry);
  registerWorkbenchApp(server, registry);
  return server;
}
