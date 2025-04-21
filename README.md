# MCP Run Python Local

A Model Context Protocol (MCP) server for running Python code directly on the local machine, with virtual filesystem mapping and automatic dependency installation.

## Features

- Execute Python code directly on the local machine
- Run Python files by path 
- Map a virtual filesystem path to a local directory
- **Automatic detection and installation of missing dependencies**
- Support for explicit dependencies via PEP 723 metadata
- Similar interface to the Pyodide-based MCP Run Python server

## Key Differences from MCP Run Python

Unlike the Pyodide-based MCP Run Python server, this server:

1. Runs code directly on your local Python interpreter (not in a sandbox)
2. Has full access to your local filesystem through a configurable mount point
3. Can run existing Python files, not just code strings
4. Automatically detects and installs missing dependencies

## Usage

### Installation

You can install this package using Deno's JSR:

```bash
# Install Deno if you don't have it already
# macOS or Linux
curl -fsSL https://deno.land/x/install/install.sh | sh

# Windows (PowerShell)
irm https://deno.land/install.ps1 | iex
```

### Running the Server

To run with stdio transport (for local subprocess usage):

```bash
deno run -A jsr:@changhc/mcp-run-python-local stdio --mount /working_space --path /path/to/your/local/directory
```

To run as an HTTP server with SSE transport:

```bash
deno run -A jsr:@changhc/mcp-run-python-local sse --port 3001 --mount /working_space --path /path/to/your/local/directory
```

To test if everything is working correctly (does a basic Python test):

```bash
deno run -A jsr:@changhc/mcp-run-python-local warmup
```

### Options

- `--port`: Port to run the SSE server on (default: 3001)
- `--mount`: Virtual path prefix for file access (default: /working)
- `--path`: Local filesystem path that will be mapped to the mount point (default: a temp directory)

## Using with PydanticAI

Here's how to use this server with PydanticAI:

```python
from pydantic_ai import Agent
from pydantic_ai.mcp import MCPServerStdio

# Set up logging
import logfire
logfire.configure()
logfire.instrument_mcp()
logfire.instrument_pydantic_ai()

# Create the MCP server
server = MCPServerStdio('deno',
    args=[
        'run',
        '-A',
        'jsr:@changhc/mcp-run-python-local',
        'stdio',
        '--mount', '/working',
        '--path', '/path/to/your/local/directory'
    ])

# Create the agent with the server
agent = Agent('claude-3-5-sonnet-latest', mcp_servers=[server])

# Run a query that will use Python
async def main():
    async with agent.run_mcp_servers():
        result = await agent.run('Create a plot showing a sine wave and save it to a file')
    print(result.output)

if __name__ == '__main__':
    import asyncio
    asyncio.run(main())
```

## Automatic Dependency Installation

This server automatically detects and installs missing Python packages when they are imported in your code. For example:

```python
import pandas as pd  # pandas will be automatically installed if missing

df = pd.DataFrame({'A': [1, 2, 3], 'B': [4, 5, 6]})
print(df)
```

You can also explicitly declare dependencies using PEP 723 format:

```python
# /// script
# dependencies = ['matplotlib', 'numpy', 'pandas']
# ///

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

# Your code here
```

## Security Considerations

⚠️ **WARNING**: This server executes Python code directly on your machine with the same permissions as the user running the server. This means:

1. The Python code has full access to any files and resources available to the user running the server
2. The virtual filesystem mapping provides convenience but not security isolation
3. You should only use this with trusted AI systems and in controlled environments

Do not expose this server to untrusted inputs or to the public internet.

## Example Python Code

Here's an example of code that creates a plot and saves it to the virtual mount point:

```python
# Missing packages like matplotlib and numpy will be automatically installed

import numpy as np
import matplotlib.pyplot as plt

# Create a simple plot
x = np.linspace(0, 10, 100)
y = np.sin(x)

plt.figure(figsize=(10, 6))
plt.plot(x, y, 'b-', linewidth=2)
plt.title('Sine Wave')
plt.xlabel('x')
plt.ylabel('sin(x)')
plt.grid(True)

# Save the plot to the mounted directory
save_path = '/working/sine_wave.png'
plt.savefig(save_path)
print(f"Plot saved to {save_path}")
```

## License

MIT