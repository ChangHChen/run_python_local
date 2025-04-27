import { parseArgs } from '@std/cli/parse-args';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type LoggingLevel, SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const VERSION = '0.1.5';

/** ───────────────────────────────────────────────────────────────────
 * Build a tiny Python import‑hook that rewrites every imported module’s
 * source code, converting virtual paths (e.g. /workspace/data) to the
 * local ones (e.g. /data) before the code is compiled.
 * ─────────────────────────────────────────────────────────────────── */
function buildImportPatcher(mounts: FileSystemConfig['mounts']): string {
  // sort so more‑specific mount points are tried first
  const sorted = [...mounts].sort((a, b) => b.mountPoint.length - a.mountPoint.length)
  const rewrites = JSON.stringify(sorted.map(m => [m.mountPoint, m.localPath] as const))

  return `
import importlib.machinery, importlib.util, sys, re

_REWRITES = ${rewrites}

class _MountLoader(importlib.machinery.SourceFileLoader):
    def get_data(self, path):
        src = super().get_data(path).decode()
        for v, l in _REWRITES:
            src = re.sub(fr"{re.escape(v)}(?=/|$)", l, src)
        return src.encode()

class _MountFinder(importlib.machinery.PathFinder):
    @classmethod
    def find_spec(cls, fullname, path=None, target=None):
        spec = super().find_spec(fullname, path, target)
        if spec and isinstance(spec.loader, importlib.machinery.SourceFileLoader):
            spec.loader = _MountLoader(spec.loader.name, spec.loader.path)
        return spec

sys.meta_path.insert(0, _MountFinder)
`;}

// ───────────────────────────────────────────────────────────────────

function replaceLocalPaths(output: string): string {
  const sortedMounts = [...fsConfig.mounts].sort((a, b) => b.localPath.length - a.localPath.length);
  let result = output;
  for (const mount of sortedMounts) {
    result = result.replace(new RegExp(mount.localPath, 'g'), mount.mountPoint);
  }
  return result;
}

interface FileSystemConfig {
  mounts: Array<{ mountPoint: string; localPath: string }>;
  venvPath: string | null;
}

const defaultConfig: FileSystemConfig = {
  mounts: [
    {
      mountPoint: '/working_space',
      localPath: Deno.makeTempDirSync({ prefix: 'mcp-python-local-' }),
    },
  ],
  venvPath: null,
};

let fsConfig: FileSystemConfig = defaultConfig;
let importPatcher = '';

function parseMountArgs(mountArgs: string[]): Array<{ localPath: string; mountPoint: string }> {
  return mountArgs.map((mountArg) => {
    const parts = mountArg.split(':');
    if (parts.length !== 2) throw new Error('Invalid mount format. Expected localPath:mountPoint');
    const [localPath, mountPoint] = parts;
    if (!localPath || !mountPoint) throw new Error('Both local path and mount point must be specified');
    return { localPath, mountPoint };
  });
}

