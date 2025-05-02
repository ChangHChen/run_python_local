import { parseArgs } from '@std/cli/parse-args';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type LoggingLevel, SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = '0.3.1';
const PYTHON = 'python';
const PIP = 'pip';

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

interface RunResult {
  status: 'success' | 'error';
  output: string[];
  error: string | null;
}

function asXml(res: RunResult): string {
  const xml: string[] = [`<status>${res.status}</status>`];
  if (res.output.length) xml.push('<output>', ...res.output, '</output>');
  if (res.error) xml.push('<error>', res.error, '</error>');
  return xml.join('\n');
}

async function runPython(args: string[]): Promise<RunResult> {
  try {
    const proc = new Deno.Command(PYTHON, {
      args,
      stdout: 'piped',
      stderr: 'piped',
    });
    const { code, stdout, stderr } = await proc.output();
    const dec = new TextDecoder();
    const outLines = dec.decode(stdout).split('\n');
    const err = dec.decode(stderr);
    return code === 0
      ? { status: 'success', output: outLines, error: err || null }
      : { status: 'error', output: outLines, error: err || `Exit code ${code}` };
  } catch (e) {
    return { status: 'error', output: [], error: e instanceof Error ? e.message : String(e) };
  }
}

async function runPythonCode(code: string): Promise<RunResult> {
  const tmp = await Deno.makeTempFile({ suffix: '.py' });
  await Deno.writeTextFile(tmp, code);
  const res = await runPython([tmp]);
  await Deno.remove(tmp).catch(() => {});
  return res;
}

async function runPythonFile(path: string): Promise<RunResult> {
  return runPython([path]);
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer(
    { name: 'MCP Run Python Local', version: VERSION },
    { instructions: 'Call "run_python_code" or "run_python_file".', capabilities: { logging: {} } },
  );

  // logging
  const levels: LoggingLevel[] = ['debug','info','notice','warning','error','critical','alert','emergency'];
  let current: LoggingLevel = 'emergency';
  server.server.setRequestHandler(SetLevelRequestSchema, (req) => { current = req.params.level; return {}; });
  const log = (lvl: LoggingLevel, msg: string) => {
    if (levels.indexOf(lvl) >= levels.indexOf(current)) {
      server.server.sendLoggingMessage({ level: lvl, data: msg }).catch(() => {});
    }
  };

  server.tool('run_python_code', 'Execute Python code.', { python_code: z.string() }, async ({ python_code }) => {
    log('debug', 'Running code snippet');
    const res = await runPythonCode(python_code);
    return { content: [{ type: 'text', text: asXml(res) }] };
  });

  server.tool('run_python_file', 'Execute a Python file.', { file_path: z.string() }, async ({ file_path }) => {
    log('debug', `Running file ${file_path}`);
    const res = await runPythonFile(file_path);
    return { content: [{ type: 'text', text: asXml(res) }] };
  });

  server.tool('install_python_package', 'Install a Python package via pip.', { package_name: z.string() }, async ({ package_name }) => {
    const cmd = new Deno.Command(PIP, {
      args: ['install', package_name],
      stdout: 'piped',
      stderr: 'piped',
    });
    const { code, stdout, stderr } = await cmd.output();
    const dec = new TextDecoder();
    const res: RunResult = code === 0
      ? { status: 'success', output: dec.decode(stdout).split('\n'), error: null }
      : { status: 'error', output: dec.decode(stdout).split('\n'), error: dec.decode(stderr) || `Exit code ${code}` };
    return { content: [{ type: 'text', text: asXml(res) }] };
  });

  return server;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

function runSse(port: number) {
  const mcp = createServer();
  const conns: Record<string, SSEServerTransport> = {};

  Deno.serve({ port }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === '/sse' && req.method === 'GET') {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const res = { flushHeaders() {}, on() {}, write: (d:string)=>{writer.write(new TextEncoder().encode(d));return true;}, end:()=>writer.close() } as any;
      const t = new SSEServerTransport('/messages', res);
      conns[t.sessionId] = t;
      req.signal.addEventListener('abort', ()=>delete conns[t.sessionId]);
      mcp.connect(t);
      return new Response(readable, { headers: { 'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive' } });
    }
    if (url.pathname === '/messages' && req.method === 'POST') {
      const sid = url.searchParams.get('sessionId') ?? '';
      return new Response(conns[sid] ? 'Message received':'No transport', { status: conns[sid]?200:400 });
    }
    return new Response(url.pathname==='/'?'MCP Run Python Local':'Not Found', { status: url.pathname==='/'?200:404 });
  });
  console.log(`MCP Run Python Local ${VERSION} listening on :${port}`);
}

async function runStdio() { await createServer().connect(new StdioServerTransport()); }

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.error('Usage: deno run -A jsr:@changhc/mcp-run-python-local [stdio|sse|warmup] [--port <num>]');
}

async function warmup() {
  const res = await runPythonCode('import sys; print("Python", sys.version)');
  console.log(asXml(res));
}

export async function main() {
  if (Deno.args.length < 1) { usage(); Deno.exit(1); }
  const flags = parseArgs(Deno.args.slice(1), { string:['port'], default:{ port:'3001' } });
  const mode = Deno.args[0];
  const port = parseInt(flags.port as string, 10);
  switch (mode) {
    case 'stdio': await runStdio(); break;
    case 'sse': runSse(port); break;
    case 'warmup': await warmup(); break;
    default: usage(); Deno.exit(1);
  }
}

if (import.meta.main) {
  await main().catch((e)=>{ console.error(e); Deno.exit(1); });
}
