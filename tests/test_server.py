"""Behavioral tests for the public MCP server contract."""

import pytest
from fastmcp.client import Client

from dailynotesmcp.server import app, mcp


@pytest.fixture
async def mcp_client():
    """Connect an in-memory client without opening a network port."""
    async with Client(transport=mcp) as client:
        yield client


async def test_server_exposes_only_the_hello_prompt(mcp_client: Client) -> None:
    prompts = await mcp_client.list_prompts()

    assert [prompt.name for prompt in prompts] == ["hello_mcp_world"]


async def test_hello_prompt_returns_the_expected_agent_instruction(
    mcp_client: Client,
) -> None:
    result = await mcp_client.get_prompt("hello_mcp_world")

    assert result.messages[0].content.text == "Say exactly: Hello, MCP World!"


async def test_greeting_tool_returns_the_expected_response(
    mcp_client: Client,
) -> None:
    result = await mcp_client.call_tool("say_hello_mcp_world")

    assert result.data == "Hello, MCP World!"


def test_asgi_app_exposes_mcp_and_health_routes() -> None:
    assert {route.path for route in app.routes} == {"/mcp", "/health"}
