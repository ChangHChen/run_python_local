// File: src/main.ts

import './polyfill.ts';
import { parseArgs } from '@std/cli/parse-args';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type LoggingLevel, SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const VERSION = '0.0.1';

// Configuration for the virtual file system mapping
interface FileSystemConfig {
  mountPoint: string;  // Virtual path (e.g., /working)
  localPath: string;   // Real path on the machine (e.g., /home/user/project/temp)
}

// Default to a temp directory if no configuration is provided
const defaultConfig: FileSystemConfig = {
  mountPoint: '/working',
  localPath: Deno.makeTempDirSync({ prefix: 'mcp-python-local-' })
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

// Detect and install Python dependencies from code or file
async function detectAndInstallDependencies(pythonCode: string, log: (level: LoggingLevel, data: string) => void): Promise<string[]> {
  // Check for PEP 723 dependencies
  const pep723Regex = /# \/\/\/ script\s(?:#.*\s)*?# dependencies = \[(.*?)\]\s(?:#.*\s)*?# \/\/\//s;
  const match = pythonCode.match(pep723Regex);
  
  if (match && match[1]) {
    const dependenciesStr = match[1].trim();
    // Parse the dependencies
    try {
      // This is a simple parser for basic cases
      const dependencies = dependenciesStr
        .split(',')
        .map(dep => dep.trim().replace(/['"]/g, ''))
        .filter(dep => dep.length > 0);
      
      if (dependencies.length > 0) {
        log('info', `Found PEP 723 dependencies: ${dependencies.join(', ')}`);
        
        try {
          // Install dependencies using pip
          const cmd = ["pip", "install", ...dependencies];
          log('info', `Running: pip install ${dependencies.join(' ')}`);
          
          const command = new Deno.Command("pip", {
            args: ["install", ...dependencies],
            stdout: "piped",
            stderr: "piped",
          });
          
          const { code, stdout, stderr } = await command.output();
          
          const textDecoder = new TextDecoder();
          const stdoutText = textDecoder.decode(stdout);
          const stderrText = textDecoder.decode(stderr);
          
          log('info', stdoutText);
          if (stderrText) log('warning', stderrText);
          
          if (code !== 0) {
            throw new Error(`pip install failed with exit code ${code}`);
          }
          
          return dependencies;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          log('error', `Failed to install dependencies: ${errorMessage}`);
          throw new Error(`Failed to install dependencies: ${errorMessage}`);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log('error', `Failed to parse dependencies: ${errorMessage}`);
      throw new Error(`Failed to parse dependencies: ${errorMessage}`);
    }
  }
  
  // If no PEP 723 dependencies found
  return [];
}

// Run Python code
async function runPythonCode(pythonCode: string, log: (level: LoggingLevel, data: string) => void): Promise<RunResult> {
  try {
    // Ensure the mount directory exists
    await ensureMountDirectoryExists();
    
    // Create a temporary file to hold the Python code
    const tempFilePath = `${fsConfig.localPath}/_temp_${Date.now()}.py`;
    await Deno.writeTextFile(tempFilePath, pythonCode);
    
    // Detect and install dependencies
    const dependencies = await detectAndInstallDependencies(pythonCode, log);
    
    // Run the Python code
    log('info', `Running Python code from ${tempFilePath}`);
    
    const command = new Deno.Command("python", {
      args: [tempFilePath],
      stdout: "piped",
      stderr: "piped",
    });
    
    const { code, stdout, stderr } = await command.output();
    
    const textDecoder = new TextDecoder();
    const stdoutText = textDecoder.decode(stdout).split('\n');
    const stderrText = textDecoder.decode(stderr);
    
    // Clean up the temporary file
    try {
      await Deno.remove(tempFilePath);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log('warning', `Failed to clean up temporary file: ${errorMessage}`);
    }
    
    if (code === 0) {
      return {
        status: 'success',
        dependencies,
        output: stdoutText,
        error: stderrText ? stderrText : null
      };
    } else {
      return {
        status: 'error',
        dependencies,
        output: stdoutText,
        error: stderrText || `Process exited with code ${code}`
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      status: 'error',
      error: errorMessage,
      output: [],
      dependencies: []
    };
  }
}

// Run a Python file
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
    
    // Read the file content to detect dependencies
    const pythonCode = await Deno.readTextFile(localFilePath);
    
    // Detect and install dependencies
    const dependencies = await detectAndInstallDependencies(pythonCode, log);
    
    // Run the Python file
    log('info', `Running Python file: ${localFilePath}`);
    
    const command = new Deno.Command("python", {
      args: [localFilePath],
      stdout: "piped",
      stderr: "piped",
    });
    
    const { code, stdout, stderr } = await command.output();
    
    const textDecoder = new TextDecoder();
    const stdoutText = textDecoder.decode(stdout).split('\n');
    const stderrText = textDecoder.decode(stderr);
    
    if (code === 0) {
      return {
        status: 'success',
        dependencies,
        output: stdoutText,
        error: stderrText ? stderrText : null
      };
    } else {
      return {
        status: 'error',
        dependencies,
        output: stdoutText,
        error: stderrText || `Process exited with code ${code}`
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      status: 'error',
      error: errorMessage,
      output: [],
      dependencies: []
    };
  }
}

// Format result as XML
function asXml(result: RunResult): string {
  const xml = [`<status>${result.status}</status>`];
  
  if (result.dependencies?.length) {
    xml.push(`<dependencies>${JSON.stringify(result.dependencies)}</dependencies>`);
  }
  
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
      instructions: 'Call "run_python_code" to run Python code directly on the local machine, or "run_python_file" to run a Python file. Files can be read/written at the virtual mount point (e.g., /working/).',
      capabilities: {
        logging: {},
      },
    },
  );

  const toolDescription = `Tool to execute Python code directly on the local machine.
  
The code will be executed with the locally installed Python interpreter.

Dependencies may be defined via PEP 723 script metadata, e.g. to install "pydantic", the script should start
with a comment of the form:

# /// script
# dependencies = ['pydantic']
# ///
print('python code here')

Files can be read/written at the virtual mount point: ${fsConfig.mountPoint}
These files will be stored at: ${fsConfig.localPath} on the local machine.`;

  const fileToolDescription = `Tool to execute a Python file on the local machine.
  
The file should be specified with a path starting with the virtual mount point: ${fsConfig.mountPoint}
The file will be executed with the locally installed Python interpreter.

Dependencies may be defined via PEP 723 script metadata.`;

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
  dependencies: string[];
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

Usage: deno run -A jsr:@custom/mcp-run-python-local [stdio|sse|warmup] [options]

options:
  --port <port>   Port to run the SSE server on (default: 3001)
  --mount <path>  Virtual path for the mount point (default: /working)
  --path <path>   Local path to map from the mount point (default: ${Deno.makeTempDirSync({ prefix: 'mcp-python-local-' })})`,
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
      string: ['port', 'mount', 'path'],
      default: { 
        port: '3001',
        mount: defaultConfig.mountPoint,
        path: defaultConfig.localPath
      },
    });
    
    // Set up file system config
    fsConfig = {
      mountPoint: flags.mount,
      localPath: flags.path
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