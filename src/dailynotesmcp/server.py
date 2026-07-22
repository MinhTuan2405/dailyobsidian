"""FastMCP server definition and HTTP deployment entry point."""

import os

from fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse

mcp = FastMCP(
    "Daily Notes MCP",
    instructions=(
        "Use check_daily_notes_mcp to verify that this MCP server is available."
    ),
)


@mcp.prompt(
    title="Hello MCP World",
    description="Instruct the agent to greet the MCP world.",
)
def hello_mcp_world() -> str:
    """Return the greeting instruction for the connected agent."""
    return "Say exactly: Hello, MCP World!"


@mcp.tool(
    title="Check Daily Notes MCP",
    description="Verify that the Daily Notes MCP server is available and responding.",
)
def check_daily_notes_mcp() -> str:
    """Return a deterministic response for MCP client connection checks."""
    return "Daily Notes MCP is working. Hello, MCP World!"


@mcp.custom_route("/health", methods=["GET"])
async def health_check(_: Request) -> JSONResponse:
    """Provide a lightweight, unauthenticated deployment health check."""
    return JSONResponse({"status": "ok"})


def _allowed_hosts() -> list[str]:
    """Read explicit hosts and add the Vercel deployment hostname when present."""
    hosts = [
        host.strip()
        for host in os.environ.get("MCP_ALLOWED_HOSTS", "").split(",")
        if host.strip()
    ]
    if vercel_url := os.environ.get("VERCEL_URL"):
        hosts.append(vercel_url)
    return list(dict.fromkeys(hosts))


def _http_options() -> dict[str, object]:
    """Use stateless HTTP so a serverless platform can scale safely."""
    options: dict[str, object] = {"stateless_http": True}
    if hosts := _allowed_hosts():
        options["allowed_hosts"] = hosts
    return options


# Vercel and other ASGI hosts import this object. The MCP endpoint is /mcp.
app = mcp.http_app(**_http_options())


def main() -> None:
    """Run the server locally over Streamable HTTP."""
    mcp.run(
        transport="http",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        **_http_options(),
    )


if __name__ == "__main__":
    main()
