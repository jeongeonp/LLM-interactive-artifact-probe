import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
// Backend is switchable: DB_BACKEND=sqlite → local data/probe.db, otherwise Firestore.
const DB_BACKEND = process.env.DB_BACKEND === "sqlite" ? "./db.js" : "./db-firebase.js";
const { logEvent, allEvents, artifactEvents, countAllArtifacts, summary, countArtifacts, getScenario, setScenario, deleteEmptySessions, eventsForPids, allScenarios, getCodes, setCode, getCodebookAdds, setCodebookAdd, deleteCodebookAdd, getProcessCodes, setProcessCode } = await import(DB_BACKEND);
import { listVideos, streamFile, accessToken } from "./drive.js";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ART_DIR = path.join(__dirname, "data", "artifacts");
fs.mkdirSync(ART_DIR, { recursive: true });

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from .env
const app = express();
app.use(express.json({ limit: "5mb" }));

// Process review shows participant recordings: gate it with HTTP basic auth (any username, password =
// PROCESS_REVIEW_PASSWORD). Without a password it's open on localhost but closed on Cloud Run (K_SERVICE).
const REVIEW_PW = process.env.PROCESS_REVIEW_PASSWORD || "";
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
app.use(["/process-review", "/process-review.html", "/api/process-review", "/api/process-codes", "/api/drive", "/api/drive-token"], (req, res, next) => {
  if (!REVIEW_PW) return process.env.K_SERVICE ? res.status(503).send("Process review is disabled: set PROCESS_REVIEW_PASSWORD on the service.") : next();
  const [type, b64] = String(req.headers.authorization || "").split(" ");
  const pw = type === "Basic" ? Buffer.from(b64 || "", "base64").toString().split(":").slice(1).join(":") : "";
  if (pw && crypto.timingSafeEqual(sha(pw), sha(REVIEW_PW))) return next();
  res.set("WWW-Authenticate", 'Basic realm="process-review"').status(401).send("Password required.");
});

// Root: participant session when ?pid= is present, otherwise the researcher launcher.
app.get("/", (req, res, next) => {
  if (req.query.pid) return res.sendFile(path.join(__dirname, "public", "index.html"));
  res.redirect("/start.html");
});
app.get("/artifact-review", (req, res) => res.sendFile(path.join(__dirname, "public", "artifact-review.html")));
app.get("/process-review", (req, res) => res.sendFile(path.join(__dirname, "public", "process-review.html")));

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
const WEB_SEARCH_ENABLED = true; // lets Claude pull real qualitative sources (Reddit, blogs, reviews)
// NOTE: after web_search, Claude sometimes (100% in one small observed sample) skips writing the artifact
// fence despite claiming it did. Mitigated below with a silent one-shot retry (search disabled on the retry
// call) for interactive/static turns that searched but produced no artifact — see the retry block in /api/chat.

const BASE_PROMPT = `You are a research assistant helping a college student with sensemaking about a topic they are looking into.

Answer the student's actual question directly and substantively. Lead with the answer — the key facts, findings, and main perspectives — and keep it concise. Do NOT assume they want to be taught or coached into figuring it out themselves: skip Socratic questioning, "what do you already know?" openers, research plans, "here's how to investigate this rigorously" trackers, self-tests, and long step-by-step checklists. Don't pad with caveats, meta-commentary, or process talk — just tell them what they asked.

End with the answer itself. Do not offer follow-up questions, suggest next prompts, or ask whether the student wants more — no "Would you like…", "Want me to…", or "Next, you could…" closers. The student will ask what they want next.

The artifact always comes first — that rule below is not optional.

Present everything — in the chat and inside artifacts — as confident, settled information. Do NOT add verification badges, "unconfirmed," "verify directly," confidence/source icons, or any other meta-commentary about how certain you are. If you can't confirm a specific detail, simply leave it out rather than flagging the gap — never surface your own uncertainty to the student.

Only reach for web search when the question genuinely calls for it — real people's opinions, sentiment, personal experiences, or anything time-sensitive that your own knowledge could be stale or thin on (e.g. "what do people say about X," "how do reviewers feel about Y"). For questions you can answer well from what you already know — how something works, established facts, history, definitions, straightforward comparisons of well-known things — just answer directly and skip the search. Searching when it isn't needed only slows down getting the student their artifact. You only have ONE search available per reply — combine everything you need into a single well-crafted query rather than planning on a second one, since it will simply be rejected and cost you nothing but time.`;

