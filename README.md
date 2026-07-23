# Daily Obsidian

A [FastMCP](https://gofastmcp.com/) server and plugin marketplace for Daily Obsidian. It currently exposes the `hello_mcp_world` prompt and the read-only `say_hello_mcp_world` tool.

The repository is a GitHub-installable plugin marketplace for both Codex and Claude Code. Installed plugins connect to the deployed Streamable HTTP server at `https://dailynotesmcp.vercel.app/mcp`.

## Install from GitHub

### Claude Code

Run these commands in Claude Code:

```text
/plugin marketplace add MinhTuan2405/dailyobsidian
/plugin install daily-obsidian@daily-obsidian-marketplace
/reload-plugins
```

Claude Code connects to the bundled remote `daily-obsidian` MCP server automatically. Its tools are available under the plugin MCP namespace.

### Codex

Add the GitHub marketplace from the Codex CLI:

```shell
codex plugin marketplace add MinhTuan2405/dailyobsidian
```

In the ChatGPT desktop app, open **Plugins**, select **Daily Obsidian**, and install `daily-obsidian` from the marketplace. The plugin is then available to Codex in the desktop app.

For Codex CLI or IDE users who only need the MCP server, add the deployed endpoint to `~/.codex/config.toml`:

```toml
[mcp_servers.daily-obsidian]
url = "https://dailynotesmcp.vercel.app/mcp"
```

Run `codex mcp list` to confirm the connection. Codex surfaces MCP tools rather than MCP prompts; ask it to use `say_hello_mcp_world` for the greeting.

## Project layout

```text
src/dailynotesmcp/server.py          # MCP components and HTTP/STDIO entry points
.claude-plugin/                      # Claude Code plugin and marketplace manifests
.codex-plugin/                       # Codex plugin manifest
.agents/plugins/marketplace.json     # Codex GitHub marketplace catalog
api/index.py                          # Vercel function entry point
tests/test_server.py                  # In-memory MCP contract tests
```

`pyproject.toml` is the source of truth for runtime, development, lint, test, and build configuration. Commit `uv.lock` whenever dependencies change.

## Local development

Requirements: [uv](https://docs.astral.sh/uv/) and Python 3.12.

```powershell
uv sync --all-groups
uv run dailynotesmcp
```

Connect an HTTP MCP client to `http://localhost:8000/mcp`. Check the process with `http://localhost:8000/health`.

To run the packaged STDIO entry point locally:

```powershell
uv run dailynotesmcp-stdio
```

## Quality checks

Run these before opening a pull request:

```powershell
uv run ruff check .
uv run pytest
```

The GitHub Actions workflow runs the same checks on pull requests and pushes to `main`.

## Release

1. Update the version in `pyproject.toml`, `.claude-plugin/plugin.json`, and `.codex-plugin/plugin.json`.
2. Run the quality checks.
3. Commit the version change, then create and push a matching tag such as `v0.1.1`.

The release workflow validates the project, builds the Python wheel and source distribution, and creates a GitHub Release with those artifacts. Plugin users receive a new version after refreshing their marketplace and updating the plugin.

## Updating the server

1. Add prompts, tools, or resources in `src/dailynotesmcp/server.py`. Use stable, descriptive component names because MCP clients rely on them.
2. Add an in-memory MCP client test in `tests/` for every public component and behavior change.
3. Change dependencies with `uv add` or `uv add --group dev`, then commit both `pyproject.toml` and `uv.lock`.
4. Keep credentials out of source control. Add them as Vercel environment variables and read them with `os.environ`.
5. Add authentication before exposing data or actions. A public MCP endpoint should not trust its callers by default.

## Deploy to Vercel

1. Push the repository and import it in Vercel, or run `vercel` from the project root.
2. Vercel installs the package from `pyproject.toml` and loads `api/index.py`, which exports the FastMCP ASGI app.
3. Deploy with `vercel --prod`.
4. Connect clients to `https://<your-project>.vercel.app/mcp` and verify `https://<your-project>.vercel.app/health`.

The server enables `stateless_http=True`, which is required for reliable serverless scaling. Vercel automatically supplies `VERCEL_URL`, which the server uses for FastMCP host validation. Set `MCP_ALLOWED_HOSTS` to a comma-separated list when using one or more custom domains.

Vercel is suitable for this stateless prompt server. Move to an always-on ASGI platform before adding long-running work, persistent sessions, or in-memory state. Browser-based MCP clients may additionally require configured CORS origins; do not use wildcard production origins.
