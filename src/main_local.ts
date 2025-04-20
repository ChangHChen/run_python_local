/// <reference types="npm:@types/node@22.12.0" />

import './polyfill.ts'

import { parseArgs } from '@std/cli/parse-args'
import { ensureDir, emptyDir } from '@std/fs'
import { join } from 'node:path'
import { v4 as uuid } from 'uuid'
import http from 'node:http'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import {
  type LoggingLevel,
  SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

/* ─────────────────────────────────  CLI flags & globals ────────────────── */

const VERSION = '0.0.1'

let HOST_DIR = '/tmp/run_python_local'
let VROOT = '/working' // virtual root as seen from Python

/* ─────────────────────────────────  helpers ────────────────────────────── */

async function mkSessionDir() {
  await ensureDir(HOST_DIR)
  const dir = join(HOST_DIR, uuid())
  await ensureDir(dir)
  return dir
}

function virtToHost(p: string) {
  if (!p.startsWith(VROOT + '/'))
    throw new Error(`path must start with "${VROOT}/"`)
  return join(HOST_DIR, p.slice(VROOT.length + 1))
}

function escXml(x: string) {
  return x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/* ──────────────────────────────  core runner  ─────────────────────────── */

interface CodeFile {
  name: string
  content: string
  active: boolean
}

async function runLocalPython(
  files: CodeFile[],
  log: (lvl: LoggingLevel, m: string) => void,
) {
  const work = await mkSessionDir()

  /* write files */
  await Promise.all(
    files.map(async (f) =>
      Deno.writeTextFile(join(work, f.name), f.content),
    ),
  )

  const active = files.find((f) => f.active) ?? files[0]

  /* bootstrap script (runs inside host python) */
  const bootstrap = `
import json, sys, subprocess, importlib, traceback, re, ast, os
from pathlib import Path

WORKDIR = Path("${work}")
os.chdir(WORKDIR)

files = ${JSON.stringify(files)}
for f in files:
    Path(f["name"]).write_text(f["content"])

def find_deps(code:str):
    # 1️⃣ PEP 723 block
    m=re.search(r'#\\s*///.*?^#\\s*///', code, re.S|re.M)
    if m:
        m2=re.search(r'dependencies\\s*=\\s*\\[([^\\]]*)\\]', m.group(0), re.S)
        if m2:
            return [d.strip(" '\"") for d in m2.group(1).split(',') if d.strip()]
    # 2️⃣ import scan
    tree=ast.parse(code); mods=set()
    for n in ast.walk(tree):
        if isinstance(n,(ast.Import,ast.ImportFrom)):
            for a in n.names: mods.add(a.name.partition('.')[0])
    missing=[]
    for m in mods:
        try: importlib.import_module(m)
        except ModuleNotFoundError: missing.append(m)
    return missing

code = Path("${active.name}").read_text()
deps = find_deps(code)
if deps:
    subprocess.run([sys.executable, "-m", "pip", "install", *deps], check=False)

ns={"__name__":"__main__"}
try:
    exec(compile(code, "${active.name}", "exec"), ns)
    rv = ns.get("rv", None)
    out={"status":"success","dependencies":deps,"output":[],"return_value":json.dumps(rv,default=str) if rv is not None else None}
except Exception as e:
    out={"status":"run-error","dependencies":deps,"output":[], "error": traceback.format_exc()}

print(json.dumps(out, ensure_ascii=False))
  `.trim()

  /* spawn python */
  const proc = new Deno.Command('python3', {
    args: ['-'],
    cwd: work,
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn()

  /* feed script */
  const w = proc.stdin.getWriter()
  await w.write(new TextEncoder().encode(bootstrap))
  await w.close()

  const { code, stdout, stderr } = await proc.output()
  stderr &&
    new TextDecoder()
      .decode(stderr)
      .split('\n')
      .forEach((l) => l && log('warning', l))

  let res: Record<string, unknown> = {}
  try {
    res = JSON.parse(new TextDecoder().decode(stdout) || '{}')
  } catch {
    res = { status: 'run-error', error: 'Failed to parse JSON result' }
  }

  /* cleanup (optional) */
  try {
    await emptyDir(work)
    await Deno.remove(work, { recursive: true })
  } catch {}

  return res
}

function resToXml(r: Record<string, unknown>) {
    const xml: string[] = [`<status>${r.status}</status>`]
  
    if (Array.isArray(r.dependencies) && r.dependencies.length) {
      xml.push(
        `<dependencies>${escXml(JSON.stringify(r.dependencies))}</dependencies>`,
      )
    }
  
    if (Array.isArray(r.output) && r.output.length) {   // ← fixed line
      xml.push('<output>')
      for (const line of r.output) xml.push(escXml(String(line)))
      xml.push('</output>')
    }
  
    if (r.status === 'success' && r.return_value != null) {
      xml.push(
        `<return_value>${escXml(String(r.return_value))}</return_value>`,
      )
    } else if (r.status !== 'success' && typeof r.error === 'string') {
      xml.push(`<error>${escXml(r.error)}</error>`)
    }
  
    return xml.join('\n')
  }

/* ──────────────────────────────  MCP server  ─────────────────────────── */

function makeServer(): McpServer {
  const s = new McpServer(
    {
      name: 'MCP Run Python (Local)',
      version: VERSION,
    },
    {
      instructions:
        'Use "run_python_local" or "run_python_file".  Paths must start with the chosen mount root.',
      capabilities: { logging: {} },
    },
  )

  let lvl: LoggingLevel = 'emergency'
  s.server.setRequestHandler(SetLevelRequestSchema, (req) => {
    lvl = req.params.level
    return {}
  })

  const log = (l: LoggingLevel, m: string) =>
    LogLevels.indexOf(l) >= LogLevels.indexOf(lvl) &&
    s.server.sendLoggingMessage({ level: l, data: m })

  s.tool(
    'run_python_local',
    'Run supplied Python code on the host interpreter.',
    { python_code: z.string() },
    async ({ python_code }) => {
      const xml = resToXml(
        await runLocalPython(
          [{ name: 'main.py', content: python_code, active: true }],
          log,
        ),
      )
      return { content: [{ type: 'text', text: xml }] }
    },
  )

  s.tool(
    'run_python_file',
    'Execute an existing Python file (path must start with mount root).',
    { path: z.string() },
    async ({ path }) => {
      const host = virtToHost(path)
      const code = await Deno.readTextFile(host)
      const rel = path.slice(VROOT.length + 1)
      const xml = resToXml(
        await runLocalPython([{ name: rel, content: code, active: true }], log),
      )
      return { content: [{ type: 'text', text: xml }] }
    },
  )

  return s
}

/* ─────────────────────────────  transports  ──────────────────────────── */

async function runStdio() {
  await makeServer().connect(new StdioServerTransport())
}

function runSse(p: number) {
  const srv = makeServer()
  const sessions: Record<string, SSEServerTransport> = {}

  http
    .createServer(async (req, res) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`)
      const send = (c: number, t: string) => {
        res.statusCode = c
        res.setHeader('Content-Type', 'text/plain')
        res.end(t + '\n')
      }

      if (req.method === 'GET' && url.pathname === '/sse') {
        const tr = new SSEServerTransport('/messages', res)
        sessions[tr.sessionId] = tr
        res.on('close', () => delete sessions[tr.sessionId])
        await srv.connect(tr)
      } else if (req.method === 'POST' && url.pathname === '/messages') {
        const sid = url.searchParams.get('sessionId') ?? ''
        const tr = sessions[sid]
        if (!tr) return send(400, 'bad sessionId')
        await tr.handlePostMessage(req, res)
      } else send(404, 'not found')
    })
    .listen(p, () =>
      console.log(
        `MCP Run Python (Local) v${VERSION} listening on http://localhost:${p}`,
      ),
    )
}

/* ───────────────────────────────  main  ──────────────────────────────── */

async function main() {
  const { _, ...f } = parseArgs(Deno.args, {
    string: ['port', 'mount'],
    default: { port: '3002', mount: '/tmp/run_python_local:/working' },
  })

  /* mount flag */
  const [host, virt] = (f.mount as string).split(':')
  if (!host || !virt || !virt.startsWith('/'))
    throw new Error('--mount must look like "<host_dir>:<virtual_root>"')
  HOST_DIR = host
  VROOT = virt
  await ensureDir(HOST_DIR)

  if (_[0] === 'stdio') await runStdio()
  else if (_[0] === 'sse') runSse(parseInt(f.port))
  else {
    console.error(
      'Usage: deno run -A jsr:@your-scope/mcp-run-python-local ' +
        '[stdio|sse] [--port <p>] [--mount host:virt]',
    )
    Deno.exit(1)
  }
}

/* prettier-ignore */ const LogLevels: LoggingLevel[]=['debug','info','notice','warning','error','critical','alert','emergency']

await main()