const INTERACTIVE_TAIL = `

Build an interactive artifact for every substantive question, no exceptions — this includes qualitative questions ("what do people say about X"), comparisons ("compare X vs Y"), opinion/sentiment questions, and anything else that might tempt you to just answer in prose. A comparison is exactly the kind of question that should become an artifact (a comparison tool), not a text table in the chat. Answer in chat text ALONE only if the student is asking something trivially small (e.g. "what year did X happen") where an artifact would be pointless. When in doubt, build the artifact. Keep the chat reply short — a direct answer plus a one-line pointer to the artifact — and let the artifact carry the detail and exploration.

Aim to surprise, not to play it safe — a forgettable dashboard of tabs and cards is a failure even if it's technically interactive. Before settling on a format, picture the single most unexpected, delightful way to explore this specific idea, and build that instead of the generic default. Never reuse the exact structure of your last artifact in this conversation. Reach for canvas/SVG visualizations and mini-simulations, drag-and-drop (concept maps, card sorts, ranking, arranging steps), clickable annotated diagrams with reveal-on-click hotspots, animated step-throughs (play/pause), before/after comparison wipes, predict-then-reveal (the student guesses first, then compares), branching "choose your own" explorers, word/tag clouds with click-to-reveal detail, and drag-to-match / quiz self-tests. Tables, sliders, and tabs+cards are a last resort, not a starting point.

When you create an interactive artifact, output it as a SINGLE, SELF-CONTAINED HTML document inside exactly ONE \`\`\`html code fence. It MUST NOT load any external scripts, styles, fonts, images, or data — inline all CSS and JavaScript, vanilla HTML/CSS/JS only (canvas and inline SVG are encouraged). Give it a descriptive <title>. Make it genuinely interactive so the student can play with it. Keep any prose reply outside the code fence brief.

Hard rule: NEVER refer to an artifact you have not actually written in this same reply — no "play with the simulator below," "explore the case file below," "the tool above lets you...", or similar, unless the \`\`\`html code fence for it is genuinely present in this message. If web search (or anything else) has used up your attention and you're tempted to wrap up with only a description, stop and actually write the code fence instead — a real artifact always outranks a longer or more thorough-sounding text summary.

Minor bookkeeping, does not affect design: if the artifact you'd naturally build ends up with multiple distinct content sections (e.g. separate topics, comparison groups, or steps), wrap each one in \`<section data-sm-section="Short Label">...</section>\` using whatever labels fit. Skip this entirely for single-view artifacts (a simulation, a single diagram, a canvas scene) that don't have separate parts.`;

const STATIC_TAIL = `

Put depth into visual artifacts, not into long chat messages. Keep the chat reply short — a direct answer plus a one-line pointer to the artifact — and let the artifact carry the detail. Proactively build a STATIC visual artifact whenever it would help the student see or compare the answer, so the work lives in the artifacts rather than in the chat.

Be creative and varied with artifact formats — match the format to the idea, and do NOT default to plain tables and bullet lists. Prefer rich STATIC visuals: annotated diagrams, infographics, labeled charts and figures, comparison layouts, timelines, maps, and illustrations. The student reads and looks at the artifact — they do NOT manipulate it.

When you create an artifact, output it as a SINGLE, SELF-CONTAINED HTML document inside exactly ONE \`\`\`html code fence. It MUST NOT load any external scripts, styles, fonts, images, or data — inline all CSS and inline SVG. Give it a descriptive <title>. It MUST be STATIC and non-interactive: it must not respond to any user input — no clickable elements, buttons, sliders, inputs, hover effects, drag, tabs, or animations triggered by interaction. Prefer inline SVG and CSS for all visuals. If you use JavaScript at all, it may ONLY render the visual once on page load; it must never respond to user actions. Keep any prose reply outside the code fence brief.

Minor bookkeeping, does not affect design: if the artifact ends up with multiple distinct content sections (e.g. separate topics, comparison groups, or steps), wrap each one in \`<section data-sm-section="Short Label">...</section>\` using whatever labels fit. Skip this entirely for a single unified visual with no separate parts.`;

