# Artifact Sensemaking Probe (simplest Tier C)

A minimal research probe: a Claude-backed chat where a participant co-creates
**interactive artifacts**, plays with them in a sandboxed iframe, and every
message + interaction is logged to disk.

## What it does
- Chat with Claude (default `claude-sonnet-5`) using a sensemaking system prompt.
- Claude returns self-contained interactive HTML artifacts, rendered live in a
  sandboxed `<iframe sandbox="allow-scripts">` — the participant can actually
  click/drag/play with them.
- A tiny telemetry script is injected into each artifact and reports
  `click` / `input` / `scroll` / `heartbeat` / `visibility` events (via
  `postMessage`) so you can measure time-on-artifact and interactions.
- Everything is appended to `data/<pid>.jsonl` — one file per participant.

## Setup
```bash
npm install
cp .env.example .env      # then paste your ANTHROPIC_API_KEY into .env
npm start                 # → http://localhost:3000
```

## Running a session
Open with a participant id and condition in the URL:
```
http://localhost:3000/?pid=P01&cond=probing
```
(Defaults to `pid=anon&cond=default` if omitted.)

## Data & export
All activity is logged to a local **SQLite** database at `data/probe.db`
(via [db.js](db.js)) — one flat `events` table:
- `kind:"chat"` → the user turn, Claude's reply, and token `usage`.
- `kind:"telemetry"` → an interaction event (`type` = click/input/scroll/heartbeat/…, plus `detail`).

- `kind:"artifact"` → a website the participant created, with `seq`, `file`, `chars`.

Every row has a server `ts` timestamp, so chat and interaction streams align.

**Saved interactive websites:** each artifact is also written to disk as a
standalone, re-openable file at `data/artifacts/<pid>/NNN_<timestamp>.html`, and
served at `/artifacts/...`. The admin page lists them with **Open** links so you
can relaunch the live, interactive site later.

**Researcher / export page:** open **http://localhost:3000/admin.html** for a
per-participant summary and **Export** buttons — all data or a single participant,
as **CSV** or **JSON**. (Direct links: `/api/export.csv`, `/api/export.json`,
add `?pid=P01` to scope to one participant.)

## Migrating to Firebase later
All storage lives in [db.js](db.js) behind `logEvent` / `allEvents` / `summary`.
The `events` table is a flat, document-shaped schema, so migration is: reimplement
those three functions against Firestore (each row → one document) — nothing in
`server.js` or the front-end changes.

## Tuning
- **Model / cost / speed:** change `MODEL` in `server.js` (`claude-haiku-4-5`
  cheapest, `claude-opus-5` best artifacts).
- **Behavior / conditions:** edit `SYSTEM_PROMPT` in `server.js`. For an A/B
  condition, branch the prompt on the `cond` value.
- **Artifact richness:** the prompt asks for self-contained vanilla HTML/JS (no
  external libraries) for a clean, reproducible sandbox. To allow libraries
  (e.g. Chart.js/React via CDN) you'd add a Content-Security-Policy allowlist.

## Notes / limits
- This is a probe, not an experiment platform: no built-in consent flow or
  randomization — assign `pid`/`cond` yourself.
- Replies are non-streaming (simpler); the artifact appears when the reply
  finishes. Streaming is an easy upgrade if you want token-by-token output.
- Participant data flows to the Anthropic API (note retention in your IRB).
# LLM-interactive-artifact-probe
