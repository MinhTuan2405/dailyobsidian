import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MutationResultSchema,
  NoteSummarySchema,
  paginatedSchema,
  type PermissionScope,
} from "@obsidian-workbench/shared";
import { FilesystemVaultAdapter } from "@obsidian-workbench/vault-core";

import { createVaultRegistry } from "../src/adapters/vault-registry.js";
import { createMcpServer } from "../src/server.js";

let root: string;
let client: Client;
let server: ReturnType<typeof createMcpServer>;
let adapter: FilesystemVaultAdapter;

const SCOPES: PermissionScope[] = [
  "vault.metadata.read",
  "notes.read",
  "notes.create",
  "notes.update",
  "notes.move",
  "notes.trash",
  "tasks.read",
  "tasks.create",
  "tasks.update",
];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "workbench-mcp-"));
  await mkdir(path.join(root, "Notes"), { recursive: true });
  await writeFile(
    path.join(root, "Notes", "Alpha.md"),
    "# Alpha\nA bounded searchable needle. [[Beta]]\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "Notes", "Beta.md"),
    "# Beta\nBack to [[Alpha]].\n",
    "utf8",
  );
  adapter = new FilesystemVaultAdapter({
    vaultId: "fixture-vault",
    rootPath: root,
    allowedRoots: ["Notes"],
    paginationSecret: "mcp-test-secret",
    scopes: SCOPES,
    confirmation: { secret: "mcp-confirmation-secret" },
  });
  const registry = createVaultRegistry([adapter]);
  server = createMcpServer(registry);
  client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
});

afterEach(async () => {
  await Promise.allSettled([client.close(), server.close()]);
  await rm(root, { recursive: true, force: true });
});

