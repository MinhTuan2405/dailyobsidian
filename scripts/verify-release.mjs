#!/usr/bin/env node

/* global console, process */

import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const warnings = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function displayPath(value) {
  return path.relative(ROOT, value).split(path.sep).join("/");
}

async function exists(relativePath) {
  try {
    await access(path.join(ROOT, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function text(relativePath) {
  return await readFile(path.join(ROOT, relativePath), "utf8");
}

async function json(relativePath) {
  try {
    return JSON.parse(await text(relativePath));
  } catch (error) {
    failures.push(
      `${relativePath} is not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return {};
  }
}

function isPortableRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !value.startsWith("~")
  );
}

async function verifyPackages() {
  const rootPackage = await json("package.json");
  const version = rootPackage.version;
  check(
    typeof version === "string" &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
    "package.json version must be a semantic X.Y.Z version",
  );
  check(
    rootPackage.name === "obsidian-workbench",
    "unexpected root package name",
  );
  check(rootPackage.private === true, "root workspace must remain private");
  check(
    rootPackage.scripts?.["verify:release"] ===
      "node scripts/verify-release.mjs",
    "package.json must wire verify:release to this script",
  );

  const expectedPackages = new Set([
    "@obsidian-workbench/mcp-app",
    "@obsidian-workbench/mcp-server",
    "@obsidian-workbench/obsidian-plugin",
    "@obsidian-workbench/remote-gateway",
    "@obsidian-workbench/shared",
    "@obsidian-workbench/vault-core",
  ]);
  const packageEntries = await readdir(path.join(ROOT, "packages"), {
    withFileTypes: true,
  });
  const discoveredPackages = new Set();
  for (const entry of packageEntries) {
    if (!entry.isDirectory()) continue;
    const packagePath = `packages/${entry.name}/package.json`;
    if (!(await exists(packagePath))) continue;
    const packageMetadata = await json(packagePath);
    discoveredPackages.add(packageMetadata.name);
    check(
      packageMetadata.version === version,
      `${packagePath} version ${String(packageMetadata.version)} does not match ${version}`,
    );
    check(
      packageMetadata.private === true,
      `${packagePath} must remain private until a separate publishing review`,
    );
  }
  for (const packageName of expectedPackages) {
    check(
      discoveredPackages.has(packageName),
      `missing workspace ${packageName}`,
    );
  }
  for (const packageName of discoveredPackages) {
    check(
      expectedPackages.has(packageName),
      `undocumented workspace package ${String(packageName)}`,
    );
  }

  const pluginManifest = await json("packages/obsidian-plugin/manifest.json");
  const pluginPackage = await json("packages/obsidian-plugin/package.json");
  check(pluginManifest.id === "obsidian-workbench", "unexpected plugin ID");
  check(
    pluginManifest.name === "Obsidian Workbench Companion",
    "unexpected plugin display name",
  );
  check(
    pluginManifest.version === version,
    "companion manifest version must match the root version",
  );
  check(
    pluginPackage.version === pluginManifest.version,
    "companion package and manifest versions differ",
  );
  check(pluginPackage.main === "main.js", "companion main must be main.js");
  check(
    await exists("packages/obsidian-plugin/styles.css"),
    "companion styles.css is missing",
  );
  const pluginBuild = await text("packages/obsidian-plugin/esbuild.config.mjs");
  check(
    /outfile:\s*["']main\.js["']/.test(pluginBuild),
    "companion build must emit main.js",
  );
  check(
    /sourcemap:\s*production\s*\?\s*false/.test(pluginBuild),
    "companion production build must disable source maps",
  );

  const serverSource = await text("packages/mcp-server/src/server.ts");
  const serverVersion = /version:\s*["']([^"']+)["']/.exec(serverSource)?.[1];
  check(
    serverVersion === version,
    `MCP server version ${String(serverVersion)} does not match ${version}`,
  );

  const pyproject = await text("pyproject.toml");
  const pythonVersion = /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1];
  check(
    pythonVersion === version,
    `Python prototype version ${String(pythonVersion)} does not match ${version}`,
  );
  for (const legacyManifestPath of [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
  ]) {
    const legacyManifest = await json(legacyManifestPath);
    check(
      legacyManifest.version === pythonVersion,
      `${legacyManifestPath} must match the Python prototype version`,
    );
    check(
      legacyManifest.name === "daily-obsidian",
      `${legacyManifestPath} must remain the distinct daily-obsidian prototype`,
    );
  }

  const legacyMcp = await json(".mcp.json");
  const legacyCodex = await json(".codex-mcp.json");
  const legacyUrl = legacyMcp.mcpServers?.["daily-obsidian"]?.url;
  check(
    legacyUrl === "https://dailynotesmcp.vercel.app/mcp",
    ".mcp.json legacy greeting endpoint changed unexpectedly",
  );
  check(
    legacyCodex["daily-obsidian"]?.url === legacyUrl,
    ".codex-mcp.json must match the legacy greeting endpoint",
  );
  const vercel = await json("vercel.json");
  check(
    vercel.rewrites?.[0]?.destination === "/api/index.py",
    "Vercel must continue to deploy the preserved Python prototype",
  );

  return version;
}

async function verifyConfigs(version) {
  const localConfig = await json("config/mcp.local.example.json");
  const localServer = localConfig.mcpServers?.["obsidian-workbench"];
  check(localServer !== undefined, "local MCP example is missing its server");
  check(localServer?.command === "node", "local MCP example must invoke Node");
  check(
    Array.isArray(localServer?.args) &&
      localServer.args.length === 1 &&
      localServer.args[0] === "packages/mcp-server/dist/main.js",
    "local MCP example must launch the built Workbench server",
  );
  check(
    isPortableRelativePath(localServer?.env?.OBSIDIAN_VAULT_PATH),
    "local MCP example vault path must be portable and relative",
  );
  check(
    localServer?.env?.OBSIDIAN_VAULT_ID === "workbench-test",
    "local MCP example must use the documented test vault ID",
  );
  check(
    localServer?.env?.OBSIDIAN_VAULTS_JSON === undefined,
    "local MCP example must remain read-only by default",
  );

  const appConfig = await json("config/mcp-app.example.json");
  check(
    appConfig.schemaVersion === 1,
    "unexpected MCP App config schema version",
  );
  check(appConfig.name === "Obsidian Workbench", "unexpected MCP App name");
  check(
    appConfig.version === version,
    "MCP App config version is inconsistent",
  );
  check(
    appConfig.resource?.uri === "ui://obsidian-workbench/index.html",
    "MCP App config resource URI is inconsistent",
  );
  check(
    appConfig.resource?.htmlPath === "packages/mcp-app/dist/index.html",
    "MCP App config HTML path is inconsistent",
  );
  check(
    isPortableRelativePath(appConfig.resource?.htmlPath),
    "MCP App HTML path must be portable and relative",
  );
  check(
    Array.isArray(appConfig.resource?.csp?.connectDomains) &&
      appConfig.resource.csp.connectDomains.length === 0 &&
      Array.isArray(appConfig.resource?.csp?.resourceDomains) &&
      appConfig.resource.csp.resourceDomains.length === 0,
    "MCP App example must retain an empty external CSP",
  );
  check(
    appConfig.entryTool === "obsidian.list_vaults",
    "MCP App entry tool is inconsistent",
  );
  check(
    appConfig.localServerConfig === "config/mcp.local.example.json",
    "MCP App local server reference is inconsistent",
  );

  const appRegistration = await text(
    "packages/mcp-server/src/app/workbench-app.ts",
  );
  check(
    appRegistration.includes(
      `WORKBENCH_APP_URI = "${appConfig.resource?.uri}"`,
    ),
    "MCP App config URI does not match runtime registration",
  );
  check(
    appRegistration.includes("connectDomains: [], resourceDomains: []"),
    "runtime MCP App CSP no longer matches the release config",
  );
  const viteConfig = await text("packages/mcp-app/vite.config.ts");
  check(
    viteConfig.includes("viteSingleFile()") &&
      /outDir:\s*["']dist["']/.test(viteConfig),
    "MCP App must remain a single-file dist build",
  );
}

function registeredNames(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

async function verifyToolsAndDocs() {
  const readSource = await text(
    "packages/mcp-server/src/tools/register-read-tools.ts",
  );
  const writeSource = await text(
    "packages/mcp-server/src/tools/register-write-tools.ts",
  );
  const appSource = await text("packages/mcp-server/src/app/workbench-app.ts");
  const readTools = registeredNames(
    readSource,
    /server\.registerTool\(\s*["']([^"']+)["']/g,
  );
  const writeTools = registeredNames(
    writeSource,
    /server\.registerTool\(\s*["']([^"']+)["']/g,
  );
  const appTools = registeredNames(
    appSource,
    /registerAppTool\(\s*server,\s*["']([^"']+)["']/g,
  );
  const allTools = [...readTools, ...writeTools, ...appTools];
  check(
    readTools.length === 17,
    `expected 17 read tools, found ${readTools.length}`,
  );
  check(
    writeTools.length === 8,
    `expected 8 write tools, found ${writeTools.length}`,
  );
  check(appTools.length === 1, `expected 1 app tool, found ${appTools.length}`);
  check(
    new Set(allTools).size === allTools.length,
    "registered MCP tool names must be unique",
  );

  const forbidden = [
    "obsidian.execute",
    "obsidian.run_command",
    "obsidian.run_javascript",
    "obsidian.shell",
    "obsidian.raw_filesystem",
    "obsidian.install_plugin",
    "obsidian.enable_plugin",
    "obsidian.disable_plugin",
    "obsidian.write_config",
    "obsidian.hard_delete",
  ];
  for (const tool of forbidden) {
    check(!allTools.includes(tool), `forbidden tool is registered: ${tool}`);
  }

  check(
    /READ_ONLY_ANNOTATIONS\s*=\s*\{[\s\S]*?readOnlyHint:\s*true,[\s\S]*?destructiveHint:\s*false,[\s\S]*?idempotentHint:\s*true,[\s\S]*?openWorldHint:\s*false,[\s\S]*?\}/.test(
      readSource,
    ),
    "read annotation constant changed unexpectedly",
  );
  check(
    /WRITE_ANNOTATIONS\s*=\s*\{[\s\S]*?readOnlyHint:\s*false,[\s\S]*?destructiveHint:\s*false,[\s\S]*?idempotentHint:\s*true,[\s\S]*?openWorldHint:\s*false,[\s\S]*?\}/.test(
      writeSource,
    ),
    "write annotation constant changed unexpectedly",
  );
  check(
    /DESTRUCTIVE_ANNOTATIONS\s*=\s*\{[\s\S]*?destructiveHint:\s*true,[\s\S]*?\}/.test(
      writeSource,
    ),
    "destructive annotation constant changed unexpectedly",
  );

  const catalog = await text("docs/tool-catalog.md");
  const headingPattern = /^### `([^`]+)`\s*$/gm;
  const headings = [...catalog.matchAll(headingPattern)].filter((match) =>
    match[1].startsWith("obsidian."),
  );
  const documentedTools = headings.map((match) => match[1]);
  check(
    new Set(documentedTools).size === documentedTools.length,
    "tool catalog contains duplicate tool headings",
  );
  for (const tool of allTools) {
    check(documentedTools.includes(tool), `tool catalog is missing ${tool}`);
  }
  for (const tool of documentedTools) {
    check(
      allTools.includes(tool),
      `tool catalog invents unregistered tool ${tool}`,
    );
  }

  const requiredFields = [
    "User intent",
    "Input",
    "Output",
    "Scope",
    "Annotations",
    "Confirmation",
    "Common errors",
  ];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? catalog.length;
    const section = catalog.slice(start, end);
    for (const field of requiredFields) {
      check(
        section.includes(`- **${field}:**`),
        `${heading[1]} documentation is missing ${field}`,
      );
    }
    let annotation;
    if (readTools.includes(heading[1])) {
      annotation =
        "readOnlyHint=true; destructiveHint=false; idempotentHint=true; openWorldHint=false";
    } else if (heading[1] === "obsidian.trash_note") {
      annotation =
        "readOnlyHint=false; destructiveHint=true; idempotentHint=true; openWorldHint=false";
    } else if (appTools.includes(heading[1])) {
      annotation =
        "readOnlyHint=false; destructiveHint=false; idempotentHint=false; openWorldHint=false";
    } else {
      annotation =
        "readOnlyHint=false; destructiveHint=false; idempotentHint=true; openWorldHint=false";
    }
    check(
      section.includes(annotation),
      `${heading[1]} documentation has inconsistent annotations`,
    );
  }
}

async function verifyDocumentation() {
  const requiredDocs = [
    "docs/architecture.md",
    "docs/threat-model.md",
    "docs/tool-catalog.md",
    "docs/privacy.md",
    "docs/terms-placeholder.md",
    "docs/local-development.md",
    "docs/remote-bridge.md",
    "docs/release-checklist.md",
  ];
  const readme = await text("README.md");
  for (const docPath of requiredDocs) {
    check(
      await exists(docPath),
      `required documentation is missing: ${docPath}`,
    );
    check(
      readme.includes(`(${docPath})`),
      `README.md does not link to ${docPath}`,
    );
  }
  for (const linkedPath of [
    "assets/README.md",
    "packages/obsidian-plugin/README.md",
    "config/mcp.local.example.json",
    "config/mcp-app.example.json",
  ]) {
    check(await exists(linkedPath), `release file is missing: ${linkedPath}`);
    check(
      readme.includes(linkedPath),
      `README.md does not reference ${linkedPath}`,
    );
  }
  check(
    readme.includes("Preserved Python/FastMCP Prototype") &&
      readme.includes("does **not** expose Obsidian Workbench vault tools"),
    "README must clearly distinguish the preserved Python prototype",
  );

  const privacy = await text("docs/privacy.md");
  const terms = await text("docs/terms-placeholder.md");
  const release = await text("docs/release-checklist.md");
  check(
    (privacy.match(/OWNER\/LEGAL DECISION REQUIRED/g) ?? []).length >= 5,
    "privacy document must retain explicit owner/legal placeholders",
  );
  check(
    terms.includes("No terms are supplied by this repository") &&
      terms.includes("not a contract"),
    "terms document must remain an explicit non-legal placeholder",
  );
  check(
    release.includes("Current Unresolved Public Blockers") &&
      release.includes("creates a draft"),
    "release checklist must identify unresolved blockers and draft publication",
  );
}

async function verifyAssets(version) {
  const manifest = await json("assets/manifest.json");
  const assetDocs = await text("assets/README.md");
  check(manifest.version === version, "asset manifest version is inconsistent");
  check(
    Array.isArray(manifest.assets),
    "asset manifest assets must be an array",
  );
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const ids = new Set();
  let readyCount = 0;
  for (const asset of assets) {
    check(typeof asset.id === "string", "asset entry is missing an ID");
    check(!ids.has(asset.id), `duplicate asset ID ${String(asset.id)}`);
    ids.add(asset.id);
    check(
      isPortableRelativePath(asset.path) && asset.path.startsWith("assets/"),
      `asset ${String(asset.id)} has an invalid path`,
    );
    check(asset.format === "PNG", `asset ${String(asset.id)} must be PNG`);
    check(
      Number.isInteger(asset.width) && asset.width > 0,
      `asset ${String(asset.id)} width is invalid`,
    );
    check(
      Number.isInteger(asset.height) && asset.height > 0,
      `asset ${String(asset.id)} height is invalid`,
    );
    check(
      Number.isInteger(asset.maxBytes) && asset.maxBytes > 0,
      `asset ${String(asset.id)} size cap is invalid`,
    );
    check(
      assetDocs.includes(`\`${String(asset.path)}\``),
      `asset documentation is missing ${String(asset.path)}`,
    );
    const present = await exists(asset.path);
    if (asset.status === "placeholder") {
      check(
        !present,
        `placeholder asset must not have a fake binary: ${asset.path}`,
      );
      warn(
        `public-release asset remains a documented placeholder: ${asset.path}`,
      );
      continue;
    }
    check(
      asset.status === "ready",
      `asset ${String(asset.id)} has invalid status`,
    );
    if (asset.status !== "ready") continue;
    readyCount += 1;
    check(present, `ready asset is missing: ${asset.path}`);
    if (!present) continue;
    const bytes = await readFile(path.join(ROOT, asset.path));
    check(
      bytes.length <= asset.maxBytes,
      `${asset.path} exceeds its ${String(asset.maxBytes)} byte cap`,
    );
    check(
      bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a",
      `${asset.path} is not a PNG`,
    );
    if (bytes.length >= 24) {
      check(
        bytes.readUInt32BE(16) === asset.width &&
          bytes.readUInt32BE(20) === asset.height,
        `${asset.path} dimensions do not match its manifest`,
      );
    }
  }
  check(
    assets.length === 5,
    `expected 5 production asset records, found ${assets.length}`,
  );
  check(
    manifest.status ===
      (readyCount === assets.length ? "ready" : "placeholder"),
    "top-level asset status does not match entry statuses",
  );
}

const secretPatterns = [
  {
    name: "private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g,
  },
  {
    name: "OpenAI-style key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { name: "Stripe live key", pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/g },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  {
    name: "credential in URL",
    pattern: /https?:\/\/[^\s/:]+:[^\s/@]+@[^\s/]+/g,
  },
];

const genericSecretPattern =
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|signing[_-]?key|password|secret)\s*[:=]\s*["'`]([^"'`\r\n]{12,})["'`]/gi;

function isAllowedPlaceholder(value) {
  return /(?:example|placeholder|change[-_]?me|replace|dummy|test[-_ ]?only|not[-_ ]a[-_ ]secret|<[^>]+>|\$\{|example\.invalid)/i.test(
    value,
  );
}

async function sourceFiles(directory) {
  const results = [];
  if (!(await exists(displayPath(directory)))) return results;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const parts = displayPath(absolute).split("/");
    if (
      parts.some((part) =>
        [
          "tests",
          "test",
          "fixtures",
          "__fixtures__",
          "__snapshots__",
          "node_modules",
          "dist",
        ].includes(part),
      )
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      results.push(...(await sourceFiles(absolute)));
      continue;
    }
    if (
      /\.(?:ts|tsx|js|mjs|cjs|py|json|jsonc|ya?ml|toml|env)$/i.test(entry.name)
    ) {
      results.push(absolute);
    }
  }
  return results;
}

async function verifyCredentials() {
  const roots = [
    path.join(ROOT, "src"),
    path.join(ROOT, "api"),
    path.join(ROOT, "config"),
  ];
  const packageEntries = await readdir(path.join(ROOT, "packages"), {
    withFileTypes: true,
  });
  for (const entry of packageEntries) {
    if (entry.isDirectory())
      roots.push(path.join(ROOT, "packages", entry.name, "src"));
  }
  const files = [];
  for (const root of roots) files.push(...(await sourceFiles(root)));
  for (const rootConfig of [".mcp.json", ".codex-mcp.json"]) {
    if (await exists(rootConfig)) files.push(path.join(ROOT, rootConfig));
  }

  for (const file of files) {
    const contents = await readFile(file, "utf8");
    for (const { name, pattern } of secretPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(contents)) {
        failures.push(`${displayPath(file)} contains an apparent ${name}`);
      }
    }
    genericSecretPattern.lastIndex = 0;
    for (const match of contents.matchAll(genericSecretPattern)) {
      if (!isAllowedPlaceholder(match[1])) {
        failures.push(
          `${displayPath(file)} contains an apparent literal credential near index ${String(match.index)}`,
        );
      }
    }
  }
  return files.length;
}

async function main() {
  const version = await verifyPackages();
  await verifyConfigs(version);
  await verifyToolsAndDocs();
  await verifyDocumentation();
  await verifyAssets(version);
  const scannedFiles = await verifyCredentials();

  for (const message of warnings) console.warn(`WARN: ${message}`);
  if (failures.length > 0) {
    for (const message of failures) console.error(`ERROR: ${message}`);
    console.error(
      `Release verification failed with ${failures.length} error(s).`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Release metadata verification passed for v${String(version)} (${scannedFiles} non-test source/config files scanned; ${warnings.length} documented placeholder warning(s)).`,
  );
}

await main();