const TEXT_TAIL = `

Answer entirely in the chat as text. Do NOT build any artifact, and do NOT emit HTML code fences or code blocks — no diagrams, charts, widgets, or standalone documents. Write a clear, well-organized prose answer (short paragraphs, and plain bulleted lists only where they genuinely help). Everything the student needs must live in your chat reply.`;

const systemFor = (cond) =>
  BASE_PROMPT + (cond === "text" ? TEXT_TAIL : cond === "static" ? STATIC_TAIL : INTERACTIVE_TAIL);

// Task → scenario shown to the participant (and the dataset key is the task name).
const SCENARIOS = {
  practice: ``,
  userchoice: ``, // per-participant task — researcher fills this in per pid via start.html, not shared globally
  demo: ``, // always uses the classic (non-structured) flow — see STRUCTURED_FLOW in index.html
  studytool: `Jasmine is starting her freshman year in college this fall. She has ADHD, and in high school her note-taking results were pretty inconsistent. Some classes she kept up fine with a notebook, in others she felt scattered regardless of what she tried.

She's read that people with attention difficulties sometimes do better taking notes on a tablet, since it's faster to reorganize and easier to keep pace with a fast-talking professor. But she's also read that people with ADHD are often more prone to getting pulled off task by the same kind of device (e.g. notifications, other apps, the temptation to switch tabs), which could just as easily cancel out any benefit.

A tablet, pencil, and case would cost around $700, money Jasmine doesn't have to spare. She works 15 hours a week at a campus job to help cover rent and groceries and has no savings cushion if something unexpected comes up. A notebook would cost her almost nothing. She's not sure whether investing in a tablet would actually help her focus, and whether it's worth her hard-earned money to buy.

Should Jasmine buy the tablet, or stick with traditional note-taking?`,
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

// Validate the JS inside a generated artifact by attempting to compile (not execute) each
// inline <script> block. Catches the recurring "stray escaped quote" class of bug — the
// artifact is well-formed HTML end to end (not truncated), but a single bad escape (e.g.
// \\' instead of \') breaks the ENTIRE script silently, with nothing clickable and no error
// visible to the participant. This is also invisible to the js_error telemetry in
// index.html, since that's a RUNTIME listener injected after the artifact's own script —
// a parse-time SyntaxError fires before that listener even exists to catch it.
function findArtifactJsError(html) {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, code] of scripts) {
    try {
      new Function(code);
    } catch (e) {
      return e.message;
    }
  }
  return null;
}

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

  // Stream small phase updates ("searching…", "writing…") to the client as newline-
  // delimited JSON, so the loading indicator can show real progress instead of a
  // generic timer. The final line always carries the complete { text } (or { error }),
  // same shape the client relied on when this was a single JSON response.
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no"); // tell any proxy in front not to buffer the stream
  const sendChunk = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };

  // Wire phase-detection listeners onto one message stream: a "searching" phase when a
  // web_search tool block starts, "writing" when text starts, "artifact" the first time
  // the accumulating text contains an opening ```html fence.
  let lastPhase = "thinking";
  const wirePhaseEvents = (stream) => {
    let sawArtifactPhase = false;
    stream.on("streamEvent", (event) => {
      const b = event?.content_block;
      if (event?.type !== "content_block_start" || !b) return;
      if (b.type === "server_tool_use" && b.name === "web_search") sendChunk({ phase: (lastPhase = "searching") });
      else if (b.type === "text") sendChunk({ phase: (lastPhase = "writing") });
    });
    stream.on("text", (_delta, snapshot) => {
      if (!sawArtifactPhase && snapshot.includes("```html")) {
        sawArtifactPhase = true;
        sendChunk({ phase: (lastPhase = "artifact") });
      }
    });
  };

  // Keep-alive: between phase transitions (e.g. a long web-search deliberation before any
  // text starts), the NDJSON stream can otherwise sit silent for 60-90+ seconds. That's long
  // enough for iOS Safari's own stream-idle handling (or an intermediate proxy) to decide the
  // connection stalled and kill it — surfacing as "Load failed" / "No response received" for
  // the participant with no server-side error at all. Re-sending the current phase every 5s
  // keeps bytes flowing without changing anything the client does with them.
  const heartbeat = setInterval(() => sendChunk({ phase: lastPhase }), 5000);

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
    const tools = WEB_SEARCH_ENABLED
      ? [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }]
      : undefined;

    console.log(`\n─── /api/chat → ${pid} · ${cond} · ${task} ${"─".repeat(20)}`);
    console.log(`[system prompt] (${system.map((s) => s.text.length).join(" + ")} chars)\n` + system.map((s) => s.text).join("\n---\n"));
    console.log(`[tools]`, tools ? tools.map((t) => t.name).join(", ") : "(none)");
    console.log(`[messages] (${messages?.length ?? 0} turns)`);
    for (const m of messages ?? []) console.log(`  ${m.role}: ${String(m.content).slice(0, 200)}${String(m.content).length > 200 ? "…" : ""}`);

    const stream = client.messages.stream({ model: MODEL, max_tokens: MAX_TOKENS, system, messages, tools }, { signal: ac.signal });
    wirePhaseEvents(stream);
    const msg = await stream.finalMessage();

    let text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    const searches = msg.content.filter((b) => b.type === "server_tool_use" && b.name === "web_search");
    console.log(`[response] ${text.length} chars · usage: ${JSON.stringify(msg.usage)}`);
    if (searches.length) console.log(`[web searches] ${searches.map((s) => JSON.stringify(s.input)).join(", ")}`);

    // Self-heal: if it searched but skipped the artifact it's expected to build, silently
    // ask it to finish — the participant never sees the failed first attempt. Retried at
    // most once, with a stricter search cap so it can't repeat the same failure loop.
    let retried = false;
    const expectsArtifact = cond === "interactive" || cond === "static";
    if (expectsArtifact && searches.length > 0 && extractArtifacts(text).length === 0) {
      retried = true;
      console.log(`[retry] searched but no artifact fence — retrying once (max_uses: 1)`);
      sendChunk({ phase: "retrying" });
      const retryTools = WEB_SEARCH_ENABLED
        ? [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }]
        : undefined;
      const retryStream = client.messages.stream(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages: [
            ...messages,
            { role: "assistant", content: text },
            { role: "user", content: "Continue — you searched but never wrote the ```html artifact. Write the complete artifact now. Output only the code fence (plus a brief one-line pointer to it), nothing else." },
          ],
          tools: retryTools,
        },
        { signal: ac.signal }
      );
      wirePhaseEvents(retryStream);
      const retryMsg = await retryStream.finalMessage();
      const retryText = retryMsg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      console.log(`[retry response] ${retryText.length} chars · usage: ${JSON.stringify(retryMsg.usage)}`);
      text = text + "\n\n" + retryText;
    }

    // Self-heal #2: the artifact fence is present, but its JS doesn't even parse (the
    // recurring stray-escape bug) — silently ask for a corrected version rather than
    // shipping a "looks fine, nothing works" artifact to the participant.
    let jsFixed = false;
    if (expectsArtifact) {
      const arts = extractArtifacts(text);
      const lastArt = arts[arts.length - 1];
      const jsError = lastArt ? findArtifactJsError(lastArt) : null;
      if (jsError) {
        jsFixed = true;
        console.log(`[retry] artifact JS fails to parse (${jsError}) — retrying once`);
        sendChunk({ phase: "retrying" });
        const fixStream = client.messages.stream(
          {
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system,
            messages: [
              ...messages,
              { role: "assistant", content: text },
              {
                role: "user",
                content: `The artifact's JavaScript has a syntax error and won't run at all for the student: "${jsError}". Rewrite the complete, corrected artifact — check every string for stray or double-escaped quotes. Output only the fixed \`\`\`html code fence, nothing else.`,
              },
            ],
          },
          { signal: ac.signal }
        );
        wirePhaseEvents(fixStream);
        const fixMsg = await fixStream.finalMessage();
        const fixText = fixMsg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        console.log(`[retry response] ${fixText.length} chars · usage: ${JSON.stringify(fixMsg.usage)}`);
        text = text + "\n\n" + fixText;
      }
    }
    console.log(`${"─".repeat(60)}\n`);

    logEvent({
      pid,
      cond,
      task,
      kind: "chat",
      type: "turn",
      data: { user: messages?.[messages.length - 1]?.content ?? null, assistant: text, usage: msg.usage, retried_after_search: retried || undefined, js_fixed: jsFixed || undefined },
    });
    await saveArtifacts(text, pid, cond, task);
    sendChunk({ done: true, text });
    res.end();
  } catch (e) {
    if (ac.signal.aborted) { if (!res.writableEnded) res.end(); return; } // cancelled by the participant
    console.error(e);
    sendChunk({ error: String(e?.message || e) });
    if (!res.writableEnded) res.end();
  } finally {
    clearInterval(heartbeat);
  }
});

