# perch v0.1 — internal contract

Fixed by The Good. Both `src/` and `public/` code against this. Do not change it; report conflicts instead.

## Event schema (JSONL on disk + SSE payload, identical objects)

```jsonc
{
  "seq": 1,                 // monotonically increasing, per session
  "ts": 1754350000000,      // Date.now() ms
  "kind": "frame" | "presence",
  "actor": { "id": "owner" | "agent" | "v-<n>", "type": "human" | "agent", "name": "Chris" },
  // kind=frame only:
  "dir": "client->agent" | "agent->client",
  "frame": { /* parsed JSON-RPC message */ },   // or { "raw": "<line>" } if unparseable
  // kind=presence only:
  "presence": { "event": "join" | "leave", "viewers": [ { "id": "v-1", "name": "Max" } ] }
}
```

- Frames from the editor's stdin → actor `{id:"owner", type:"human", name:"owner"}`.
- Frames from the agent's stdout → actor `{id:"agent", type:"agent", name:"<agent cmd>"}`.
- Injected frames (via POST /inject) → actor is the viewer who injected. This is the attribution asset — never drop it.

## HTTP API (embedded server in the proxy)

- `GET /` → serves `public/viewer.html` (Content-Type text/html).
- `GET /events?id=<viewerId>` → SSE (`text/event-stream`). On connect: replay **all** past events in order, then stream live. Each event: `data: <event JSON>\n\n`. If `id` is a registered viewer, its SSE disconnect broadcasts a `leave` presence event.
- `POST /join` body `{"name":"Max"}` → `200 {"id":"v-1"}`. Registers viewer, broadcasts `join` presence event.
- `POST /inject` body `{"id":"v-1","text":"use the staging endpoint"}` → `202`. Proxy writes to the agent's stdin a JSON-RPC request: `{"jsonrpc":"2.0","id":"perch:<n>","method":"session/prompt","params":{"sessionId":"<current>","prompt":[{"type":"text","text":"..."}]}}` and logs it as a frame event attributed to the viewer. `409` if no sessionId is known yet.

## Wire rules (proxy)

- ACP = newline-delimited JSON-RPC 2.0 over stdio. Passthrough is **line-verbatim**: editor stdin lines → agent stdin untouched; agent stdout lines → our stdout untouched. Parse a *copy* per line for the event log; parse failure never blocks relay.
- Exception: agent responses whose `id` starts with `"perch:"` answer an injected request — swallow them (log as frame, do NOT forward to our stdout; the editor never asked).
- Track current `sessionId`: from any frame with `params.sessionId`, or a `session/new` response `result.sessionId`.
- All perch's own output (URL, session file path, errors) goes to **stderr**. stdout is the wire.
- Startup line on stderr, exactly: `perch: live at http://localhost:<port>  (recording: <jsonl path>)`
- Port: `PERCH_PORT` env (0 = ephemeral), default 7337. Session file: `~/.perch/sessions/<ISO-ts>-<pid>.jsonl` (dirs created).
- Agent stderr → our stderr. Agent exit → proxy exits with same code, server closed.

## Viewer expectations (public/viewer.html)

Single self-contained file, no external requests, no build step. On load: prompt for name (persist in localStorage), POST /join, open SSE with its id. Render: coalesced `session/update` agent_message_chunk text, tool_call / tool_call_update rows, prompts from humans with the actor name badge, raw-JSON fallback (collapsed) for anything else, presence avatars, input box → POST /inject, autoscroll pinned to bottom unless user scrolled up.
