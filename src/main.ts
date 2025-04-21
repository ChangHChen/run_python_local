import { parseArgs } from '@std/cli/parse-args';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type LoggingLevel, SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const VERSION = '0.0.94';

// Configuration for the virtual file system mapping
interface FileSystemConfig {
  mountPoint: string;  // Virtual path (e.g., /working)
  localPath: string;   // Real path on the machine (e.g., /home/user/project/temp)
  venvPath: string | null;  // Path to the existing virtual environment
}

// Default to a temp directory if no configuration is provided
const defaultConfig: FileSystemConfig = {
  mountPoint: '/working',
  localPath: Deno.makeTempDirSync({ prefix: 'mcp-python-local-' }),
  venvPath: null  // Default to null (will use system Python if not specified)
};

let fsConfig: FileSystemConfig = defaultConfig;

// Create the mount directory if it doesn't exist
async function ensureMountDirectoryExists() {
  try {
    await Deno.mkdir(fsConfig.localPath, { recursive: true });
    console.log(`Created directory: ${fsConfig.localPath}`);
  } catch (error) {
    // Ignore error if directory already exists
    if (!(error instanceof Deno.errors.AlreadyExists)) {
      console.error(`Failed to create directory: ${fsConfig.localPath}`, error);
      throw error;
    }
  }
}

// Convert a virtual path to a local filesystem path
function virtualToLocalPath(virtualPath: string): string {
  if (!virtualPath.startsWith(fsConfig.mountPoint)) {
    throw new Error(`Path ${virtualPath} is outside the mount point ${fsConfig.mountPoint}`);
  }
  
  const relativePath = virtualPath.substring(fsConfig.mountPoint.length);
  return `${fsConfig.localPath}${relativePath}`;
}

// Replace virtual paths in code with local paths
function replaceVirtualPaths(code: string): string {
  // Replace all occurrences of the mount point with the local path
  return code.replace(
    new RegExp(fsConfig.mountPoint, 'g'), 
    fsConfig.localPath
  );
}

// Get the Python executable path from the virtual environment or use system Python
function getPythonPath(): string {
  // If venvPath is provided, use Python from that environment
  if (fsConfig.venvPath) {
    // Detect OS to use the correct path
    const isWindows = Deno.build.os === "windows";
    return isWindows 
      ? `${fsConfig.venvPath}\\Scripts\\python.exe`
      : `${fsConfig.venvPath}/bin/python`;
  }
  
  // Otherwise use system Python
  return "python";
}

