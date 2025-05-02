# MCP Run Python Local

A **Model Context Protocol (MCP)** server that executes Python code *natively* on your machine. Unlike browser‑sandbox approaches (e.g. Pyodide), this server spawns your local Python interpreter directly, giving you full performance, native C‑extensions, and access to your filesystem.

> **Heads‑up ☑️** Mount points and virtual working‑directory tricks are gone.
> You pass real paths to your code; the server runs them exactly as given.
> A virtual‑env is still *supported* (via `--venv`) but entirely **optional**.

---

## Features

|  ✓                                  |  Description                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| **Native execution**                | Runs against any Python on your `PATH` or a supplied virtual‑env.                           |
| **Arbitrary snippets & files**      | Either send a code string (`run_python_code`) or point to a `.py` file (`run_python_file`). |
| \*\*On‑demand \*\***`pip install`** | The `install_python_package` tool calls `pip` in the same interpreter.                      |
| **Stdio or HTTP (SSE)**             | Use as a local subprocess or as a small HTTP server for remote agents.                      |
| **Minimal surface area**            | No mount config, no working‑dir juggling, fewer moving parts.                               |

---

## Installation

```bash
# 1 · Install Deno if you haven’t yet
curl -fsSL https://deno.land/x/install/install.sh | sh   # macOS / Linux
# …or for Windows (PowerShell)
irm https://deno.land/install.ps1 | iex

# 2 · Run the MCP server via jsr
# ⓘ  The `-A` flag gives Deno the permissions it needs (net, run, read, write).
```

---

## Quick start

### Local subprocess (stdio transport)

```bash
deno run -A jsr:@changhc/mcp-run-python-local stdio
```

### HTTP server (SSE transport)

```bash
deno run -A jsr:@changhc/mcp-run-python-local sse --port 3001
```

### Using a specific virtual‑env

```bash
deno run -A jsr:@changhc/mcp-run-python-local stdio \
  --venv /path/to/your/venv    # optional
```

If `--venv` is omitted the server uses whatever `python` it finds on `PATH`.

---

## Warm‑up / smoke test

```bash
deno run -A jsr:@changhc/mcp-run-python-local warmup
```

The command prints an XML blob containing your Python version, confirming that the server can launch the interpreter.

---

## Integration example (Pydantic AI)

```python
from pydantic_ai import Agent
from pydantic_ai.mcp import MCPServerStdio

server = MCPServerStdio(
    'deno',
    args=[
        'run', '-A', 'jsr:@changhc/mcp-run-python-local', 'stdio',
        '--venv', '/path/to/venv',             # ← optional
    ],
)
agent = Agent('claude-3-5-sonnet-latest', mcp_servers=[server])

async def main():
    async with agent.run_mcp_servers():
        result = await agent.run('Plot y = sin(x) and save it as plot.png')
    print(result.output)
```

---

## Available MCP tools

| Tool                     | Purpose                                      | Parameters                    |
| ------------------------ | -------------------------------------------- | ----------------------------- |
| `run_python_code`        | Execute a code **string**.                   | `{ python_code: str }`        |
| `run_python_file`        | Execute a **.py file** on disk.              | `{ file_path: str }`          |
| `install_python_package` | `pip install` inside the active interpreter. | `{ packa`*`ge_name: s`*`tr }` |

---

## Command‑line reference

```
Usage: deno run -A jsr:@changhc/mcp-run-python-local [stdio|sse|warmup] [options]
  --port <num>      Port for the SSE server (default 3001)
  --venv <path>     Path to an existing Python virtual‑environment (optional)
```

---

## Security considerations ⚠️

Running arbitrary Python locally gives that code *full* access to your user account’s permissions—files, network, GPU, you name it. **Only connect trusted agents.** Never expose the SSE port to the public internet without additional sandboxing.

---

## License

MIT