// "userchoice" is a per-participant task: each pid gets their own researcher-entered
// scenario text rather than one shared across all sessions, so it's stored under a
// pid-scoped key instead of the plain task name. Every other task is unaffected.
const scenarioKey = (task, pid) => (task === "userchoice" && pid ? `userchoice:${pid}` : task);

// Scenario shown to a participant — determined by the task (and, for "userchoice", the pid).
// Returns the task instruction shown to participants: the researcher-saved text
// if one exists, otherwise the built-in default. `custom` flags which is in use,
// `default` carries the built-in so the editor can offer "reset to default".
app.get("/api/scenario", async (req, res) => {
  const task = String(req.query.task || "");
  const pid = req.query.pid ? String(req.query.pid) : null;
  const saved = await getScenario(scenarioKey(task, pid));
  const def = SCENARIOS[task] ?? null;
  res.json({ text: saved ?? def, default: def, custom: saved != null });
});

// Save (or clear) the researcher-edited instruction for a task (or a task+pid, for "userchoice").
app.post("/api/scenario/save", async (req, res) => {
  const { task, text, pid } = req.body || {};
  if (!task) return res.status(400).json({ error: "task required" });
  await setScenario(scenarioKey(task, pid), String(text ?? ""));
  res.json({ ok: true });
});
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

