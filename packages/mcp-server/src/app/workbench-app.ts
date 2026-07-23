import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { MutationPlanSchema } from "@obsidian-workbench/shared";
import { z } from "zod";

import type { VaultRegistry } from "../adapters/vault-registry.js";
import { toolFailure, toolSuccess } from "../tools/result.js";

export const WORKBENCH_APP_URI = "ui://obsidian-workbench/index.html";

const ConfirmationInputSchema = z.object({ plan: MutationPlanSchema });
const ConfirmationOutputSchema = z.object({ confirmationToken: z.string() });

function defaultHtmlPath(): string {
  return fileURLToPath(
    new URL("../../../mcp-app/dist/index.html", import.meta.url),
  );
}

export function registerWorkbenchApp(
  server: McpServer,
  registry: VaultRegistry,
  htmlPath = process.env.MCP_APP_HTML_PATH ?? defaultHtmlPath(),
): void {
  registerAppResource(
    server,
    "Obsidian Workbench",
    WORKBENCH_APP_URI,
    {
      description: "Interactive vault browser and guarded mutation review.",
      _meta: {
        ui: {
          prefersBorder: false,
          csp: { connectDomains: [], resourceDomains: [] },
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: WORKBENCH_APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readFile(htmlPath, "utf8"),
          _meta: {
            ui: {
              prefersBorder: false,
              csp: { connectDomains: [], resourceDomains: [] },
            },
          },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "obsidian.ui.confirm_mutation",
    {
      title: "Confirm reviewed Obsidian mutation",
      description:
        "Use this tool only from the app after the user selects Apply on an exact mutation diff.",
      inputSchema: ConfirmationInputSchema,
      outputSchema: ConfirmationOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: WORKBENCH_APP_URI, visibility: ["app"] },
      },
    },
    async ({ plan }) => {
      try {
        return toolSuccess(ConfirmationOutputSchema, {
          confirmationToken: await registry.issueConfirmation(plan),
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
