#!/usr/bin/env node
// perch v0.1 — transparent multiplayer proxy for ACP coding-agent sessions.
// stdout is the wire. All perch output goes to stderr. See CONTRACT.md.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerResponse, IncomingMessage } from 'node:http'

const argv = process.argv.slice(2)
if (argv.length === 0) {
  process.stderr.write('perch: usage: perch <agent command...>\n')
  process.exit(2)
}

const agentCmd = argv.join(' ')
const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.pipe(process.stderr)
child.on('error', (e) => {
  process.stderr.write(`perch: cannot spawn agent: ${e.message}\n`)
  process.exit(1)
})

// --- session file ---------------------------------------------------------
const sessionDir = join(homedir(), '.perch', 'sessions')
mkdirSync(sessionDir, { recursive: true })
// ponytail: ':' replaced in the ISO stamp so the filename survives non-POSIX
// filesystems. Ceiling: not a literal ISO string, still sorts chronologically.
const stamp = new Date().toISOString().replace(/:/g, '-')
const sessionFile = join(sessionDir, `${stamp}-${process.pid}.jsonl`)

// --- event log + fan-out --------------------------------------------------
const events: any[] = []
const subs = new Set<ServerResponse>()
let seq = 0

function emit(ev: any) {
  const full = { seq: ++seq, ts: Date.now(), ...ev }
  events.push(full)
  const json = JSON.stringify(full)
  appendFileSync(sessionFile, json + '\n')
  for (const res of subs) res.write(`data: ${json}\n\n`)
}

const OWNER = { id: 'owner', type: 'human', name: 'owner' }
const AGENT = { id: 'agent', type: 'agent', name: agentCmd }

let sessionId: string | null = null
function track(f: any) {
  const s = f?.params?.sessionId ?? f?.result?.sessionId
  if (typeof s === 'string') sessionId = s
}

function logFrame(dir: string, actor: any, line: string) {
  let f: any = null
  try { f = JSON.parse(line) } catch { /* unparseable is fine, relay never blocks */ }
  emit({ kind: 'frame', actor, dir, frame: f ?? { raw: line } })
  track(f)
  return f
}

// ponytail: naive newline splitter, no size cap. Ceiling: a single unbounded
// line without a newline buffers in memory. Also a trailing fragment at EOF is
// relayed with a newline appended.
function onLines(stream: NodeJS.ReadableStream, cb: (line: string) => void) {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (d: string) => {
    buf += d
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      cb(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
  })
  stream.on('end', () => { if (buf) { cb(buf); buf = '' } })
}

// editor stdin -> agent stdin (verbatim)
onLines(process.stdin, (line) => {
  child.stdin.write(line + '\n')
  logFrame('client->agent', OWNER, line)
})
process.stdin.on('end', () => child.stdin.end())

// agent stdout -> our stdout (verbatim), except responses to injected requests
onLines(child.stdout, (line) => {
  const f = logFrame('agent->client', AGENT, line)
  if (typeof f?.id === 'string' && f.id.startsWith('perch:')) return
  process.stdout.write(line + '\n')
})

// --- viewers --------------------------------------------------------------
const viewers = new Map<string, string>()
let viewerN = 0
let injectN = 0
const viewerList = () => [...viewers].map(([id, name]) => ({ id, name }))

function presence(event: string, id: string, name: string) {
  emit({ kind: 'presence', actor: { id, type: 'human', name }, presence: { event, viewers: viewerList() } })
}

// --- http -----------------------------------------------------------------
const viewerHtml = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'viewer.html')

async function readBody(req: IncomingMessage) {
  let b = ''
  for await (const c of req) b += c
  try { return JSON.parse(b) } catch { return {} }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const p = url.pathname

  if (req.method === 'GET' && p === '/') {
    try {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(viewerHtml))
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('public/viewer.html not found')
    }
    return
  }

  if (req.method === 'GET' && p === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`)
    subs.add(res)
    const id = url.searchParams.get('id')
    res.on('close', () => {
      subs.delete(res)
      if (id && viewers.has(id)) {
        const name = viewers.get(id)!
        viewers.delete(id)
        presence('leave', id, name)
      }
    })
    return
  }

  if (req.method === 'POST' && p === '/join') {
    const { name } = await readBody(req)
    const id = `v-${++viewerN}`
    const nm = typeof name === 'string' && name ? name : id
    viewers.set(id, nm)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id }))
    presence('join', id, nm)
    return
  }

  if (req.method === 'POST' && p === '/inject') {
    const { id, text } = await readBody(req)
    if (!sessionId) { res.writeHead(409, { 'content-type': 'text/plain' }).end('no session yet'); return }
    const name = viewers.get(id) ?? id ?? 'unknown'
    const frame = {
      jsonrpc: '2.0',
      id: `perch:${++injectN}`,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: String(text ?? '') }] },
    }
    child.stdin.write(JSON.stringify(frame) + '\n')
    emit({ kind: 'frame', actor: { id: id ?? 'unknown', type: 'human', name }, dir: 'client->agent', frame })
    res.writeHead(202).end()
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
})

const port = Number(process.env.PERCH_PORT ?? 7337)
server.listen(port, () => {
  const a = server.address()
  const bound = typeof a === 'object' && a ? a.port : port
  process.stderr.write(`perch: live at http://localhost:${bound}  (recording: ${sessionFile})\n`)
})

child.on('exit', (code, signal) => {
  server.close()
  for (const r of subs) r.end()
  process.exitCode = code ?? (signal ? 1 : 0)
  process.stdin.pause()
  // ponytail: 200ms backstop in case a handle keeps the loop alive.
  // Ceiling: a very large trailing stdout write could be cut short.
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref()
})
