import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
// Backend is switchable: DB_BACKEND=sqlite → local data/probe.db, otherwise Firestore.
const DB_BACKEND = process.env.DB_BACKEND === "sqlite" ? "./db.js" : "./db-firebase.js";
const { logEvent, allEvents, artifactEvents, countAllArtifacts, summary, countArtifacts, getScenario } = await import(DB_BACKEND);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ART_DIR = path.join(__dirname, "data", "artifacts");
fs.mkdirSync(ART_DIR, { recursive: true });

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from .env
const app = express();
app.use(express.json({ limit: "5mb" }));

// Root: participant session when ?pid= is present, otherwise the researcher launcher.
app.get("/", (req, res, next) => {
  if (req.query.pid) return res.sendFile(path.join(__dirname, "public", "index.html"));
  res.redirect("/start.html");
});

app.use(express.static(path.join(__dirname, "public")));

// Serve saved artifacts. If the file is missing on THIS machine (e.g. a collaborator
// reviewing from another computer), re-create it from the HTML stored in the DB and
// cache it to disk, so /artifacts/... works everywhere without syncing files.
app.get("/artifacts/:pid/:fname", async (req, res) => {
  const clean = (s) => String(s || "").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const pid = clean(req.params.pid), fname = clean(req.params.fname);
  const abs = path.join(ART_DIR, pid, fname);
  if (fs.existsSync(abs)) return res.sendFile(abs);
  try {
    const rel = `/artifacts/${pid}/${fname}`;
    const hit = (await artifactEvents(pid))
      .map((r) => (typeof r.data === "string" ? JSON.parse(r.data || "{}") : r.data || {}))
      .find((d) => d && d.file === rel);
    if (hit && hit.html) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, hit.html); // materialize the folder locally, from the DB
      return res.type("html").send(hit.html);
    }
  } catch (e) {
    console.error("artifact self-heal failed:", e?.message || e);
  }
  return res.status(404).send("Artifact not found (no local file, and no HTML stored in the database for it).");
});
app.use("/artifacts", express.static(ART_DIR)); // fallback for any other artifact assets

// ---- Study configuration -------------------------------------------------
const MODEL = "claude-sonnet-5"; // fast + strong artifacts; swap for claude-haiku-4-5 or claude-opus-5
const MAX_TOKENS = 48000; // headroom so token-heavy interactive artifacts aren't truncated mid-code (caps thinking + output)
const DATASETS_ENABLED = false; // set true to re-enable dataset injection + overview buttons

const BASE_PROMPT = `You are a research assistant for a college student looking into a topic to give a brief verbal overview to their professor and classmates in a week.

Answer the student's actual question directly and substantively. Lead with the answer — the key facts, findings, and main perspectives — and keep it concise. Do NOT assume they want to be taught or coached into figuring it out themselves: skip Socratic questioning, "what do you already know?" openers, research plans, "here's how to investigate this rigorously" trackers, self-tests, and long step-by-step checklists. Don't pad with caveats, meta-commentary, or process talk — just tell them what they asked.`;

const INTERACTIVE_TAIL = `

Put depth into interactive artifacts, not into long chat messages. Keep the chat reply short — a direct answer plus a one-line pointer to the artifact — and let the artifact carry the detail and exploration. Proactively build an interactive artifact whenever it would let the student see, compare, or manipulate the answer, so the work lives in the artifacts rather than in the chat.

Be creative and varied with artifact formats — match the format to the idea, and do NOT default to tables, sliders, and bullet lists. Prefer richer interactions where they fit: canvas/SVG visualizations and mini-simulations, drag-and-drop (concept maps, card sorts, ranking, arranging steps), clickable annotated diagrams with reveal-on-click hotspots, animated step-throughs (play/pause), before/after comparison wipes, predict-then-reveal (the student sketches or guesses first, then compares), branching "choose your own" explorers, and drag-to-match / quiz self-tests. Use tables or sliders only when they are genuinely the best fit.

When you create an interactive artifact, output it as a SINGLE, SELF-CONTAINED HTML document inside exactly ONE \`\`\`html code fence. It MUST NOT load any external scripts, styles, fonts, images, or data — inline all CSS and JavaScript, vanilla HTML/CSS/JS only (canvas and inline SVG are encouraged). Give it a descriptive <title>. Make it genuinely interactive so the student can play with it. Keep any prose reply outside the code fence brief.`;