// Run Python code using the specified or system Python
async function runPythonCode(pythonCode: string, log: (level: LoggingLevel, data: string) => void): Promise<RunResult> {
  try {
    // Ensure the mount directory exists
    await ensureMountDirectoryExists();
    
    // Process the Python code to replace virtual paths with local paths
    const processedCode = replaceVirtualPaths(pythonCode);
    
    // Create a temporary file to hold the processed Python code
    const tempFilePath = `${fsConfig.localPath}/_temp_${Date.now()}.py`;
    await Deno.writeTextFile(tempFilePath, processedCode);
    
    // Get the Python path (from venv or system)
    const pythonPath = getPythonPath();
    
    // Run the Python code
    log('info', `Running Python code from ${tempFilePath} using Python: ${pythonPath}`);
    
    const command = new Deno.Command(pythonPath, {
      args: [tempFilePath],
      stdout: "piped",
      stderr: "piped",
      cwd: fsConfig.localPath
    });
    
    const result = await command.output();
    
    const textDecoder = new TextDecoder();
    const output = textDecoder.decode(result.stdout).split('\n');
    const error = textDecoder.decode(result.stderr);
    
    // Clean up the temporary file
    try {
      await Deno.remove(tempFilePath);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log('warning', `Failed to clean up temporary file: ${errorMessage}`);
    }
    
    // Return the result
    if (result.code === 0) {
      return {
        status: 'success',
        output: output,
        error: error ? error : null
      };
    } else {
      return {
        status: 'error',
        output: output,
        error: error || `Process exited with code ${result.code}`
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      status: 'error',
      error: errorMessage,
      output: []
    };
  }
}

// Run a Python file using the specified or system Python
async function runPythonFile(filePath: string, log: (level: LoggingLevel, data: string) => void): Promise<RunResult> {
  try {
    // Convert virtual path to local path
    const localFilePath = virtualToLocalPath(filePath);
    
    // Ensure the file exists
    try {
      await Deno.stat(localFilePath);
    } catch (error) {
      throw new Error(`File ${filePath} does not exist`);
    }
    
    // Get the Python path (from venv or system)
    const pythonPath = getPythonPath();
    
    // Run the Python file
    log('info', `Running Python file: ${localFilePath} using Python: ${pythonPath}`);
    
    const command = new Deno.Command(pythonPath, {
      args: [localFilePath],
      stdout: "piped",
      stderr: "piped",
      cwd: fsConfig.localPath
    });
    
    const result = await command.output();
    
    const textDecoder = new TextDecoder();
    const output = textDecoder.decode(result.stdout).split('\n');
    const error = textDecoder.decode(result.stderr);
    
    // Return the result
    if (result.code === 0) {
      return {
        status: 'success',
        output: output,
        error: error ? error : null
      };
    } else {
      return {
        status: 'error',
        output: output,
        error: error || `Process exited with code ${result.code}`
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      status: 'error',
      error: errorMessage,
      output: []
    };
  }
}

// Format result as XML
function asXml(result: RunResult): string {
  const xml = [`<status>${result.status}</status>`];
  
  if (result.output?.length) {
    xml.push('<output>');
    const escapeXml = escapeClosing('output');
    xml.push(...result.output.map(escapeXml));
    xml.push('</output>');
  }
  
  if (result.error) {
    xml.push('<error>');
    xml.push(escapeClosing('error')(result.error));
    xml.push('</error>');
  }
  
  return xml.join('\n');
}

function escapeClosing(closingTag: string): (str: string) => string {
  const regex = new RegExp(`</?\\s*${closingTag}(?:.*?>)?`, 'gi');
  const onMatch = (match: string) => {
    return match.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  return (str) => str.replace(regex, onMatch);
}

// Create the MCP server
function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'MCP Run Python Local',
      version: VERSION,
    },
    {
      instructions: 'Call "run_python_code" to run Python code directly on the local machine, or "run_python_file" to run a Python file. Files can be read/written at the virtual mount point (e.g., /working/). The code will be executed using the specified virtual environment or system Python.',
      capabilities: {
        logging: {},
      },
    },
  );

  const toolDescription = `Tool to execute Python code directly on the local machine.
  
The code will be executed using the specified virtual environment or system Python.`;

  const fileToolDescription = `Tool to execute a Python file on the local machine.
  
The file will be executed using the specified virtual environment or system Python.`;

  let setLogLevel: LoggingLevel = 'emergency';

  server.server.setRequestHandler(SetLevelRequestSchema, (request) => {
    setLogLevel = request.params.level;
    return {};
  });

  // Run Python code tool
  server.tool(
    'run_python_code',
    toolDescription,
    { python_code: z.string().describe('Python code to run') },
    async ({ python_code }: { python_code: string }) => {
      const logPromises: Promise<void>[] = [];
      const logger = (level: LoggingLevel, data: string) => {
        if (LogLevels.indexOf(level) >= LogLevels.indexOf(setLogLevel)) {
          logPromises.push(server.server.sendLoggingMessage({ level, data }));
        }
      };
      
      const result = await runPythonCode(python_code, logger);
      await Promise.all(logPromises);
      
      return {
        content: [{ type: 'text', text: asXml(result) }],
      };
    },
  );
  
  // Run Python file tool
  server.tool(
    'run_python_file',
    fileToolDescription,
    { file_path: z.string().describe('Path to the Python file to run') },
    async ({ file_path }: { file_path: string }) => {
      const logPromises: Promise<void>[] = [];
      const logger = (level: LoggingLevel, data: string) => {
        if (LogLevels.indexOf(level) >= LogLevels.indexOf(setLogLevel)) {
          logPromises.push(server.server.sendLoggingMessage({ level, data }));
        }
      };
      
      const result = await runPythonFile(file_path, logger);
      await Promise.all(logPromises);
      
      return {
        content: [{ type: 'text', text: asXml(result) }],
      };
    },
  );
  
  return server;
}