async function ensureMountDirectoryExists(localPath: string) {
  try {
    await Deno.mkdir(localPath, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
}

async function ensureAllMountDirectoriesExist() {
  for (const mount of fsConfig.mounts) await ensureMountDirectoryExists(mount.localPath);
}

function virtualToLocalPath(virtualPath: string): string {
  const sortedMounts = [...fsConfig.mounts].sort((a, b) => b.mountPoint.length - a.mountPoint.length);
  for (const mount of sortedMounts) {
    if (virtualPath === mount.mountPoint) return mount.localPath;
    if (virtualPath.startsWith(mount.mountPoint + '/')) {
      const relativePath = virtualPath.substring(mount.mountPoint.length);
      return `${mount.localPath}${relativePath}`;
    }
  }
  throw new Error(`Path ${virtualPath} is outside all mount points`);
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceVirtualPaths(code: string): string {
  const sortedMounts = [...fsConfig.mounts].sort((a, b) => b.mountPoint.length - a.mountPoint.length);
  let result = code;
  for (const mount of sortedMounts) {
    const mountRegex = new RegExp(`${escapeRegExp(mount.mountPoint)}(?=/|$)`, 'g');
    result = result.replace(mountRegex, mount.localPath);
  }
  return result;
}

function getPythonPath(): string {
  if (fsConfig.venvPath) {
    const isWindows = Deno.build.os === 'windows';
    return isWindows ? `${fsConfig.venvPath}\\Scripts\\python.exe` : `${fsConfig.venvPath}/bin/python`;
  }
  return 'python';
}

async function runPythonCode(pythonCode: string, log: (level: LoggingLevel, data: string) => void): Promise<RunResult> {
  try {
    await ensureAllMountDirectoriesExist();

    const processedCode = importPatcher + '\n' + replaceVirtualPaths(pythonCode);
    const tempFilePath = `${fsConfig.mounts[0].localPath}/_temp_${Date.now()}.py`;
    await Deno.writeTextFile(tempFilePath, processedCode);

    const pythonPath = getPythonPath();
    log('info', `Running Python code from ${tempFilePath} using Python: ${pythonPath}`);

    const command = new Deno.Command(pythonPath, {
      args: [tempFilePath],
      stdout: 'piped',
      stderr: 'piped',
      cwd: fsConfig.mounts[0].localPath,
    });

    const result = await command.output();
    const textDecoder = new TextDecoder();
    const output = textDecoder.decode(result.stdout).split('\n');
    const error = textDecoder.decode(result.stderr);

    try { await Deno.remove(tempFilePath); } catch (_) {}

    if (result.code === 0) {
      return { status: 'success', output: output.map(replaceLocalPaths), error: error ? replaceLocalPaths(error) : null };
    } else {
      return { status: 'error', output: output.map(replaceLocalPaths), error: replaceLocalPaths(error) || `Process exited with code ${result.code}` };
    }
  } catch (error) {
    return { status: 'error', output: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function runPythonFile(filePath: string, log: (level: LoggingLevel, data: string) => void): Promise<RunResult> {
  try {
    const localFilePath = virtualToLocalPath(filePath);
    await ensureAllMountDirectoriesExist();
    await Deno.stat(localFilePath);
    const fileContent = await Deno.readTextFile(localFilePath);

    const processedCode = importPatcher + '\n' + replaceVirtualPaths(fileContent);
    const tempFilePath = `${fsConfig.mounts[0].localPath}/_temp_${Date.now()}.py`;
    await Deno.writeTextFile(tempFilePath, processedCode);

    const pythonPath = getPythonPath();
    log('info', `Running Python file: ${filePath} via ${pythonPath}`);

    const command = new Deno.Command(pythonPath, {
      args: [tempFilePath],
      stdout: 'piped',
      stderr: 'piped',
      cwd: fsConfig.mounts[0].localPath,
    });

    const result = await command.output();
    const textDecoder = new TextDecoder();
    const output = textDecoder.decode(result.stdout).split('\n');
    const error = textDecoder.decode(result.stderr);

    try { await Deno.remove(tempFilePath); } catch (_) {}

    if (result.code === 0) {
      return { status: 'success', output: output.map(replaceLocalPaths), error: error ? replaceLocalPaths(error) : null };
    } else {
      return { status: 'error', output: output.map(replaceLocalPaths), error: replaceLocalPaths(error) || `Process exited with code ${result.code}` };
    }
  } catch (error) {
    return { status: 'error', output: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function asXml(result: RunResult): string {
  const xml = [`<status>${result.status}</status>`];
  if (result.output?.length) {
    xml.push('<output>');
    const escapeXml = (str: string) => str.replace(/<\/output>/g, '&lt;/output&gt;');
    xml.push(...result.output.map(escapeXml));
    xml.push('</output>');
  }
  if (result.error) {
    xml.push('<error>');
    xml.push(result.error.replace(/<\/error>/g, '&lt;/error&gt;'));
    xml.push('</error>');
  }
  return xml.join('\n');
}

function createServer(): McpServer {
  const server = new McpServer({ name: 'MCP Run Python Local', version: VERSION }, { instructions: 'Call "run_python_code" or "run_python_file".', capabilities: { logging: {} } });
  const toolDescription = 'Execute Python code.';
  const fileToolDescription = 'Execute a Python file.';
  let setLogLevel: LoggingLevel = 'emergency';

  server.server.setRequestHandler(SetLevelRequestSchema, (request) => {
    setLogLevel = request.params.level;
    return {};
  });

  const LogLevels: LoggingLevel[] = ['debug','info','notice','warning','error','critical','alert','emergency'];

  server.tool('run_python_code', toolDescription, { python_code: z.string() }, async ({ python_code }) => {
    const logPromises: Promise<void>[] = [];
    const logger = (lvl: LoggingLevel, data: string) => { if (LogLevels.indexOf(lvl) >= LogLevels.indexOf(setLogLevel)) logPromises.push(server.server.sendLoggingMessage({ level: lvl, data })); };
    const result = await runPythonCode(python_code, logger);
    await Promise.all(logPromises);
    return { content: [{ type: 'text', text: asXml(result) }] };
  });

  server.tool('run_python_file', fileToolDescription, { file_path: z.string() }, async ({ file_path }) => {
    const logPromises: Promise<void>[] = [];
    const logger = (lvl: LoggingLevel, data: string) => { if (LogLevels.indexOf(lvl) >= LogLevels.indexOf(setLogLevel)) logPromises.push(server.server.sendLoggingMessage({ level: lvl, data })); };
    const result = await runPythonFile(file_path, logger);
    await Promise.all(logPromises);
    return { content: [{ type: 'text', text: asXml(result) }] };
  });

  server.tool('install_python_package', 'Install Python packages using pip.', { package_name: z.string() }, async ({ package_name }) => {
    const pythonPath = getPythonPath();
    const command = new Deno.Command(pythonPath, { args: ['-m','pip','install', package_name], stdout: 'piped', stderr: 'piped' });
    const result = await command.output();
    const textDecoder = new TextDecoder();
    const output = textDecoder.decode(result.stdout).split('\n');
    const error = textDecoder.decode(result.stderr);
    const status: RunResult = result.code === 0 ? { status:'success', output, error: null } : { status:'error', output, error: error || `Exit code ${result.code}` };
    return { content:[{type:'text', text: asXml(status) }] };
  });
  return server;
}

function runSse(port: number) {
  const mcpServer = createServer();
  const transports: Record<string, SSEServerTransport> = {};
  Deno.serve({ port }, (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/sse' && request.method === 'GET') {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const response = { flushHeaders() {}, on() {}, write: (d: string) => { writer.write(new TextEncoder().encode(d)); return true; }, end: () => writer.close() } as any;
      const transport = new SSEServerTransport('/messages', response);
      transports[transport.sessionId] = transport;
      request.signal.addEventListener('abort', () => { delete transports[transport.sessionId]; });
      mcpServer.connect(transport);
      return new Response(readable, { headers: { 'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive' } });
    }
    if (url.pathname === '/messages' && request.method === 'POST') {
      const sid = url.searchParams.get('sessionId') ?? ''; const t = transports[sid];
      return new Response(t ? 'Message received' : 'No transport for sessionId', { status: t ? 200 : 400 });
    }
    return new Response(url.pathname === '/' ? 'MCP Run Python Local Server' : 'Not Found', { status: url.pathname === '/' ? 200 : 404 });
  });
  console.log(`MCP Run Python Local ${VERSION} SSE listening on :${port}`);
}

async function runStdio() { await createServer().connect(new StdioServerTransport()); }

interface RunResult { status: 'success' | 'error'; output: string[]; error: string | null }

function printUsage() {
  console.error(`Usage: deno run -A jsr:@changhc/mcp-run-python-local [stdio|sse|warmup] [options]\n --port <port>\n --mount <local:virtual> (multiple)\n --venv <path>`);
}

async function warmup() {
  const code = 'import sys; print("Python", sys.version)';
  const logger = (lvl: LoggingLevel, data: string) => console.log(`${lvl}: ${data}`);
  const result = await runPythonCode(code, logger);
  console.log(asXml(result));
}

export async function main() {
  if (Deno.args.length < 1) { printUsage(); Deno.exit(1); }
  const flags = parseArgs(Deno.args.slice(1), { string:['port','venv'], collect:['mount'], default:{ port:'3001', mount:[`${defaultConfig.mounts[0].localPath}:${defaultConfig.mounts[0].mountPoint}`], venv:null } });
  try {
    fsConfig = { mounts: parseMountArgs(flags.mount as string[]), venvPath: flags.venv };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(message);
    printUsage();
    Deno.exit(1);
  }

  importPatcher = buildImportPatcher(fsConfig.mounts); // << build once with final config

  const mode = Deno.args[0];
  if (mode === 'stdio') await runStdio();
  else if (mode === 'sse') runSse(parseInt(flags.port));
  else if (mode === 'warmup') await warmup();
  else { printUsage(); Deno.exit(1); }
}

if (import.meta.main) await main().catch((e) => { console.error(e); Deno.exit(1); });
