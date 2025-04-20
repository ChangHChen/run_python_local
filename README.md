# MCP Run Python (Local)

Execute Python 3 code **directly on the host interpreter** from any
Model‑Context‑Protocol agent.

*   Installs dependencies with `pip` (PEP 723 block **or** import scan).
*   Provides two MCP tools

    | Tool name           | Signature                                    | Notes |
    |---------------------|----------------------------------------------|-------|
    | `run_python_local`  | `{ python_code: string }`                    | Run arbitrary code (last expression → return‑value). |
    | `run_python_file`   | `{ path: string }`                           | Run an existing file whose *virtual* path starts with the mount root. |

## Quick start

```bash
# ❯ deno run (permissions: -A = allow‑all, or tighten them if you prefer)
deno run -A jsr:@changhc/mcp-run-python-local stdio \
  --mount {local_dir}:{virtual_dir}
```

### Flags


Flag	Default	Description
stdio / sse	–	Transport.
--port <N>	 3002	(Only for sse)
--mount host:virtualRoot	 /tmp/run_python_local:/working	Binds a host directory to a virtual root visible in Python.