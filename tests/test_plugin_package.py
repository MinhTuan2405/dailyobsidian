"""Tests for the GitHub-installable Codex and Claude Code package metadata."""

import json
import tomllib
from pathlib import Path

ROOT = Path(__file__).parent.parent
MCP_ENDPOINT = "https://dailynotesmcp.vercel.app/mcp"


def _read_json(path: str) -> dict[str, object]:
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def test_plugin_manifests_match_the_python_package_version() -> None:
    with (ROOT / "pyproject.toml").open("rb") as file:
        package_version = tomllib.load(file)["project"]["version"]

    claude_manifest = _read_json(".claude-plugin/plugin.json")
    codex_manifest = _read_json(".codex-plugin/plugin.json")

    assert claude_manifest["version"] == package_version
    assert codex_manifest["version"] == package_version


def test_plugin_mcp_configs_use_the_deployed_http_endpoint() -> None:
    claude_server = _read_json(".mcp.json")["mcpServers"]["daily-obsidian"]
    codex_server = _read_json(".codex-mcp.json")["daily-obsidian"]

    assert claude_server == {"type": "http", "url": MCP_ENDPOINT}
    assert codex_server == {"url": MCP_ENDPOINT}


def test_marketplaces_expose_the_plugin_from_the_repository_root() -> None:
    claude_plugin = _read_json(".claude-plugin/marketplace.json")["plugins"][0]
    codex_plugin = _read_json(".agents/plugins/marketplace.json")["plugins"][0]

    assert claude_plugin["name"] == codex_plugin["name"] == "daily-obsidian"
    assert claude_plugin["source"] == "./"
    assert codex_plugin["source"] == {"source": "local", "path": "./"}
