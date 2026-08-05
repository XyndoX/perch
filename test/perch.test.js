import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TIMEOUT = 20000

let proc
let port
let token
let jsonl
const outLines = []
let stderr = ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, what) {
  const t0 = Date.now()
  while (Date.now() - t0 < TIMEOUT) {
    const hit = fn()
    if (hit) return hit
    await sleep(20)
  }
  throw new Error(`timeout waiting for ${what}\nstdout:\n${outLines.join('\n')}\nstderr:\n${stderr}`)
}

const send = (obj) => proc.stdin.write(JSON.stringify(obj) + '\n')
const line = (pred) => waitFor(() => outLines.find(pred), 'stdout line')
const parsed = () => outLines.map((l) => { try { return JSON.parse(l) } catch { return null } })

async function post(path, body) {
  return fetch(`http://localhost:${port}${path}?t=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Read SSE frames until `count` events have arrived, then abort.
async function readSSE(path, count, headers = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT)
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`http://localhost:${port}${path}${sep}t=${token}`, { signal: ac.signal, headers })
  assert.equal(res.headers.get('content-type'), 'text/event-stream')
  const out = []
  let buf = ''
  try {
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8')
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const dataLine = raw.split('\n').find((l) => l.startsWith('data: '))
        if (dataLine) out.push(JSON.parse(dataLine.slice(6)))
      }
      if (out.length >= count) break
    }
  } finally {
    clearTimeout(timer)
    try { ac.abort() } catch { /* already done */ }
  }
  return out
}

before(async () => {
  proc = spawn('node', [join(root, 'src', 'perch.ts'), 'node', join(root, 'test', 'fake-agent.js'), '--serve'], {
    cwd: root,
    env: { ...process.env, PERCH_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let obuf = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (d) => {
    obuf += d
    let i
    while ((i = obuf.indexOf('\n')) >= 0) { outLines.push(obuf.slice(0, i)); obuf = obuf.slice(i + 1) }
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (d) => { stderr += d })

  const m = await waitFor(() => stderr.match(/^perch: live at http:\/\/localhost:(\d+)\/\?t=([0-9a-f]+) {2}\(recording: (.+)\)$/m), 'startup line')
  port = Number(m[1])
  token = m[2]
  jsonl = m[3]
})

after(() => { proc?.kill('SIGKILL') })

test('(a) initialize / session-new / prompt round-trip appears verbatim on stdout', async () => {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(
    await line((l) => l.includes('"id":1')),
    '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{}}}',
  )

  send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp' } })
  assert.equal(
    await line((l) => l.includes('"id":2')),
    '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}}',
  )

  send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'hello' }] } })
  await line((l) => l.includes('ack:hello'))
  await line((l) => l.includes('"text":"done"'))
  assert.equal(
    await line((l) => l.includes('"id":3')),
    '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}',
  )
})

test('(b) GET /events replays the recorded frames', async () => {
  // 3 owner requests + 3 agent responses + 2 agent updates = 8 frames so far.
  const evs = await readSSE('/events', 8)
  assert.ok(evs.length >= 8, `expected >=8 replayed events, got ${evs.length}`)
  assert.deepEqual(evs.map((e) => e.seq), evs.map((_, i) => i + 1))

  const first = evs[0]
  assert.equal(first.kind, 'frame')
  assert.equal(first.dir, 'client->agent')
  assert.deepEqual(first.actor, { id: 'owner', type: 'human', name: 'owner' })
  assert.equal(first.frame.method, 'initialize')

  const second = evs[1]
  assert.equal(second.dir, 'agent->client')
  assert.equal(second.actor.id, 'agent')
  assert.equal(second.actor.type, 'agent')
  assert.equal(second.frame.result.protocolVersion, 1)

  assert.ok(evs.some((e) => e.frame?.params?.update?.content?.text === 'ack:hello'), 'update frame replayed')

  // SSE resume: a reconnect with Last-Event-ID only replays events past it
  const resumed = await readSSE('/events', 2, { 'last-event-id': '6' })
  assert.ok(resumed.every((e) => e.seq > 6), `resume leaked old seqs: ${resumed.map((e) => e.seq)}`)

  // and everything is a 401 without the token
  const denied = await fetch(`http://localhost:${port}/events`)
  assert.equal(denied.status, 401)
})