// Structured reflection / debrief data from the reworked step-by-step flow (experimental —
// see the `structured-flow` branch). Kept as its own `kind` so it's easy to pull apart from
// chat turns and raw telemetry in review.html.
app.post("/api/reflect", (req, res) => {
  const { pid, cond, task, type, data } = req.body || {};
  logEvent({ pid, cond, task, kind: "reflection", type: type ?? null, data: data ?? null });
  res.json({ ok: true });
});

// ---- Researcher: summary + artifacts + export ---------------------------
app.get("/api/summary", async (req, res) => res.json(await summary()));

// Delete all sessions with 0 chat turns and 0 artifacts (empty/telemetry-only).
app.post("/api/cleanup-empty", async (req, res) => res.json(await deleteEmptySessions()));

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

// ---- Researcher: cross-participant artifact gallery (/artifact-review) ------
// One payload for the whole gallery: every study-task artifact (no HTML), the prompt that
// produced it, per-pid userchoice scenarios, and researcher type codes. Reads only artifact
// + chat + scenario docs (never telemetry), cached for a few minutes. Any artifact file not
// on this machine's disk is materialized from the HTML we just read, so the gallery's many
// thumbnails hit the static files instead of the per-pid self-heal path (a full pid scan each).
const REVIEW_TASKS = new Set(["relocation", "studytool", "userchoice"]);
const isStudyPid = (pid) => /^[IST]\d+$/i.test(String(pid || ""));
// Firestore can't regex-match, so query the exact study pids (I1–I60, S1–S60, T1–T60);
// raise the cap if the study grows past it. Unused pids cost nothing beyond the query.
const STUDY_PIDS = ["I", "S", "T"].flatMap((p) => Array.from({ length: 60 }, (_, i) => p + (i + 1)));
let _reviewCache = null; // { t, v }
// Shared by /artifact-review and /process-review. `turns` (chat ts + prompt per session) stays
// server-side for the artifact gallery and is sent only to the process page, for its timeline.
async function reviewData(fresh) {
  if (_reviewCache && Date.now() - _reviewCache.t < 5 * 60 * 1000 && !fresh) return _reviewCache.v;
  const parse = (r) => (typeof r.data === "string" ? JSON.parse(r.data || "{}") : r.data || {});
  const keep = (r) => isStudyPid(r.pid) && REVIEW_TASKS.has(r.task);
  const [arts, chats, scen] = await Promise.all([eventsForPids("artifact", STUDY_PIDS, [...REVIEW_TASKS]), eventsForPids("chat", STUDY_PIDS, [...REVIEW_TASKS]), allScenarios()]);
  // Chat turns per session, oldest first — an artifact's prompt is the last turn logged before it.
  const turns = new Map();
  for (const c of chats.filter(keep)) {
    const k = `${c.pid}|${c.cond}|${c.task}`;
    if (!turns.has(k)) turns.set(k, []);
    const u = parse(c).user;
    turns.get(k).push({ ts: c.ts, user: typeof u === "string" ? u : u == null ? "" : JSON.stringify(u) });
  }
  for (const list of turns.values()) list.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const artifacts = arts.filter(keep).map((r) => {
    const d = parse(r);
    if (d.html && d.file) {
      const abs = path.join(__dirname, "data", d.file);
      if (!fs.existsSync(abs)) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, d.html);
      }
    }
    const title = ((d.html || "").match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || null;
    const prior = (turns.get(`${r.pid}|${r.cond}|${r.task}`) || []).filter((t) => t.ts <= r.ts);
    return { pid: r.pid, cond: r.cond, task: r.task, seq: d.seq, file: d.file, chars: d.chars, ts: r.ts, title, prompt: prior.at(-1)?.user ?? null };
  });
  const scenarios = { relocation: scen.relocation ?? SCENARIOS.relocation, studytool: scen.studytool ?? SCENARIOS.studytool, userchoice: {} };
  for (const [k, v] of Object.entries(scen)) if (k.startsWith("userchoice:")) scenarios.userchoice[k.slice(11)] = v;
  const v = { artifacts, scenarios, turns: Object.fromEntries(turns) };
  _reviewCache = { t: Date.now(), v };
  return v;
}
app.get("/api/artifact-review", async (req, res) => {
  const { artifacts, scenarios } = await reviewData(!!req.query.fresh);
  res.json({ artifacts, scenarios });
});
app.get("/api/artifact-codes", async (req, res) => res.json(await getCodes()));
// One annotator's coding of one artifact: codebook ids (see CODEBOOK in artifact-review.html),
// free text for any "Other" code, a needs-discussion flag, and a note.
app.post("/api/artifact-codes", async (req, res) => {
  const { coder, key, codes, other, flag, note } = req.body || {};
  if (!key || !/^[A-Za-z0-9_-]{1,30}$/.test(String(coder || ""))) return res.status(400).json({ error: "coder (letters/digits) and key required" });
  const data = {
    coder: String(coder),
    key: String(key),
    codes: [...new Set((Array.isArray(codes) ? codes : []).map(String))],
    other: Object.fromEntries(Object.entries(other || {}).map(([k, v]) => [String(k), String(v).slice(0, 500)]).filter(([, v]) => v.trim())),
    flag: !!flag,
    note: String(note ?? "").slice(0, 5000),
  };
  await setCode(`${data.coder}__${data.key}`, data);
  res.json({ ok: true });
});

