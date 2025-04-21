import { parseArgs } from '@std/cli/parse-args';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type LoggingLevel, SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const VERSION = '0.0.93';

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

// Replace virtual paths in code with local paths
function replaceVirtualPaths(code: string): string {
  // Replace all occurrences of the mount point with the local path
  return code.replace(
    new RegExp(fsConfig.mountPoint, 'g'), 
    fsConfig.localPath
  );
}

// Create a virtual environment
async function createVirtualEnv(envPath: string, log: (level: LoggingLevel, data: string) => void): Promise<boolean> {
  try {
    log('info', `Creating Python virtual environment at: ${envPath}`);
    
    const command = new Deno.Command("python", {
      args: ["-m", "venv", envPath],
      stdout: "piped",
      stderr: "piped",
    });
    
    const { code, stdout, stderr } = await command.output();
    
    const textDecoder = new TextDecoder();
    const stdoutText = textDecoder.decode(stdout);
    const stderrText = textDecoder.decode(stderr);
    
    if (stdoutText) log('info', stdoutText);
    if (stderrText) log('warning', stderrText);
    
    if (code === 0) {
      log('info', `Successfully created virtual environment at: ${envPath}`);
      return true;
    } else {
      log('error', `Failed to create virtual environment, exit code: ${code}`);
      return false;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log('error', `Error creating virtual environment: ${errorMessage}`);
    return false;
  }
}

// Get the Python executable path from the virtual environment
function getVenvPythonPath(envPath: string): string {
  // Detect OS to use the correct path
  const isWindows = Deno.build.os === "windows";
  return isWindows 
    ? `${envPath}\\Scripts\\python.exe`
    : `${envPath}/bin/python`;
}

// Get the pip executable path from the virtual environment
function getVenvPipPath(envPath: string): string {
  // Detect OS to use the correct path
  const isWindows = Deno.build.os === "windows";
  return isWindows 
    ? `${envPath}\\Scripts\\pip.exe`
    : `${envPath}/bin/pip`;
}

// Install a package in the virtual environment
async function installPackageInVenv(packageName: string, venvPath: string, log: (level: LoggingLevel, data: string) => void): Promise<boolean> {
  try {
    const pipPath = getVenvPipPath(venvPath);
    log('info', `Installing package ${packageName} in virtual environment using ${pipPath}`);
    
    const command = new Deno.Command(pipPath, {
      args: ["install", packageName],
      stdout: "piped",
      stderr: "piped",
    });
    
    const { code, stdout, stderr } = await command.output();
    
    const textDecoder = new TextDecoder();
    const stdoutText = textDecoder.decode(stdout);
    const stderrText = textDecoder.decode(stderr);
    
    if (stdoutText) log('info', stdoutText);
    if (stderrText) log('warning', stderrText);
    
    if (code === 0) {
      log('info', `Successfully installed package: ${packageName}`);
      return true;
    } else {
      log('error', `Failed to install package ${packageName}, exit code: ${code}`);
      return false;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log('error', `Error installing package ${packageName}: ${errorMessage}`);
    return false;
  }
}

// Clean up the virtual environment directory
async function cleanupVirtualEnv(envPath: string, log: (level: LoggingLevel, data: string) => void): Promise<void> {
  try {
    log('info', `Cleaning up virtual environment at: ${envPath}`);
    await Deno.remove(envPath, { recursive: true });
    log('info', `Successfully removed virtual environment`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log('warning', `Failed to clean up virtual environment: ${errorMessage}`);
  }
}

// Extract missing module name from Python error
function extractMissingModule(errorText: string): string | null {
  const moduleErrorRegex = /ModuleNotFoundError: No module named ['"]([^'"]+)['"]/;
  const match = errorText.match(moduleErrorRegex);
  
  if (match && match[1]) {
    return match[1];
  }
  
  return null;
}

// Run Python code with auto-installation of dependencies in a virtual environment
async function runPythonWithAutoInstall(
  pythonCode: string, 
  tempFilePath: string, 
  cwd: string,
  log: (level: LoggingLevel, data: string) => void,
  maxRetries = 5
): Promise<RunResult> {
  // Create a unique virtual environment for this run
  const venvPath = `${cwd}/_venv_${Date.now()}`;
  let venvCreated = false;
  const installedPackages = new Set<string>();
  
  try {
    // Create virtual environment
    venvCreated = await createVirtualEnv(venvPath, log);
    if (!venvCreated) {
      return {
        status: 'error',
        dependencies: Array.from(installedPackages),
        output: [],
        error: 'Failed to create Python virtual environment'
      };
    }
    
    // Get Python path from the virtual environment
    const pythonPath = getVenvPythonPath(venvPath);
    let attemptCount = 0;
    let currentCode = 0;
    let currentOutput: string[] = [];
    let currentError = '';
    
    // Loop for handling missing dependencies
    while (attemptCount < maxRetries) {
      attemptCount++;
      
      // Run the Python code with the virtual environment
      log('info', `Attempt ${attemptCount}: Running Python code with virtual environment Python: ${pythonPath}`);
      const command = new Deno.Command(pythonPath, {
        args: [tempFilePath],
        stdout: "piped",
        stderr: "piped",
        cwd: cwd
      });
      
      const result = await command.output();
      
      const textDecoder = new TextDecoder();
      currentOutput = textDecoder.decode(result.stdout).split('\n');
      currentError = textDecoder.decode(result.stderr);
      currentCode = result.code;
      
      if (currentCode === 0) {
        // Success! Return the result
        return {
          status: 'success',
          dependencies: Array.from(installedPackages),
          output: currentOutput,
          error: currentError ? currentError : null
        };
      } else {
        // Check if it's a missing module error
        const missingModule = extractMissingModule(currentError);
        
        if (missingModule && !installedPackages.has(missingModule)) {
          log('info', `Detected missing module: ${missingModule}`);
          
          // Attempt to install the missing package in the virtual environment
          const success = await installPackageInVenv(missingModule, venvPath, log);
          
          if (success) {
            installedPackages.add(missingModule);
            log('info', `Successfully installed ${missingModule}, continuing to next attempt`);
            // Continue to the next iteration of the while loop
            continue;
          } else {
            log('error', `Failed to install dependency: ${missingModule}`);
            break; // Exit the loop if we can't install the dependency
          }
        } else {
          // Not a missing module error or we've already tried to install this module
          log('info', `Error is not a missing module or module already installed`);
          break;
        }
      }
    }
    
    // If we get here, we've either exhausted our retries or hit a non-dependency error
    return {
      status: 'error',
      dependencies: Array.from(installedPackages),
      output: currentOutput,
      error: currentError || `Process exited with code ${currentCode}`
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      status: 'error',
      dependencies: Array.from(installedPackages),
      output: [],
      error: errorMessage
    };
  } finally {
    // Clean up the virtual environment regardless of success or failure
    if (venvCreated) {
      await cleanupVirtualEnv(venvPath, log);
    }
  }
}

// Run Python code in a virtual environment
async function runPythonCode(pythonCode: string, log: (level: LoggingLevel, data: string) => void): Promise<RunResult> {
  try {
    // Ensure the mount directory exists
    await ensureMountDirectoryExists();
    
    // Process the Python code to replace virtual paths with local paths
    const processedCode = replaceVirtualPaths(pythonCode);
    
    // Create a temporary file to hold the processed Python code
    const tempFilePath = `${fsConfig.localPath}/_temp_${Date.now()}.py`;
    await Deno.writeTextFile(tempFilePath, processedCode);
    
    // Run the code in a virtual environment with auto-installation of any missing dependencies
    log('info', `Running Python code from ${tempFilePath} in a virtual environment`);
    const result = await runPythonWithAutoInstall(
      processedCode, 
      tempFilePath, 
      fsConfig.localPath, 
      log
    );
    
    // Clean up the temporary file
    try {
      await Deno.remove(tempFilePath);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log('warning', `Failed to clean up temporary file: ${errorMessage}`);
    }
    
    return result;
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

// Run a Python file in a virtual environment
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
    
    // Read the file content
    const pythonCode = await Deno.readTextFile(localFilePath);
    
    // Run the Python file in a virtual environment with auto-installation of any missing dependencies
    log('info', `Running Python file: ${localFilePath} in a virtual environment`);
    
    return await runPythonWithAutoInstall(
      pythonCode, 
      localFilePath, 
      fsConfig.localPath, 
      log
    );
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
      instructions: 'Call "run_python_code" to run Python code directly on the local machine, or "run_python_file" to run a Python file. Files can be read/written at the virtual mount point (e.g., /working/). Missing dependencies will be automatically detected and installed using isolated virtual environments.',
      capabilities: {
        logging: {},
      },
    },
  );

  const toolDescription = `Tool to execute Python code directly on the local machine.
  
The code will be executed in an isolated Python virtual environment.
Missing dependencies will be automatically detected and installed.`;

  const fileToolDescription = `Tool to execute a Python file on the local machine.
  
The file will be executed in an isolated Python virtual environment.
Missing dependencies will be automatically detected and installed.`;

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

Usage: deno run -A jsr:@changhc/mcp-run-python-local [stdio|sse|warmup] [options]

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