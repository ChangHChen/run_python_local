import { parseArgs } from '@std/cli/parse-args';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type LoggingLevel, SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const VERSION = '0.1.3';

function replaceLocalPaths(output: string): string {
  // Sort mount points by specificity (longest local path first)
  const sortedMounts = [...fsConfig.mounts].sort((a, b) => 
    b.localPath.length - a.localPath.length
  );
  
  // Replace all occurrences of local paths with mount points
  let result = output;
  for (const mount of sortedMounts) {
    result = result.replace(
      new RegExp(mount.localPath, 'g'),
      mount.mountPoint
    );
  }
  return result;
}

// Configuration for the virtual file system mapping
interface FileSystemConfig {
  mounts: Array<{
    mountPoint: string;  // Virtual path (e.g., /working_space)
    localPath: string;   // Real path on the machine (e.g., /home/user/project/temp)
  }>;
  venvPath: string | null;  // Path to the existing virtual environment
}

// Default to a temp directory if no configuration is provided
const defaultConfig: FileSystemConfig = {
  mounts: [{
    mountPoint: '/working_space',
    localPath: Deno.makeTempDirSync({ prefix: 'mcp-python-local-' })
  }],
  venvPath: null  // Default to null (will use system Python if not specified)
};

let fsConfig: FileSystemConfig = defaultConfig;

// Parse Docker-style mount argument
function parseMountArgs(mountArgs: string[]): Array<{ localPath: string, mountPoint: string }> {
  return mountArgs.map(mountArg => {
    // Split by colon to get local path and mount point
    const parts = mountArg.split(':');
    
    if (parts.length !== 2) {
      throw new Error('Invalid mount format. Expected format: localPath:mountPoint');
    }
    
    const [localPath, mountPoint] = parts;
    
    // Validate paths
    if (!localPath || !mountPoint) {
      throw new Error('Both local path and mount point must be specified');
    }
    
    return { localPath, mountPoint };
  });
}

// Create the mount directory if it doesn't exist
async function ensureMountDirectoryExists(localPath: string) {
  try {
    await Deno.mkdir(localPath, { recursive: true });
    console.log(`Created directory: ${localPath}`);
  } catch (error) {
    // Ignore error if directory already exists
    if (!(error instanceof Deno.errors.AlreadyExists)) {
      console.error(`Failed to create directory: ${localPath}`, error);
      throw error;
    }
  }
}

// Ensure all mount directories exist
async function ensureAllMountDirectoriesExist() {
  for (const mount of fsConfig.mounts) {
    await ensureMountDirectoryExists(mount.localPath);
  }
}

// Convert a virtual path to a local filesystem path
function virtualToLocalPath(virtualPath: string): string {
  // Sort mount points by specificity (longest mount point first)
  const sortedMounts = [...fsConfig.mounts].sort((a, b) => 
    b.mountPoint.length - a.mountPoint.length
  );
  
  // Check each mount point in order of specificity
  for (const mount of sortedMounts) {
    // Check if the virtual path exactly matches the mount point
    if (virtualPath === mount.mountPoint) {
      return mount.localPath;
    }
    // Check if the virtual path starts with the mount point followed by a path separator
    if (virtualPath.startsWith(mount.mountPoint + '/')) {
      const relativePath = virtualPath.substring(mount.mountPoint.length);
      return `${mount.localPath}${relativePath}`;
    }
  }
  
  throw new Error(`Path ${virtualPath} is outside all mount points: ${fsConfig.mounts.map(m => m.mountPoint).join(', ')}`);
}

// Replace virtual paths in code with local paths
function replaceVirtualPaths(code: string): string {
  // Sort mount points by specificity (longest mount point first)
  const sortedMounts = [...fsConfig.mounts].sort((a, b) => 
    b.mountPoint.length - a.mountPoint.length
  );
  
  // Replace all occurrences of mount points with their local paths
  let result = code;
  for (const mount of sortedMounts) {
    // Create a regex that matches the mount point exactly or followed by a slash
    // This ensures we only match complete path segments
    const mountRegex = new RegExp(`${escapeRegExp(mount.mountPoint)}(?=/|$)`, 'g');
    result = result.replace(mountRegex, mount.localPath);
  }
  return result;
}

