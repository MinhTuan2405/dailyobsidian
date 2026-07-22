# Daily Notes MCP

A maintainable [FastMCP](https://gofastmcp.com/) server for daily notes. It currently exposes one MCP prompt, `hello_mcp_world`, and one read-only greeting tool, `say_hello_mcp_world`.

> Hello, MCP World!

The server exposes Streamable HTTP at `/mcp` and an operational health check at `/health`.

## Project layout

```text
src/dailynotesmcp/server.py    # MCP components, HTTP settings, and ASGI app
api/index.py                   # Vercel function entry point
tests/test_server.py           # In-memory MCP contract tests
```

The `src` layout prevents accidental imports from the repository root. `pyproject.toml` is the single source of truth for runtime, development, lint, test, and build configuration. `uv.lock` must be committed whenever dependencies change.

## Local development

Requirements: [uv](https://docs.astral.sh/uv/) and Python 3.12.

```powershell
uv sync --all-groups
uv run dailynotesmcp
```

Connect an MCP client to `http://localhost:8000/mcp`. Check the local process with `http://localhost:8000/health`.

Codex surfaces MCP tools rather than MCP prompts. Ask it to use `say_hello_mcp_world` when you want the greeting.

For a local STDIO client configuration:

```json
{
  "command": "uv",
  "args": ["run", "fastmcp", "run", "src/dailynotesmcp/server.py"]
}
```

## Quality checks

Run these before opening a pull request:

```powershell
uv run ruff check .
uv run pytest
```

The GitHub Actions workflow runs the same checks on pull requests and pushes to `main`.

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
