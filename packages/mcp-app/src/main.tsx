import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import type { App } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";

import { WorkbenchApp } from "./App.js";
import { McpWorkbenchBridge } from "./bridge/workbench-bridge.js";
import { StatusPanel } from "./components/StatusPanel.js";
import "./styles.css";

function ConnectedWorkbench({ app }: { app: App }) {
  const [bridge] = useState(() => new McpWorkbenchBridge(app));
  return <WorkbenchApp bridge={bridge} />;
}

function HostConnection() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: "obsidian-workbench-app", version: "0.1.0" },
    capabilities: {},
    strict: true,
  });

  if (error) {
    return (
      <main className="connection-stage">
        <StatusPanel
          title="Host connection failed"
          message="The MCP host did not complete the app handshake."
        />
      </main>
    );
  }
  if (!isConnected || app === null) {
    return (
      <main className="connection-stage">
        <StatusPanel
          title="Connecting to host"
          message="Waiting for the MCP App handshake."
        />
      </main>
    );
  }
  return <ConnectedWorkbench app={app} />;
}

const root = document.getElementById("root");
if (root === null) throw new Error("Application root is missing");
createRoot(root).render(
  <StrictMode>
    <HostConnection />
  </StrictMode>,
);
