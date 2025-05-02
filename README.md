# MCP Run Python Local (v0.3.1)

A **Model Context Protocol (MCP)** server that executes Python code *natively* on your machine. It now runs the first `python` and `pip` found on your `PATH`—**no virtual‑envs, mounts, or working‑directory tricks**.

---

## Features

| ✓ | Description |
|---|-------------|
| **Native execution** | Shells out to the system’s `python` binary for full performance and C‑extension support. |
| **Execute snippets & files** | Use `run_python_code` for one‑off strings or `run_python_file` for existing scripts. |
| **On‑demand installs** | The `install_python_package` tool delegates directly to the system‑level `pip`. |
| **Flexible transports** | Operates over stdio (subprocess) or SSE (HTTP stream). |
| **Tiny footprint** | No env management, no sandbox; what you see is what you run. |

---

## Installation & usage

### 1 · Prerequisite: Deno

```bash
# macOS / Linux
curl -fsSL https://deno.land/x/install/install.sh | sh

# Windows (PowerShell)
irm https://deno.land/install.ps1 | iex
```

### 2 · Run the server

```bash
# Local subprocess (stdio)
deno run -A jsr:@changhc/mcp-run-python-local stdio

# HTTP server (SSE) on port 3001
deno run -A jsr:@changhc/mcp-run-python-local sse --port 3001
```

### 3 · Smoke test

```bash
deno run -A jsr:@changhc/mcp-run-python-local warmup
```

---

## Pydantic AI integration

```python
from pydantic_ai import Agent
from pydantic_ai.mcp import MCPServerStdio

server = MCPServerStdio(
    'deno',
    args=['run', '-A', 'jsr:@changhc/mcp-run-python-local', 'stdio'],
)
agent = Agent('claude-3-5-sonnet-latest', mcp_servers=[server])
```

---

## MCP tools reference

| Tool | Purpose | Parameters |
|------|---------|------------|
| `run_python_code` | Execute a code **string**. | `{ python_code: str }` |
| `run_python_file` | Execute a **.py file**. | `{ file_path: str }` |
| `install_python_package` | Run `pip install` for the given package. | `{ package_name: str }` |

---

## Command‑line reference

```
Usage: deno run -A jsr:@changhc/mcp-run-python-local [stdio|sse|warmup] [--port <num>]
```

---

## Security ⚠️

Executing arbitrary Python grants full access to your user account’s files, network, and hardware. Connect only trusted agents and keep the SSE endpoint behind a firewall or VPN if exposed.

---

## License

MIT