// Helper function to escape special characters in strings used in regular expressions
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
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
    // Ensure all mount directories exist
    await ensureAllMountDirectoriesExist();
    
    // Process the Python code to replace virtual paths with local paths
    const processedCode = replaceVirtualPaths(pythonCode);
    
    // Create a temporary file to hold the processed Python code in the main mount point
    const tempFilePath = `${fsConfig.mounts[0].localPath}/_temp_${Date.now()}.py`;
    await Deno.writeTextFile(tempFilePath, processedCode);
    
    // Get the Python path (from venv or system)
    const pythonPath = getPythonPath();
    
    // Run the Python code with CWD set to the main mount point
    log('info', `Running Python code from ${tempFilePath} using Python: ${pythonPath}`);
    
    const command = new Deno.Command(pythonPath, {
      args: [tempFilePath],
      stdout: "piped",
      stderr: "piped",
      cwd: fsConfig.mounts[0].localPath // Use the main mount as cwd
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
        output: output.map(line => replaceLocalPaths(line)),
        error: error ? replaceLocalPaths(error) : null
      };
    } else {
      return {
        status: 'error',
        output: output.map(line => replaceLocalPaths(line)),
        error: replaceLocalPaths(error) || `Process exited with code ${result.code}`
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
    
    // Ensure all mount directories exist
    await ensureAllMountDirectoriesExist();
    
    // Ensure the file exists
    try {
      await Deno.stat(localFilePath);
    } catch (error) {
      throw new Error(`File ${filePath} does not exist`);
    }
    
    // Get the Python path (from venv or system)
    const pythonPath = getPythonPath();
    
    // Run the Python file with CWD set to the main mount point
    log('info', `Running Python file: ${localFilePath} using Python: ${pythonPath}`);
    
    const command = new Deno.Command(pythonPath, {
      args: [localFilePath],
      stdout: "piped",
      stderr: "piped",
      cwd: fsConfig.mounts[0].localPath // Use the main mount as cwd
    });
    
    const result = await command.output();
    
    const textDecoder = new TextDecoder();
    const output = textDecoder.decode(result.stdout).split('\n');
    const error = textDecoder.decode(result.stderr);
    
    // Return the result
    if (result.code === 0) {
      return {
        status: 'success',
        output: output.map(line => replaceLocalPaths(line)),
        error: error ? replaceLocalPaths(error) : null
      };
    } else {
      return {
        status: 'error',
        output: output.map(line => replaceLocalPaths(line)),
        error: replaceLocalPaths(error) || `Process exited with code ${result.code}`
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
      instructions: 'Call "run_python_code" to run Python code, or "run_python_file" to run a Python file.',
      capabilities: {
        logging: {},
      },
    },
  );

  const toolDescription = `Tool to execute Python code.`;

  const fileToolDescription = `Tool to execute a Python file.`;

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
  server.tool(
    'install_python_package',
    'Tool to install Python packages using pip.',
    { 
      package_name: z.string().describe('Python package name to install (use package_name==version format if you need to specify version)')
    },
    async ({ package_name }: { package_name: string }) => {
      const logPromises: Promise<void>[] = [];
      const logger = (level: LoggingLevel, data: string) => {
        if (LogLevels.indexOf(level) >= LogLevels.indexOf(setLogLevel)) {
          logPromises.push(server.server.sendLoggingMessage({ level, data }));
        }
      };
      
      try {
        // Get the Python path (from venv or system)
        const pythonPath = getPythonPath();
        
        // Construct the pip command
        const pipArgs = ['-m', 'pip', 'install', package_name];
        
        logger('info', `Installing Python package: ${package_name}`);
        
        // Run pip command
        const command = new Deno.Command(pythonPath, {
          args: pipArgs,
          stdout: "piped",
          stderr: "piped"
        });
        
        const result = await command.output();
        
        const textDecoder = new TextDecoder();
        const output = textDecoder.decode(result.stdout).split('\n');
        const error = textDecoder.decode(result.stderr);
        
        if (result.code === 0) {
          await Promise.all(logPromises);
          return {
            content: [{ 
              type: 'text', 
              text: asXml({
                status: 'success',
                output: output.map(line => replaceLocalPaths(line)),
                error: null
              }) 
            }],
          };
        } else {
          await Promise.all(logPromises);
          return {
            content: [{ 
              type: 'text', 
              text: asXml({
                status: 'error',
                output: output.map(line => replaceLocalPaths(line)),
                error: replaceLocalPaths(error) || `Process exited with code ${result.code}`
              }) 
            }],
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await Promise.all(logPromises);
        return {
          content: [{ 
            type: 'text', 
            text: asXml({
              status: 'error',
              output: [],
              error: errorMessage
            }) 
          }],
        };
      }
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
  --port <port>      Port to run the SSE server on (default: 3001)
  --mount <path>     Local path and mount point in format localPath:mountPoint (can be specified multiple times)
                     The first mount point is used as the main working directory
                     More specific mount points take precedence over more general ones for path resolution
                     (default: ${defaultConfig.mounts[0].localPath}:${defaultConfig.mounts[0].mountPoint})
  --venv <path>      Path to an existing Python virtual environment to use (default: uses system Python)`,
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
    await ensureAllMountDirectoriesExist();
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
      string: ['port', 'venv'],
      collect: ['mount'], // This will collect all --mount arguments into an array
      default: { 
        port: '3001',
        mount: [`${defaultConfig.mounts[0].localPath}:${defaultConfig.mounts[0].mountPoint}`],
        venv: null  // Default to null (will use system Python)
      },
    });
    
    try {
      // Parse the multiple Docker-style mount formats
      const mounts = parseMountArgs(flags.mount as string[]);
      
      // Set up file system config
      fsConfig = {
        mounts: mounts,
        venvPath: flags.venv
      };
    } catch (error) {
      // Handle the error properly with type checking
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Error parsing mount argument: ${errorMessage}`);
      printUsage();
      Deno.exit(1);
    }
    
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