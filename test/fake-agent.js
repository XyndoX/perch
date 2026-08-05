// Minimal ndjson JSON-RPC "agent" for testing perch.
// Requires `--serve` so node's test-file discovery (which sweeps test/) can load
// this file without it parking on stdin forever.
import { createInterface } from 'node:readline'

if (!process.argv.includes('--serve')) process.exit(0)

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')

createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }

  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } })
  } else if (m.method === 'session/new') {
    send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 's1' } })
  } else if (m.method === 'session/prompt') {
    const text = m.params?.prompt?.[0]?.text ?? ''
    for (const t of [`ack:${text}`, 'done']) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } },
      })
    }
    send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })
  }
}).on('close', () => process.exit(0))
