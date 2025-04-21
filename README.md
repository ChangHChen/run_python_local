# MCP Run Python Local

A Model Context Protocol (MCP) server for running Python code directly on the local machine, with virtual filesystem mapping and the ability to use an existing virtual environment. This project is inspired by and based on Pydantic AI's Run Python MCP (which uses Pyodide), but runs Python code natively on your local machine instead of in a browser-based sandbox.

## Features

- Execute Python code directly on the local machine using a specified Python interpreter
- Run Python files by path
- **Multiple virtual filesystem mounts** to map different local directories
- **Support for overlapping mount points** with more specific paths taking precedence
- **Use an existing Python virtual environment** instead of creating new ones for each run
- **Auto-install Python packages** when needed
- Similar interface to the Pyodide-based MCP Run Python server

## Key Differences from Pydantic AI's Run Python MCP

Unlike the Pyodide-based Run Python MCP server from Pydantic AI, this server:

1. Runs code directly on your local Python interpreter (not in a sandbox)
2. Has full access to your local filesystem through configurable mount points
3. Can run existing Python files, not just code strings
4. Can use an existing virtual environment with pre-installed dependencies
5. Supports multiple mount points for more flexible file organization
6. Handles overlapping mount points correctly (more specific paths take precedence)
7. Can dynamically install Python packages when needed

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
deno run -A jsr:@changhc/mcp-run-python-local stdio --mount /path/to/your/workspace:/working --venv /path/to/your/virtualenv
```

To run with multiple mount points:

```bash
deno run -A jsr:@changhc/mcp-run-python-local stdio \
  --mount /path/to/your/workspace:/working \
  --mount /path/to/your/data:/data \
  --mount /path/to/your/output:/output \
  --venv /path/to/your/virtualenv
```

To run as an HTTP server with SSE transport:

```bash
deno run -A jsr:@changhc/mcp-run-python-local sse --port 3001 --mount /path/to/your/workspace:/working --venv /path/to/your/virtualenv
```

To test if everything is working correctly (does a basic Python test):

```bash
deno run -A jsr:@changhc/mcp-run-python-local warmup
```

### Options

- `--port`: Port to run the SSE server on (default: 3001)
- `--mount`: Mount binding in Docker-style format `localPath:mountPoint` (can be specified multiple times)
  - The first mount point is used as the main working directory
  - All temporary Python files are created in the first mount point
  - More specific mount points take precedence over more general ones
- `--venv`: Path to an existing Python virtual environment to use (default: uses system Python)

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

# Create the MCP server with multiple mount points
server = MCPServerStdio('deno',
    args=[
        'run',
        '-A',
        'jsr:@changhc/mcp-run-python-local',
        'stdio',
        '--mount', '/path/to/your/workspace:/working',  # Main working directory
        '--mount', '/path/to/your/data:/data',          # Additional data directory
        '--mount', '/path/to/your/output:/output',      # Output directory
        '--venv', '/path/to/your/virtualenv'            # Specify your virtual environment
    ])

# Create the agent with the server
agent = Agent('claude-3-5-sonnet-latest', mcp_servers=[server])

# Run a query that will use Python
async def main():
    async with agent.run_mcp_servers():
        result = await agent.run('Create a plot showing a sine wave and save it to the output directory')
    print(result.output)

if __name__ == '__main__':
    import asyncio
    asyncio.run(main())
```

## Available Tools

This MCP server provides the following tools:

1. **run_python_code**: Execute Python code strings directly
   ```
   Parameters:
   - python_code: String containing Python code to execute
   ```

2. **run_python_file**: Run a Python file by path
   ```
   Parameters:
   - file_path: Path to the Python file to execute
   ```

3. **install_python_package**: Install a Python package using pip
   ```
   Parameters:
   - package_name: Name of the package to install (use package_name==version format to specify version)
   ```

## Using Multiple Mount Points

This server supports multiple mount points, allowing you to create a more organized file structure:

1. The first mount point specified is the "main" mount point:
   - It serves as the current working directory (cwd) for Python processes
   - Temporary Python files are created in this directory
   - Generally used for your primary workspace

2. Additional mount points can be used for specific purposes:
   - Data directories containing large datasets
   - Output directories for generated files
   - Separate codebases or libraries
   - Configuration directories

3. Mount points can overlap, with more specific paths taking precedence:
   ```bash
   # Example of overlapping mount points
   deno run -A jsr:@changhc/mcp-run-python-local stdio \
     --mount /home/user/project:/working \
     --mount /data:/working/data
   ```
   In this example:
   - The path `/working/data/file.txt` would resolve to `/data/file.txt` on the local machine
   - The path `/working/other/file.txt` would resolve to `/home/user/project/other/file.txt`

Example of using multiple mount points:

```bash
deno run -A jsr:@changhc/mcp-run-python-local stdio \
  --mount /path/to/project:/working \
  --mount /path/to/datasets:/data \
  --mount /path/to/config:/config \
  --mount /path/to/output:/output
```

Your Python code can access these directories through their mount points:

```python
# Load data from the data directory
df = pd.read_csv('/data/my_dataset.csv')

# Save output to the output directory
plt.savefig('/output/my_plot.png')

# Read configuration from the config directory
with open('/config/settings.json', 'r') as f:
    config = json.load(f)
```

## Automatic Package Installation

The server can automatically install Python packages when needed:

1. If your code execution fails due to missing packages, the agent can detect this and install the required dependencies
2. Packages are installed using pip in the specified virtual environment or system Python
3. Use standard pip format (package_name==version) to specify exact versions

Example of an agent using this capability:

```python
# Assume the agent receives this error when trying to run code
# ModuleNotFoundError: No module named 'pandas'

# The agent can then use the install_python_package tool
result = await agent.use_tool('install_python_package', {
    'package_name': 'pandas'
})

# Or with a specific version
result = await agent.use_tool('install_python_package', {
    'package_name': 'pandas==2.0.3'
})

# Then retry the operation with pandas now installed
```

## Using Existing Virtual Environments

This server can use an existing Python virtual environment instead of creating new ones for each execution:

1. Create a virtual environment with all your required dependencies:
   ```bash
   python -m venv /path/to/your/virtualenv
   source /path/to/your/virtualenv/bin/activate  # On Unix/Mac
   # Or on Windows:
   # \path\to\your\virtualenv\Scripts\activate
   
   pip install pandas matplotlib numpy  # Install your dependencies
   ```

2. When starting the MCP server, specify the path to this virtual environment:
   ```bash
   deno run -A jsr:@changhc/mcp-run-python-local stdio --venv /path/to/your/virtualenv
   ```

3. The server will now use the Python interpreter from this virtual environment, with all its pre-installed packages.

## Security Considerations

⚠️ **WARNING**: This server executes Python code directly on your machine with the same permissions as the user running the server. This means:

1. The Python code has full access to any files and resources available to the user running the server
2. The virtual filesystem mapping provides convenience but not security isolation
3. You should only use this with trusted AI systems and in controlled environments

Do not expose this server to untrusted inputs or to the public internet.

## Example Python Code

Here's an example of code that creates a plot and saves it to multiple mount points:

```python
import numpy as np
import matplotlib.pyplot as plt
import os

# Create a simple plot
x = np.linspace(0, 10, 100)
y = np.sin(x)

plt.figure(figsize=(10, 6))
plt.plot(x, y, 'b-', linewidth=2)
plt.title('Sine Wave')
plt.xlabel('x')
plt.ylabel('sin(x)')
plt.grid(True)

# Save the plot to the main working directory
main_save_path = '/working/sine_wave.png'
plt.savefig(main_save_path)
print(f"Plot saved to {main_save_path}")

# Save the plot to the output directory (if it exists)
if os.path.exists('/output'):
    output_save_path = '/output/sine_wave.png'
    plt.savefig(output_save_path)
    print(f"Plot also saved to {output_save_path}")
```

## License

MIT