const STATIC_TAIL = `

Put depth into visual artifacts, not into long chat messages. Keep the chat reply short — a direct answer plus a one-line pointer to the artifact — and let the artifact carry the detail. Proactively build a STATIC visual artifact whenever it would help the student see or compare the answer, so the work lives in the artifacts rather than in the chat.

Be creative and varied with artifact formats — match the format to the idea, and do NOT default to plain tables and bullet lists. Prefer rich STATIC visuals: annotated diagrams, infographics, labeled charts and figures, comparison layouts, timelines, maps, and illustrations. The student reads and looks at the artifact — they do NOT manipulate it.

When you create an artifact, output it as a SINGLE, SELF-CONTAINED HTML document inside exactly ONE \`\`\`html code fence. It MUST NOT load any external scripts, styles, fonts, images, or data — inline all CSS and inline SVG. Give it a descriptive <title>. It MUST be STATIC and non-interactive: it must not respond to any user input — no clickable elements, buttons, sliders, inputs, hover effects, drag, tabs, or animations triggered by interaction. Prefer inline SVG and CSS for all visuals. If you use JavaScript at all, it may ONLY render the visual once on page load; it must never respond to user actions. Keep any prose reply outside the code fence brief.`;

const TEXT_TAIL = `

Answer entirely in the chat as text. Do NOT build any artifact, and do NOT emit HTML code fences or code blocks — no diagrams, charts, widgets, or standalone documents. Write a clear, well-organized prose answer (short paragraphs, and plain bulleted lists only where they genuinely help). Everything the student needs must live in your chat reply.`;

const systemFor = (cond) =>
  BASE_PROMPT + (cond === "text" ? TEXT_TAIL : cond === "static" ? STATIC_TAIL : INTERACTIVE_TAIL);

// Task → scenario shown to the participant (and the dataset key is the task name).
const SCENARIOS = {
  practice: `Practice round: get comfortable with the tool before the main tasks. Pick any everyday question you're genuinely curious about — for example, "what actually makes coffee taste bitter?" or "how does a bike stay upright?" — and explore it with the assistant.`,
  sd: `Is San Diego still affordable for the people who grew up here?`,
  relocation: `Maya Torres is a 34-year-old ICU nurse married to Josh, a 34-year-old fully remote software engineer. They have one daughter, Elena, who is 7 and starting 2nd grade. The family currently rents in a car-dependent Bay Area suburb on a combined household income of $95,000. Maya has a standing offer to transfer within her hospital network to a partner hospital in any of the candidate cities. You need to help her decide where within each city they should choose to live in based on her following priorities:

- Housing budget: max $2,200/month, ideally with room left to save
- Within ~25 minutes of a major hospital (Maya works 12-hour shifts)
- An elementary school with real learning-support resources for Elena, who has mild ADHD, not just a high test-score average
- A walkable neighborhood with a real sense of community, leaving car-dependency behind
- Some cultural/economic diversity, not a homogeneous bubble

Cities:
1. Baltimore
2. Philadelphia
3. Minneapolis
4. Chicago`,
};
// -------------------------------------------------------------------------

// ---- Task datasets: read, filter to the task's geography, cap to fit context ----
const DATASETS_DIR = path.join(__dirname, "datasets");
const DEFAULT_FILTERS = { sd: ["san diego"], relocation: ["baltimore", "philadelphia", "minneapolis", "chicago"] };
const PER_FILE_CAP = 200000; // chars kept per file after filtering (~50k tokens)
const TOTAL_CAP = 500000;    // total chars injected per request (~125k tokens; safely under the 1M window)
const FILTER_MIN = 50000;    // only row-filter CSV/TSV files larger than this
const _dsCache = new Map();  // concatenated injection text, per key
const _dfCache = new Map();  // filtered per-file listing, per key

function readConfig(key) {
  try { return JSON.parse(fs.readFileSync(path.join(DATASETS_DIR, key, "_config.json"), "utf8")); } catch { return {}; }
}

// Keep a big CSV's header + only rows matching the task's filter keywords; then hard-cap length.
function filterContent(name, raw, filters) {
  let content = raw;
  if (/\.(csv|tsv)$/i.test(name) && filters.length && raw.length > FILTER_MIN) {
    const lines = raw.split(/\r?\n/);
    const header = lines[0] ?? "";
    const kept = lines.slice(1).filter((l) => { const low = l.toLowerCase(); return filters.some((f) => low.includes(f)); });
    content = kept.length ? [header, ...kept].join("\n") : `${header}\n[no rows matched the task filter: ${filters.join(", ")}]`;
  }
  if (content.length > PER_FILE_CAP) content = content.slice(0, PER_FILE_CAP) + "\n… [truncated to fit context]";
  return content;
}