describe("MCP tools", () => {
  it("registers the explicit catalog with accurate annotations", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "obsidian.append_to_note",
      "obsidian.create_note",
      "obsidian.create_task",
      "obsidian.find_hub_notes",
      "obsidian.find_orphan_notes",
      "obsidian.get_backlinks",
      "obsidian.get_connection_status",
      "obsidian.get_daily_note",
      "obsidian.get_graph_neighborhood",
      "obsidian.get_note",
      "obsidian.get_note_context",
      "obsidian.get_outlinks",
      "obsidian.get_unresolved_links",
      "obsidian.get_vault_conventions",
      "obsidian.get_vault_info",
      "obsidian.list_notes",
      "obsidian.list_recent_notes",
      "obsidian.list_tasks",
      "obsidian.list_vaults",
      "obsidian.move_note",
      "obsidian.search_notes",
      "obsidian.set_frontmatter",
      "obsidian.trash_note",
      "obsidian.ui.confirm_mutation",
      "obsidian.update_note",
      "obsidian.update_task",
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.openWorldHint).toBe(false);
      if (tool.name === "obsidian.trash_note") {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
        });
      } else if (
        [
          "obsidian.append_to_note",
          "obsidian.create_note",
          "obsidian.create_task",
          "obsidian.move_note",
          "obsidian.set_frontmatter",
          "obsidian.ui.confirm_mutation",
          "obsidian.update_note",
          "obsidian.update_task",
        ].includes(tool.name)
      ) {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: false,
        });
      } else {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
        });
      }
      expect(tool.description).toMatch(/^Use this tool/);
    }
    const appOnly = tools.find(
      (tool) => tool.name === "obsidian.ui.confirm_mutation",
    );
    expect(appOnly?._meta).toMatchObject({
      ui: { visibility: ["app"] },
    });
  });

  it("serves a self-contained MCP App resource", async () => {
    const resources = await client.listResources();
    expect(resources.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: "ui://obsidian-workbench/index.html" }),
      ]),
    );
    const resource = await client.readResource({
      uri: "ui://obsidian-workbench/index.html",
    });
    expect(resource.contents[0]).toMatchObject({
      mimeType: "text/html;profile=mcp-app",
    });
    expect(resource.contents[0]).toHaveProperty("text");
    expect((resource.contents[0] as { text: string }).text).toContain(
      "obsidian-workbench-app",
    );
  });

  it("lists vaults and returns schema-validated search snippets", async () => {
    await client.listTools();
    const vaults = await client.callTool({
      name: "obsidian.list_vaults",
      arguments: {},
    });
    const search = await client.callTool({
      name: "obsidian.search_notes",
      arguments: {
        vaultId: "fixture-vault",
        search: { query: "needle" },
      },
    });

    expect(vaults.isError).not.toBe(true);
    expect(vaults.structuredContent).toMatchObject({
      vaults: [{ vaultId: "fixture-vault" }],
    });
    expect(search.structuredContent).toMatchObject({
      total: 1,
      untrustedContent: true,
      hits: [{ note: { path: "Notes/Alpha.md" } }],
    });
    expect(JSON.stringify(search.structuredContent)).not.toContain(
      "Back to [[Alpha]]",
    );
  });

  it("returns sanitized errors for unknown vaults", async () => {
    await client.listTools();
    const result = await client.callTool({
      name: "obsidian.get_vault_info",
      arguments: { vaultId: "missing" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code: "VAULT_NOT_FOUND",
            message: "The requested vault could not be found.",
            recoverable: true,
          },
        }),
      },
    ]);
  });

  it("previews and applies idempotent writes through the adapter boundary", async () => {
    await client.listTools();
    const listedResult = await client.callTool({
      name: "obsidian.list_notes",
      arguments: { vaultId: "fixture-vault" },
    });
    const listed = paginatedSchema(NoteSummarySchema).parse(
      listedResult.structuredContent,
    );
    const alpha = listed.items.find((note) => note.path === "Notes/Alpha.md");
    expect(alpha).toBeDefined();
    if (alpha === undefined) throw new Error("Alpha was not listed");

    const request = {
      vaultId: "fixture-vault",
      noteId: alpha.noteId,
      expectedRevision: alpha.revision,
      content: "Appended by MCP",
      idempotencyKey: "mcp-append-0001",
    };
    const previewResult = await client.callTool({
      name: "obsidian.append_to_note",
      arguments: { ...request, dryRun: true },
    });
    const preview = MutationResultSchema.parse(previewResult.structuredContent);
    expect(preview.status).toBe("preview");
    expect(
      await readFile(path.join(root, "Notes", "Alpha.md"), "utf8"),
    ).not.toContain("Appended by MCP");

    const appliedResult = await client.callTool({
      name: "obsidian.append_to_note",
      arguments: { ...request, dryRun: false },
    });
    expect(
      MutationResultSchema.parse(appliedResult.structuredContent).status,
    ).toBe("applied");
    expect(
      await readFile(path.join(root, "Notes", "Alpha.md"), "utf8"),
    ).toContain("Appended by MCP");
  });

  it("requires and consumes a bound confirmation before trashing", async () => {
    await client.listTools();
    const listed = paginatedSchema(NoteSummarySchema).parse(
      (
        await client.callTool({
          name: "obsidian.list_notes",
          arguments: { vaultId: "fixture-vault" },
        })
      ).structuredContent,
    );
    const beta = listed.items.find((note) => note.path === "Notes/Beta.md");
    expect(beta).toBeDefined();
    if (beta === undefined) throw new Error("Beta was not listed");
    const request = {
      vaultId: "fixture-vault",
      noteId: beta.noteId,
      expectedRevision: beta.revision,
      idempotencyKey: "mcp-trash-0001",
    };
    const preview = MutationResultSchema.parse(
      (
        await client.callTool({
          name: "obsidian.trash_note",
          arguments: { ...request, dryRun: true },
        })
      ).structuredContent,
    );
    expect(preview.plan?.diff.confirmationRequired).toBe(true);
    if (preview.plan === undefined)
      throw new Error("Trash plan was not returned");

    const denied = await client.callTool({
      name: "obsidian.trash_note",
      arguments: { ...request, dryRun: false },
    });
    expect(denied.isError).toBe(true);
    const confirmation = await client.callTool({
      name: "obsidian.ui.confirm_mutation",
      arguments: { plan: preview.plan },
    });
    const confirmationToken = (
      confirmation.structuredContent as { confirmationToken: string }
    ).confirmationToken;
    const applied = await client.callTool({
      name: "obsidian.trash_note",
      arguments: { ...request, dryRun: false, confirmationToken },
    });
    expect(MutationResultSchema.parse(applied.structuredContent).status).toBe(
      "applied",
    );
    await expect(access(path.join(root, "Notes", "Beta.md"))).rejects.toThrow();
  });
});
