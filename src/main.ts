import { parseArgs } from '@std/cli/parse-args';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type LoggingLevel, SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Configuration & constants
// ---------------------------------------------------------------------------

const VERSION = '0.3.1'; // no‑mount, no‑workdir

/**
 * Pick the Python interpreter. If a virtual‑env is supplied use its interpreter,
 * otherwise fall back to whatever is on $PATH.
 */
function getPythonPath(venv: string | null): string {
  if (!venv) return 'python';
  return Deno.build.os === 'windows'
    ? `${venv}\\Scripts\\python.exe`
    : `${venv}/bin/python`;
}

// ---------------------------------------------------------------------------
// Helpers for running Python & pip
// ---------------------------------------------------------------------------

function getPipPath(venv: string | null): string {
  if (!venv) return Deno.build.os === 'windows' ? 'pip' : 'pip';
  return Deno.build.os === 'windows'
    ? `${venv}\Scripts\pip.exe`
    : `${venv}/bin/pip`;
}


interface RunResult {
  status: 'success' | 'error';
  output: string[];
  error: string | null;
}

async function runPythonCode(
  code: string,
  python: string,
  log: (lvl: LoggingLevel, msg: string) => void,
): Promise<RunResult> {
  try {
    // write snippet to a temp file in the system tmp dir
    const tempFile = await Deno.makeTempFile({ suffix: '.py' });
    await Deno.writeTextFile(tempFile, code);

    log('debug', `Executing Python code via ${python}`);

    const proc = new Deno.Command(python, {
      args: [tempFile],
      stdout: 'piped',
      stderr: 'piped',
    });
    const { code: exitCode, stdout, stderr } = await proc.output();

    await Deno.remove(tempFile).catch(() => {});

    const dec = new TextDecoder();
    const outLines = dec.decode(stdout).split('\n');
    const err = dec.decode(stderr);

    return exitCode === 0
      ? { status: 'success', output: outLines, error: err || null }
      : { status: 'error', output: outLines, error: err || `Exit code ${exitCode}` };
  } catch (e) {
    return { status: 'error', output: [], error: e instanceof Error ? e.message : String(e) };
  }
}

async function runPythonFile(
  filePath: string,
  python: string,
  log: (lvl: LoggingLevel, msg: string) => void,
): Promise<RunResult> {
  try {
    log('debug', `Executing Python file ${filePath} via ${python}`);
    const proc = new Deno.Command(python, {
      args: [filePath],
      stdout: 'piped',
      stderr: 'piped',
    });
    const { code: exitCode, stdout, stderr } = await proc.output();
    const dec = new TextDecoder();
    const outLines = dec.decode(stdout).split('\n');
    const err = dec.decode(stderr);

    return exitCode === 0
      ? { status: 'success', output: outLines, error: err || null }
      : { status: 'error', output: outLines, error: err || `Exit code ${exitCode}` };
  } catch (e) {
    return { status: 'error', output: [], error: e instanceof Error ? e.message : String(e) };
  }
}

function asXml(res: RunResult): string {
  const xml: string[] = [`<status>${res.status}</status>`];
  if (res.output.length) xml.push('<output>', ...res.output, '</output>');
  if (res.error) xml.push('<error>', res.error, '</error>');
  return xml.join('\n');
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

function createServer(venv: string | null): McpServer {
  const server = new McpServer(
    { name: 'MCP Run Python Local', version: VERSION },
    { instructions: 'Call "run_python_code" or "run_python_file".', capabilities: { logging: {} } },
  );

  const python = getPythonPath(venv);

  // logging helpers
  const levels: LoggingLevel[] = [
    'debug',
    'info',
    'notice',
    'warning',
    'error',
    'critical',
    'alert',
    'emergency',
  ];
  let currentLevel: LoggingLevel = 'emergency';

  server.server.setRequestHandler(SetLevelRequestSchema, (req) => {
    currentLevel = req.params.level;
    return {};
  });

  const log = (lvl: LoggingLevel, msg: string) => {
    if (levels.indexOf(lvl) >= levels.indexOf(currentLevel)) {
      server.server.sendLoggingMessage({ level: lvl, data: msg }).catch(() => {});
    }
  };

  // tools
    server.tool(
    'install_python_package',
    'Install a Python package using pip.',
    { package_name: z.string() },
    async ({ package_name }) => {
      const pipCmd = getPipPath(venv);
      const proc = new Deno.Command(pipCmd, {
        args: ['install', package_name],
        stdout: 'piped',
        stderr: 'piped',
      });
      const { code, stdout, stderr } = await proc.output();
      const dec = new TextDecoder();
      const res: RunResult = code === 0
        ? { status: 'success', output: dec.decode(stdout).split('
'), error: null }
        : {
            status: 'error',
            output: dec.decode(stdout).split('
'),
            error: dec.decode(stderr) || `Exit code ${code}`,
          };
      return { content: [{ type: 'text', text: asXml(res) }] };
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transports (stdio / SSE)
// ---------------------------------------------------------------------------

function runSse(port: number, venv: string | null) {
  const mcpServer = createServer(venv);
  const transports: Record<string, SSEServerTransport> = {};

  Deno.serve({ port }, (req) => {
    const url = new URL(req.url);

    if (url.pathname === '/sse' && req.method === 'GET') {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const response = {
        flushHeaders() {},
        on() {},
        write: (d: string) => {
          writer.write(new TextEncoder().encode(d));
          return true;
        },
        end: () => writer.close(),
      } as any;

      const t = new SSEServerTransport('/messages', response);
      transports[t.sessionId] = t;
      req.signal.addEventListener('abort', () => delete transports[t.sessionId]);
      mcpServer.connect(t);

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    if (url.pathname === '/messages' && req.method === 'POST') {
      const sid = url.searchParams.get('sessionId') ?? '';
      return new Response(transports[sid] ? 'Message received' : 'No transport for sessionId', {
        status: transports[sid] ? 200 : 400,
      });
    }

    return new Response(url.pathname === '/' ? 'MCP Run Python Local Server' : 'Not Found', {
      status: url.pathname === '/' ? 200 : 404,
    });
  });

  console.log(`MCP Run Python Local ${VERSION} listening on :${port}`);
}

async function runStdio(venv: string | null) {
  await createServer(venv).connect(new StdioServerTransport());
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function usage() {
  console.error(
    `Usage: deno run -A jsr:@changhc/mcp-run-python-local [stdio|sse|warmup] [options]\n  --port <port>\n  --venv <path>`,
  );
}

async function warmup(venv: string | null) {
  const python = getPythonPath(venv);
  const res = await runPythonCode('import sys; print("Python", sys.version)', python, () => {});
  console.log(asXml(res));
}

export async function main() {
  if (Deno.args.length < 1) {
    usage();
    Deno.exit(1);
  }

  const flags = parseArgs(Deno.args.slice(1), {
    string: ['port', 'venv'],
    default: { port: '3001', venv: null },
  });

  const mode = Deno.args[0];
  const port = parseInt(flags.port as string, 10);
  const venv = (flags.venv as string) ?? null;

  switch (mode) {
    case 'stdio':
      await runStdio(venv);
      break;
    case 'sse':
      runSse(port, venv);
      break;
    case 'warmup':
      await warmup(venv);
      break;
    default:
      usage();
      Deno.exit(1);
  }
}

if (import.meta.main) {
  await main().catch((e) => {
    console.error(e);
    Deno.exit(1);
  });
}