// Concatenated dataset text for the model, capped to TOTAL_CAP (never overflows).
function loadDataset(key) {
  if (!DATASETS_ENABLED) return "";
  const safe = String(key || "").replace(/[^a-z0-9_-]/gi, "");
  if (!safe) return "";
  if (_dsCache.has(safe)) return _dsCache.get(safe);
  let out = "";
  for (const f of datasetFiles(safe)) {
    const header = `\n\n## FILE: ${f.name} (${f.label})\n`;
    if (out.length + header.length >= TOTAL_CAP) break;
    let body = f.content;
    const room = TOTAL_CAP - out.length - header.length;
    if (body.length > room) body = body.slice(0, room) + "\n… [truncated to fit context]";
    out += header + body;
  }
  _dsCache.set(safe, out);
  return out;
}

// Turn a cryptic filename into a readable label (heuristics for common sources).
function prettyLabel(name) {
  const base = name.replace(/\.[^.]+$/, "");
  const low = base.toLowerCase();
  const dict = [
    [/zhvi/, "Home values (Zillow ZHVI)"],
    [/zori/, "Rents (Zillow ZORI)"],
    [/b19013/, "Median household income (ACS)"],
    [/b25070/, "Rent burden (ACS)"],
    [/b25064/, "Median rent (ACS)"],
    [/b03002/, "Race & ethnicity (ACS)"],
    [/b08303/, "Commute time (ACS)"],
    [/b05002|b06001|b07001/, "Place of birth / mobility (ACS)"],
    [/childcount|_618|idea/, "Special-ed child count (IDEA)"],
    [/crdc/, "504 & IDEA by school (CRDC)"],
    [/walkab/, "Walkability index (EPA)"],
    [/hospital/, "Hospital locations"],
    [/fmr/, "Fair Market Rents (HUD)"],
    [/migrat/, "Migration by income (IRS)"],
  ];
  for (const [re, l] of dict) {
    if (re.test(low)) {
      const v = (low.match(/-(data|column|table|metadata)\b/) || [])[1];
      return v ? `${l} — ${v}` : l;
    }
  }
  return base.replace(/[_.\-]+/g, " ").replace(/\s+/g, " ").trim();
}

// Per-file listing (name + label + filtered content) for the overview + injection.
// Optional _labels.json ({file:"Label"}) and _config.json ({filter:[...]}) override defaults.
function datasetFiles(key) {
  if (!DATASETS_ENABLED) return [];
  const safe = String(key || "").replace(/[^a-z0-9_-]/gi, "");
  if (!safe) return [];
  if (_dfCache.has(safe)) return _dfCache.get(safe);
  const dir = path.join(DATASETS_DIR, safe);
  const cfg = readConfig(safe);
  const filters = ((cfg.filter && cfg.filter.length ? cfg.filter : DEFAULT_FILTERS[safe]) || []).map((s) => String(s).toLowerCase());
  let labels = {};
  try { labels = JSON.parse(fs.readFileSync(path.join(dir, "_labels.json"), "utf8")); } catch { /* none */ }
  const out = [];
  try {
    for (const f of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isFile() && !f.startsWith(".") && !f.startsWith("_")) {
        out.push({ name: f, label: labels[f] || prettyLabel(f), content: filterContent(f, fs.readFileSync(p, "utf8"), filters) });
      }
    }
  } catch { /* no dataset */ }
  _dfCache.set(safe, out);
  return out;
}

const safePid = (pid) => String(pid || "anon").replace(/[^a-zA-Z0-9_-]/g, "_");
const extractArtifacts = (text) =>
  [...text.matchAll(/```html\s*([\s\S]*?)```/gi)].map((m) => m[1].trim()).filter(Boolean);

// Save each interactive artifact as a standalone, re-openable .html file + a DB record.
async function saveArtifacts(text, pid, cond, task) {
  for (const html of extractArtifacts(text)) {
    const seq = (await countArtifacts(pid, cond, task)) + 1;
    const dir = path.join(ART_DIR, safePid(pid));
    fs.mkdirSync(dir, { recursive: true });
    const fname = `${String(seq).padStart(3, "0")}_${Date.now()}.html`;
    fs.writeFileSync(path.join(dir, fname), html);
    const rel = `/artifacts/${safePid(pid)}/${fname}`;
    // Store the HTML in the event too (not just on disk) so any machine reading
    // the DB can re-materialize the file locally. Guard the Firestore 1MB limit.
    const data = { seq, file: rel, chars: html.length };
    if (html.length <= 900000) data.html = html;
    await logEvent({ pid, cond, task, kind: "artifact", type: "created", data });
  }
}