// Run the MCP server with SSE transport
function runSse(port: number) {
  const mcpServer = createServer();
  const transports: { [sessionId: string]: SSEServerTransport } = {};

  // Create HTTP server using Deno.serve
  Deno.serve({ port }, (request) => {
    const url = new URL(request.url);
    const { pathname } = url;
    
    if (pathname === '/sse' && request.method === 'GET') {
      // Create a response handler for SSE
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      
      const headers = new Headers({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      
      const response = {
        flushHeaders: () => {},
        on: (_event: string, _callback: () => void) => {},
        write: (data: string) => {
          writer.write(new TextEncoder().encode(data));
          return true;
        },
        end: () => {
          writer.close();
        }
      };
      
      const transport = new SSEServerTransport('/messages', response as any);
      transports[transport.sessionId] = transport;
      
      // Remove transport on connection close
      request.signal.addEventListener('abort', () => {
        delete transports[transport.sessionId];
      });
      
      mcpServer.connect(transport);
      
      return new Response(readable, {
        headers
      });
    } else if (pathname === '/messages' && request.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const transport = transports[sessionId];
      
      if (transport) {
        // Handle message - this is a simplified version
        return new Response('Message received', { status: 200 });
      } else {
        return new Response(`No transport found for sessionId '${sessionId}'`, { status: 400 });
      }
    } else {
      return new Response(pathname === '/' ? 'MCP Run Python Local Server' : 'Not Found', { 
        status: pathname === '/' ? 200 : 404
      });
    }
  });
  
  console.log(`Running MCP Run Python Local version ${VERSION} with SSE transport on port ${port}`);
}

// Run the MCP server with Stdio transport
async function runStdio() {
  const mcpServer = createServer();
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

// Define the RunResult interface
interface RunResult {
  status: 'success' | 'error';
  output: string[];
  error: string | null;
}

// List of log levels to use for level comparison
const LogLevels: LoggingLevel[] = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
];

function printUsage() {
  console.error(
    `\
Invalid arguments.

Usage: deno run -A jsr:@changhc/mcp-run-python-local [stdio|sse|warmup] [options]

options:
  --port <port>   Port to run the SSE server on (default: 3001)
  --mount <path>  Virtual path for the mount point (default: /working)
  --path <path>   Local path to map from the mount point (default: ${Deno.makeTempDirSync({ prefix: 'mcp-python-local-' })})
  --venv <path>   Path to an existing Python virtual environment to use (default: uses system Python)`,
  );
}

// Run a simple warmup test
async function warmup() {
  console.error(
    `Running warmup script for MCP Run Python Local version ${VERSION}...`,
  );
  
  const code = `
import sys
print(f"Python version: {sys.version}")
print("Warmup test successful!")
`;
  
  const logger = (level: LoggingLevel, data: string) => {
    console.log(`${level}: ${data}`);
  };
  
  try {
    await ensureMountDirectoryExists();
    const result = await runPythonCode(code, logger);
    console.log('Tool return value:');
    console.log(asXml(result));
    console.log('\nWarmup successful 🎉');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Warmup failed:', errorMessage);
    Deno.exit(1);
  }
}

// Process command-line arguments and run the server
export async function main() {
  const { args } = Deno;
  
  if (args.length >= 1) {
    const flags = parseArgs(Deno.args, {
      string: ['port', 'mount', 'path', 'venv'],
      default: { 
        port: '3001',
        mount: defaultConfig.mountPoint,
        path: defaultConfig.localPath,
        venv: null  // Default to null (will use system Python)
      },
    });
    
    // Set up file system config
    fsConfig = {
      mountPoint: flags.mount,
      localPath: flags.path,
      venvPath: flags.venv
    };
    
    if (args[0] === 'stdio') {
      await runStdio();
    } else if (args[0] === 'sse') {
      const port = parseInt(flags.port);
      runSse(port);
    } else if (args[0] === 'warmup') {
      await warmup();
    } else {
      printUsage();
      Deno.exit(1);
    }
  } else {
    printUsage();
    Deno.exit(1);
  }
}

// Entry point when running directly
if (import.meta.main) {
  await main().catch(error => {
    console.error('Error running server:', error);
    Deno.exit(1);
  });
}