// Codebook additions made while coding. kind: "group" (new category in a scheme), "item"
// (new code in a category; parent = category id) or "sub" (sub-code; parent = code id).
// Cached briefly; every write clears the cache so the other coder sees it on next fetch.
let _cbCache = null; // { t, v }
const codebookAdds = async () => {
  if (!_cbCache || Date.now() - _cbCache.t > 30000) _cbCache = { t: Date.now(), v: await getCodebookAdds() };
  return _cbCache.v;
};
app.get("/api/artifact-codebook", async (req, res) => res.json(await codebookAdds()));
app.post("/api/artifact-codebook", async (req, res) => {
  const { coder, scheme, kind, parent, label, id: editId } = req.body || {};
  const name = String(label ?? "").trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: "label required" });
  if (editId) { // rename an added code
    const cur = (await codebookAdds()).find((c) => c.id === editId);
    if (!cur) return res.status(404).json({ error: "not found" });
    await setCodebookAdd(editId, { ...cur, label: name, renamedBy: String(coder || "") });
    _cbCache = null;
    return res.json({ ok: true, id: editId });
  }
  if (!["group", "item", "sub"].includes(kind) || !/^[a-z]+$/.test(String(scheme || ""))) return res.status(400).json({ error: "bad kind/scheme" });
  if (kind !== "group" && !parent) return res.status(400).json({ error: "parent required" });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "code";
  const id = `x_${slug}_${Math.random().toString(36).slice(2, 6)}`;
  const doc = { id, scheme, kind, parent: kind === "group" ? null : String(parent), label: name, createdBy: String(coder || ""), created: new Date().toISOString() };
  await setCodebookAdd(id, doc);
  _cbCache = null;
  res.json({ ok: true, id, code: doc });
});
// Remove an added code — only if no coder has applied it and nothing is nested under it.
app.post("/api/artifact-codebook/delete", async (req, res) => {
  const id = String(req.body?.id || "");
  const adds = await codebookAdds();
  if (!adds.some((c) => c.id === id)) return res.status(404).json({ error: "not found" });
  if (adds.some((c) => c.parent === id)) return res.status(409).json({ error: "it has codes nested under it — remove those first" });
  const used = Object.values(await getCodes()).filter((x) => (x.codes || []).includes(id)).map((x) => x.coder);
  if (used.length) return res.status(409).json({ error: `still applied by ${[...new Set(used)].join(", ")} — untick it everywhere first` });
  await deleteCodebookAdd(id);
  _cbCache = null;
  res.json({ ok: true });
});

