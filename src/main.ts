// File: src/main.ts
/// <reference types="node" />

import './polyfill.ts'
import http from 'node:http';
import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { promisify } from 'node:util';
import { parseArgs } from '@std/cli/parse-args';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type LoggingLevel, SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const VERSION = '0.0.1';
const execPromise = promisify(exec);
const writeFilePromise = promisify(fs.writeFile);
const readFilePromise = promisify(fs.readFile);
const mkdirPromise = promisify(fs.mkdir);

// Configuration for the virtual file system mapping
interface FileSystemConfig {
  mountPoint: string;  // Virtual path (e.g., /working)
  localPath: string;   // Real path on the machine (e.g., /home/user/project/temp)
}

// Default to a temp directory if no configuration is provided
const defaultConfig: FileSystemConfig = {
  mountPoint: '/working',
  localPath: path.join(os.tmpdir(), 'mcp-python-local')
};

let fsConfig: FileSystemConfig = defaultConfig;

// Create the mount directory if it doesn't exist
async function ensureMountDirectoryExists() {
  try {
    await mkdirPromise(fsConfig.localPath, { recursive: true });
    console.log(`Created directory: ${fsConfig.localPath}`);
  } catch (error) {
    console.error(`Failed to create directory: ${fsConfig.localPath}`, error);
    throw error;
  }
}

// Convert a virtual path to a local filesystem path
function virtualToLocalPath(virtualPath: string): string {
  if (!virtualPath.startsWith(fsConfig.mountPoint)) {
    throw new Error(`Path ${virtualPath} is outside the mount point ${fsConfig.mountPoint}`);
  }
  
  const relativePath = virtualPath.substring(fsConfig.mountPoint.length);
  return path.join(fsConfig.localPath, relativePath);
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
          const cmd = `pip install ${dependencies.join(' ')}`;
          log('info', `Running: ${cmd}`);
          const { stdout, stderr } = await execPromise(cmd);
          log('info', stdout);
          if (stderr) log('warning', stderr);
          return dependencies;
        } catch (error) {
          log('error', `Failed to install dependencies: ${error.message}`);
          throw error;
        }
      }
    } catch (error) {
      log('error', `Failed to parse dependencies: ${error.message}`);
      throw error;
    }
  }
  
  // If no PEP 723 dependencies, we could implement import detection here
  // but that's more complex and may require actually parsing Python code
  
  return [];
}

// Run Python code
async function runPythonCode(pythonCode: string, log: (level: LoggingLevel, data: string) => void): Promise<RunResult> {
  try {
    // Ensure the mount directory exists
    await ensureMountDirectoryExists();
    
    // Create a temporary file to hold the Python code
    const tempFilePath = path.join(fsConfig.localPath, `_temp_${Date.now()}.py`);
    await writeFilePromise(tempFilePath, pythonCode);
    
    // Detect and install dependencies
    const dependencies = await detectAndInstallDependencies(pythonCode, log);
    
    // Run the Python code
    log('info', `Running Python code from ${tempFilePath}`);
    const { stdout, stderr } = await execPromise(`python ${tempFilePath}`);
    
    // Clean up the temporary file
    fs.unlink(tempFilePath, (err) => {
      if (err) log('warning', `Failed to clean up temporary file: ${err.message}`);
    });
    
    return {
      status: 'success',
      dependencies,
      output: stdout.split('\n'),
      error: stderr ? stderr : null
    };
  } catch (error) {
    return {
      status: 'error',
      error: error.message,
      output: error.stdout ? error.stdout.split('\n') : [],
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
    if (!fs.existsSync(localFilePath)) {
      throw new Error(`File ${filePath} does not exist`);
    }
    
    // Read the file content to detect dependencies
    const pythonCode = await readFilePromise(localFilePath, 'utf-8');
    
    // Detect and install dependencies
    const dependencies = await detectAndInstallDependencies(pythonCode, log);
    
    // Run the Python file
    log('info', `Running Python file: ${localFilePath}`);
    const { stdout, stderr } = await execPromise(`python ${localFilePath}`);
    
    return {
      status: 'success',
      dependencies,
      output: stdout.split('\n'),
      error: stderr ? stderr : null
    };
  } catch (error) {
    return {
      status: 'error',
      error: error.message,
      output: error.stdout ? error.stdout.split('\n') : [],
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(
      req.url ?? '',
      `http://${req.headers.host ?? 'unknown'}`,
    );
    
    let pathMatch = false;
    function match(method: string, path: string): boolean {
      if (url.pathname === path) {
        pathMatch = true;
        return req.method === method;
      }
      return false;
    }
    
    function textResponse(status: number, text: string) {
      res.setHeader('Content-Type', 'text/plain');
      res.statusCode = status;
      res.end(`${text}\n`);
    }

    if (match('GET', '/sse')) {
      const transport = new SSEServerTransport('/messages', res);
      transports[transport.sessionId] = transport;
      res.on('close', () => {
        delete transports[transport.sessionId];
      });
      await mcpServer.connect(transport);
    } else if (match('POST', '/messages')) {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const transport = transports[sessionId];
      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        textResponse(400, `No transport found for sessionId '${sessionId}'`);
      }
    } else if (pathMatch) {
      textResponse(405, 'Method not allowed');
    } else {
      textResponse(404, 'Page not found');
    }
  });

  server.listen(port, () => {
    console.log(
      `Running MCP Run Python Local version ${VERSION} with SSE transport on port ${port}`,
    );
  });
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

function printUsage() {
  console.error(
    `\
Invalid arguments.

Usage: deno run -A jsr:@custom/mcp-run-python-local [stdio|sse|warmup] [options]

options:
  --port <port>   Port to run the SSE server on (default: 3001)
  --mount <path>  Virtual path for the mount point (default: /working)
  --path <path>   Local path to map from the mount point (default: ${os.tmpdir()}/mcp-python-local)`,
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
    console.error('Warmup failed:', error);
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