# perch — roadmap

Authoritative task list. Work top-down; tick with date + commit. v0.1 MVP shipped 2026-08-05 (commits `29dc945`…`be812aa`): proxy, JSONL recording, viewer, inject, presence, replay, link-token auth, SSE resume. All verified against the fake agent + real-browser e2e.

## Phase 1 — Make it real

- [ ] Run perch against a real ACP agent (`claude-code-acp` under Zed, or Gemini CLI). Log a real session, list every frame type the viewer renders badly. This is the highest-risk unknown — everything so far is fake-agent traffic.
- [ ] Viewer: render `session/request_permission`, fs read/write requests, terminal output, plan updates decently (read-only display; delegated approval stays out of scope).
- [ ] Decide rendering for real-world `agent_thought_chunk` volume (currently coalesced THINKING blocks — confirm it holds).
- [ ] SSE keep-alive heartbeat (idle connections get dropped by intermediaries).
- [x] Name decision (2026-08-06): product is **perch**, repo renamed to github.com/XyndoX/perch. npm `perch` is taken — publish as `perched` or `@xyndox/perch` (decide at Phase 3 publish).

## Phase 2 — Validate the pain (no new features)

- [ ] Ten-engineer test: 5–10 people with long agent sessions actually use it. Kill gate: does anyone use it a *second* time on a *different* project? High interest + low sessions = stop.
- [ ] Record the 20-second demo GIF from a real session (share link → viewer injects correction → agent course-corrects, attributed). Top of README.
- [ ] Problem write-up: "What breaks when two humans share one agent session" — ordering, attribution, mid-turn injection semantics, why teeing stdout isn't enough. Raw material: CONTRACT.md.

## Phase 3 — Ship publicly (only when Phases 1+2 hold)

- [ ] Public GitHub repo, Apache-2.0. npm publish → `npx perch <agent>` works.
- [ ] Launch order: Zed Discord / ACP community → one Reddit post (r/ClaudeAI) → Show HN (Tue–Thu, be in comments) → ACP Registry submission.

## Deliberately not shipping (v0.1 don't-ship table — do not re-add without a decision)

Hosted relay (v0.2, the paid seam), accounts/SSO, E2E encryption, viewer tool-call approval, non-ACP runtimes, editing files from the viewer, mobile, voice.

## Known ceilings (marked `ponytail:` in code)

Events held in memory + full replay (~10k events fine); no markdown in agent prose; token rotation = restart; per-event `appendFileSync`.