// ---- Researcher: sensemaking-process coding of session recordings (/process-review) ----
// Recordings live in Drive (drive.js); one video per pid covers both of that pid's tasks.
// Payload: videos by pid, plus each study session's artifacts and chat-turn times so the page
// can place them on the video timeline (no telemetry, same cached read as /artifact-review).
app.get("/api/process-review", async (req, res) => {
  let videos = {}, videoError = null;
  try {
    ({ videos } = await listVideos(!!req.query.fresh));
  } catch (e) {
    videoError = String(e?.message || e);
  }
  const { artifacts, scenarios, turns } = await reviewData(!!req.query.fresh);
  const sessions = {};
  const sess = (pid, cond, task) => (sessions[`${pid}|${task}`] ||= { pid, cond, task, artifacts: [], turns: [] });
  for (const a of artifacts) sess(a.pid, a.cond, a.task).artifacts.push({ seq: a.seq, ts: a.ts, file: a.file, title: a.title, prompt: a.prompt });
  for (const [k, list] of Object.entries(turns)) {
    const [pid, cond, task] = k.split("|");
    sess(pid, cond, task).turns = list.map((t) => ({ ts: t.ts, user: String(t.user ?? "").slice(0, 600) }));
  }
  res.json({ videos, sessions: Object.values(sessions), scenarios, videoError });
});
app.get("/api/drive-token", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store").json(await accessToken());
  } catch (e) {
    res.status(502).json({ error: String(e?.message || e) });
  }
});
app.get("/api/drive/:id", async (req, res) => {
  try {
    await streamFile(String(req.params.id), req, res);
  } catch (e) {
    console.error("drive stream failed:", e?.message || e);
    if (!res.headersSent) res.status(502).send("Drive error");
  }
});
app.get("/api/process-codes", async (req, res) => res.json(await getProcessCodes()));
// One coder's annotation of one session (pid × task): time segments on the recording, each a
// Pirolli & Card process (arrow) stage (see STAGES in process-review.html), pins for the loop's nodes
// and for markers, and a session label.
// Also { sync } docs: where the recording starts in wall-clock time, shared by all coders per pid.
const ID_RE = /^[A-Za-z0-9_-]{1,30}$/;
const num = (v) => (v == null || v === "" || !Number.isFinite(+v) ? null : Math.round(+v * 10) / 10);
// focus boxes on a screenshot: fractions of the video frame, at most 12 per item
const boxes = (a) => (Array.isArray(a) ? a : []).slice(0, 12).map((b) => {
  const f = (v) => Math.round(Math.max(0, Math.min(1, +v || 0)) * 1000) / 1000;
  return { x: f(b?.x), y: f(b?.y), w: f(b?.w), h: f(b?.h) };
}).filter((b) => b.w > 0 && b.h > 0);
app.post("/api/process-codes", async (req, res) => {
  const b = req.body || {};
  if (b.sync) {
    if (!ID_RE.test(String(b.pid || "")) || !Number.isFinite(+b.videoStart)) return res.status(400).json({ error: "pid, videoStart required" });
    await setProcessCode(`sync__${b.pid}`, { type: "sync", pid: String(b.pid), videoStart: Math.round(+b.videoStart), by: String(b.coder || "").slice(0, 30),
      clock: String(b.clock ?? "").slice(0, 40), at: num(b.at) });
    return res.json({ ok: true });
  }
  if (![b.coder, b.pid, b.task].every((x) => ID_RE.test(String(x || "")))) return res.status(400).json({ error: "coder, pid, task required (letters/digits)" });
  const segs = (Array.isArray(b.segs) ? b.segs : []).slice(0, 600).map((g) => ({
    id: String(g.id || "").slice(0, 20),
    t0: num(g.t0), t1: num(g.t1),
    stage: Number.isInteger(+g.stage) ? +g.stage : null,
    art: num(g.art),
    shot: num(g.shot),
    boxes: boxes(g.boxes), focus: String(g.focus ?? "").slice(0, 300),
    note: String(g.note ?? "").slice(0, 2000),
  })).filter((g) => g.t0 != null);
  // pins are moments, not spans: a node of the loop (stage 1/4/7/10/13/16, with the artifact that
  // provided it) or a marker (kind: narrowing, revisiting artifact, ...)
  const pins = (Array.isArray(b.pins) ? b.pins : []).slice(0, 600).map((x) => ({
    id: String(x.id || "").slice(0, 20), t: num(x.t), stage: Number.isInteger(+x.stage) && +x.stage > 0 ? +x.stage : null, art: num(x.art),
    kind: String(x.kind ?? "").trim().slice(0, 40), note: String(x.note ?? "").slice(0, 2000), shot: num(x.shot),
    boxes: boxes(x.boxes), focus: String(x.focus ?? "").slice(0, 300),
  })).filter((x) => x.t != null && (x.kind || x.stage));
  const data = { type: "session", coder: String(b.coder), pid: String(b.pid), task: String(b.task), segs, pins, label: String(b.label ?? "").slice(0, 40), note: String(b.note ?? "").slice(0, 5000) };
  await setProcessCode(`${data.coder}__${data.pid}__${data.task}`, data);
  res.json({ ok: true });
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