// Chat turn: send full history, get Claude's reply, log the exchange + any artifact.
app.post("/api/chat", async (req, res) => {
  const { messages, pid, cond, task } = req.body || {};
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); }); // participant hit Stop / disconnected
  try {
    const system = [{ type: "text", text: systemFor(cond), cache_control: { type: "ephemeral" } }];
    const datasetText = loadDataset(task);
    if (datasetText) {
      system.push({
        type: "text",
        cache_control: { type: "ephemeral", ttl: "1h" }, // cache the datasets for the whole session
        text: `# DATASET FOR THIS TASK\nBase every factual claim and every artifact you build on the data below. If the data does not cover something the student asks about, say so plainly rather than inventing numbers or quotes.\n${datasetText}`,
      });
    }
    const msg = await client.messages
      .stream({ model: MODEL, max_tokens: MAX_TOKENS, system, messages }, { signal: ac.signal })
      .finalMessage();

    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    logEvent({
      pid,
      cond,
      task,
      kind: "chat",
      type: "turn",
      data: { user: messages?.[messages.length - 1]?.content ?? null, assistant: text, usage: msg.usage },
    });
    await saveArtifacts(text, pid, cond, task);
    res.json({ text });
  } catch (e) {
    if (ac.signal.aborted) return; // cancelled by the participant — nothing logged, connection closed
    console.error(e);
    if (!res.writableEnded) res.status(500).json({ error: String(e?.message || e) });
  }
});

// Scenario shown to a participant — determined by the task.
app.get("/api/scenario", (req, res) => res.json({ text: SCENARIOS[String(req.query.task || "")] ?? null }));
app.get("/api/dataset", (req, res) => res.json(datasetFiles(req.query.dataset)));

// Telemetry from the artifact iframe (clicks, inputs, scroll, heartbeats, ...).
app.post("/api/log", (req, res) => {
  const { pid, cond, task, event } = req.body || {};
  logEvent({
    pid,
    cond,
    task,
    kind: "telemetry",
    type: event?.type ?? null,
    data: { detail: event?.detail ?? null, artifact: event?.artifact ?? null, clientTs: event?.clientTs ?? null },
  });
  res.json({ ok: true });
});

// ---- Researcher: summary + artifacts + export ---------------------------
app.get("/api/summary", async (req, res) => res.json(await summary()));

// Chat history for a participant (to resume a session after a reload).
app.get("/api/history", async (req, res) => {
  const turns = (await allEvents(req.query.pid, req.query.cond, req.query.task))
    .filter((r) => r.kind === "chat")
    .map((r) => {
      const d = JSON.parse(r.data || "{}");
      return { user: d.user ?? null, assistant: d.assistant ?? "" };
    });
  res.json(turns);
});

// All events for one participant (parsed) — feeds the review dashboard.
app.get("/api/events", async (req, res) => {
  const rows = (await allEvents(req.query.pid, req.query.cond, req.query.task)).map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : null }));
  res.json(rows);
});

// Cheap count (aggregation query ≈ 1 read) — lets admin show the number without
// loading any artifact docs. The full list is fetched from /api/artifacts on demand.
app.get("/api/artifacts/count", async (req, res) => res.json({ count: await countAllArtifacts() }));

app.get("/api/artifacts", async (req, res) => {
  const rows = (await artifactEvents(req.query.pid, req.query.cond, req.query.task))
    .map((r) => {
      const d = JSON.parse(r.data || "{}");
      return { id: r.id, ts: r.ts, pid: r.pid, cond: r.cond, task: r.task, seq: d.seq, file: d.file, chars: d.chars };
    });
  res.json(rows);
});

app.get("/api/export.json", async (req, res) => {
  const rows = await allEvents(req.query.pid);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="probe_export_${Date.now()}.json"`);
  res.send(JSON.stringify(rows, null, 2));
});

app.get("/api/export.csv", async (req, res) => {
  const rows = await allEvents(req.query.pid);
  const cols = ["id", "ts", "pid", "cond", "task", "kind", "type", "data"];
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [cols.join(",")]
    .concat(rows.map((r) => cols.map((c) => esc(r[c])).join(",")))
    .join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="probe_export_${Date.now()}.csv"`);
  res.send(csv);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(
    `\nProbe running → http://localhost:${PORT}   [backend: ${DB_BACKEND === "./db.js" ? "local SQLite" : "Firestore"}]` +
      `\n  participant: /?pid=P01&cond=probing` +
      `\n  review:      /review.html   ·   export: /admin.html\n`
  )
);