test('(c) /join + /inject reaches the agent and is attributed to the viewer', async () => {
  const joinRes = await post('/join', { name: 'Max' })
  assert.equal(joinRes.status, 200)
  const { id } = await joinRes.json()
  assert.equal(id, 'v-1')

  const injectRes = await post('/inject', { id, text: 'use the staging endpoint' })
  assert.equal(injectRes.status, 202)

  await line((l) => l.includes('ack:use the staging endpoint'))

  const rows = readFileSync(jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const injected = rows.find((e) => e.kind === 'frame' && e.frame?.method === 'session/prompt' && e.actor.id === 'v-1')
  assert.ok(injected, 'injected frame attributed to v-1 present in jsonl')
  assert.equal(injected.actor.name, 'Max')
  assert.equal(injected.actor.type, 'human')
  assert.equal(injected.dir, 'client->agent')
  assert.equal(injected.frame.params.sessionId, 's1')
  assert.equal(injected.frame.params.prompt[0].text, 'use the staging endpoint')
  assert.match(injected.frame.id, /^perch:\d+$/)

  const join = rows.find((e) => e.kind === 'presence' && e.presence.event === 'join')
  assert.ok(join, 'join presence event recorded')
  assert.deepEqual(join.presence.viewers, [{ id: 'v-1', name: 'Max' }])
})

test('(d) the perch: response id is never forwarded to stdout', async () => {
  // Give the swallowed response ample time to (not) show up.
  await sleep(300)
  const ids = parsed().map((f) => f?.id)
  assert.ok(!ids.some((i) => typeof i === 'string' && i.startsWith('perch:')), `perch: id leaked to stdout: ${outLines.join('\n')}`)
  // ...but the agent's notifications for that injected prompt did pass through.
  assert.ok(outLines.some((l) => l.includes('ack:use the staging endpoint')))
})

test('(e) jsonl exists and every line matches the event schema', () => {
  const rows = readFileSync(jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(rows.length >= 12, `expected >=12 events, got ${rows.length}`)
  rows.forEach((e, i) => {
    assert.equal(e.seq, i + 1)
    assert.equal(typeof e.ts, 'number')
    assert.ok(['frame', 'presence'].includes(e.kind))
    assert.equal(typeof e.actor.id, 'string')
    assert.ok(['human', 'agent'].includes(e.actor.type))
    assert.equal(typeof e.actor.name, 'string')
    if (e.kind === 'frame') {
      assert.ok(['client->agent', 'agent->client'].includes(e.dir))
      assert.equal(typeof e.frame, 'object')
    } else {
      assert.ok(['join', 'leave'].includes(e.presence.event))
      assert.ok(Array.isArray(e.presence.viewers))
    }
  })
})

test('(f) 409 from /inject before a session exists, and 409-free after', async () => {
  // Fresh proxy with no traffic → no sessionId yet.
  const p2 = spawn('node', [join(root, 'src', 'perch.ts'), 'node', join(root, 'test', 'fake-agent.js'), '--serve'], {
    cwd: root, env: { ...process.env, PERCH_PORT: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let err = ''
  p2.stderr.setEncoding('utf8')
  p2.stderr.on('data', (d) => { err += d })
  try {
    const m = await waitFor(() => err.match(/localhost:(\d+)\/\?t=([0-9a-f]+)/), 'p2 startup')
    const res = await fetch(`http://localhost:${m[1]}/inject?t=${m[2]}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'v-1', text: 'too early' }),
    })
    assert.equal(res.status, 409)
  } finally {
    p2.kill('SIGKILL')
  }
})
