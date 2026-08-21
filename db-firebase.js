// Firebase / Firestore adapter — a drop-in replacement for db.js.
//
// SETUP:
//   1. npm install firebase-admin            (done)
//   2. Firebase console → Firestore Database → create
//   3. Service accounts → Generate new private key → save as serviceAccountKey.json here
//   4. server.js already imports from "./db-firebase.js"
//
// Queries use only single-field filters and sort/aggregate in memory, so NO
// composite Firestore indexes are required. Fine for study-scale data.
// The `events` collection mirrors the old SQLite `events` table 1:1.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { readFileSync } from "fs";

const sa = JSON.parse(readFileSync(new URL("./serviceAccountKey.json", import.meta.url)));
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const events = db.collection("events");
// Running per-session aggregates (pid|cond|task) so summary() reads a few dozen
// docs instead of scanning the whole events collection. This is the main quota fix.
const aggCol = db.collection("agg");

// ---- Read cache: dedupe Firestore reads within a short window to conserve quota.
// A page load calls scenario + history + artifacts (all one pid) → 1 read, not 3.
// Researcher refreshes reuse the cached collection instead of re-scanning it.
const CACHE_TTL = 15000; // ms
const _cache = new Map(); // key -> { t, v }
const cacheGet = (k) => { const h = _cache.get(k); return h && Date.now() - h.t < CACHE_TTL ? h.v : null; };
const cacheSet = (k, v) => _cache.set(k, { t: Date.now(), v });

async function pidDocs(pid) {
  const key = "pid:" + pid;
  const hit = cacheGet(key);
  if (hit) return hit;
  const snap = await events.where("pid", "==", pid).get();
  const docs = snap.docs.map((d) => d.data());
  cacheSet(key, docs);
  return docs;
}
async function allDocs() {
  const hit = cacheGet("all");
  if (hit) return hit;
  const snap = await events.get();
  const docs = snap.docs.map((d) => d.data());
  cacheSet("all", docs);
  return docs;
}

// Firestore doc ids can't contain "/". Build a safe id for the aggregate doc.
const aggId = (pid, cond, task) =>
  [pid ?? "", cond ?? "", task ?? ""].map((s) => String(s).replace(/[/#]/g, "_")).join("__");
const _aggInit = new Set(); // keys we've ensured first_ts for, this process

async function bumpAgg({ pid, cond, task, kind, ts }) {
  const id = aggId(pid, cond, task);
  const ref = aggCol.doc(id);
  const inc = {
    pid: pid ?? null, cond: cond ?? null, task: task ?? null,
    events: FieldValue.increment(1),
    chat_turns: FieldValue.increment(kind === "chat" ? 1 : 0),
    artifacts: FieldValue.increment(kind === "artifact" ? 1 : 0),
    interactions: FieldValue.increment(kind === "telemetry" ? 1 : 0),
    last_ts: ts,
  };
  // Set first_ts exactly once per session, guarded so we read at most once per
  // key per process restart (a few reads total) rather than on every event.
  if (!_aggInit.has(id)) {
    _aggInit.add(id);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      tx.set(ref, snap.exists ? inc : { ...inc, first_ts: ts }, { merge: true });
    });
  } else {
    await ref.set(inc, { merge: true });
  }
}

export async function logEvent({ pid, cond, task, kind, type, data }) {
  const ts = new Date().toISOString();
  try {
    await events.add({
      ts,
      pid: pid ?? null,
      cond: cond ?? null,
      task: task ?? null,
      kind: kind ?? null,
      type: type ?? null,
      data: data == null ? null : JSON.stringify(data), // JSON string, like SQLite
    });
    _cache.delete("pid:" + pid); // this participant's cached reads must reflect the write
    await bumpAgg({ pid, cond, task, kind, ts });
  } catch (e) {
    console.error("logEvent (firestore) failed:", e?.message || e);
  }
}

// All reads fail safe: log and return an empty result rather than throwing,
// so a Firestore hiccup never crashes a live session.
function onReadError(e, fallback) {
  console.error("firestore read failed:", e?.message || e);
  return fallback;
}

// All events (optionally for one pid, and optionally one cond), oldest-first, with a synthetic id.
export async function allEvents(pid, cond, task) {
  try {
    let rows = pid ? await pidDocs(pid) : await allDocs();
    if (pid && cond != null && cond !== "") rows = rows.filter((e) => e.cond === cond);
    if (pid && task != null && task !== "") rows = rows.filter((e) => e.task === task);
    return rows
      .slice() // don't mutate the cached array
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
      .map((e, i) => ({ id: i + 1, ...e }));
  } catch (e) {
    return onReadError(e, []);
  }
}

// Just the COUNT of saved artifacts — a Firestore aggregation query, billed as
// ~1 read no matter how many artifacts exist (it never fetches the docs). Lets
// the admin page show the number without loading (or rendering) any artifact.
export async function countAllArtifacts() {
  try {
    const snap = await events.where("kind", "==", "artifact").count().get();
    return snap.data().count;
  } catch (e) {
    return onReadError(e, 0);
  }
}

// Artifact events only. With a pid we reuse the cached per-pid docs; WITHOUT a
// pid (the admin "all artifacts" table) we query kind=="artifact" directly so we
// read only the handful of artifact docs, never the whole (heartbeat-heavy) set.
export async function artifactEvents(pid, cond, task) {
  try {
    let rows;
    if (pid) {
      rows = await pidDocs(pid);
      if (cond != null && cond !== "") rows = rows.filter((e) => e.cond === cond);
      if (task != null && task !== "") rows = rows.filter((e) => e.task === task);
      rows = rows.filter((e) => e.kind === "artifact");
    } else {
      const snap = await events.where("kind", "==", "artifact").get();
      rows = snap.docs.map((d) => d.data());
    }
    return rows
      .slice()
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
      .map((e, i) => ({ id: i + 1, ...e }));
  } catch (e) {
    return onReadError(e, []);
  }
}

// Delete every session (pid+cond+task) with no chat turns and no artifacts,
// including its event docs and its aggregate doc. Occasional cleanup, so a full
// scan is acceptable.
export async function deleteEmptySessions() {
  try {
    const all = await allDocs();
    const g = new Map();
    for (const e of all) {
      const key = (e.pid ?? "") + "|" + (e.cond ?? "") + "|" + (e.task ?? "");
      if (!g.has(key)) g.set(key, { pid: e.pid ?? null, cond: e.cond ?? null, task: e.task ?? null, chat: 0, arts: 0 });
      const r = g.get(key);
      if (e.kind === "chat") r.chat++;
      if (e.kind === "artifact") r.arts++;
    }
    const empties = [...g.values()].filter((s) => s.chat === 0 && s.arts === 0);
    let deleted = 0;
    for (const s of empties) {
      const snap = await events.where("pid", "==", s.pid).get();
      const refs = snap.docs
        .filter((d) => { const x = d.data(); return (x.cond ?? null) === s.cond && (x.task ?? null) === s.task; })
        .map((d) => d.ref);
      deleted += refs.length;
      refs.push(aggCol.doc(aggId(s.pid, s.cond, s.task))); // also drop the aggregate
      for (let i = 0; i < refs.length; i += 400) {
        const batch = db.batch();
        refs.slice(i, i + 400).forEach((ref) => batch.delete(ref));
        await batch.commit();
      }
    }
    _cache.clear();
    return { sessions: empties.length, events: deleted };
  } catch (e) {
    console.error("deleteEmptySessions (firestore) failed:", e?.message || e);
    return { sessions: 0, events: 0, error: String(e?.message || e) };
  }
}

export async function summary() {
  try {
    // Fast path: read the pre-computed per-session aggregates (a few dozen docs),
    // not the whole events collection. This is what keeps the dashboard cheap.
    const snap = await aggCol.get();
    if (!snap.empty) {
      return snap.docs
        .map((d) => d.data())
        .sort((a, b) => String(a.pid).localeCompare(String(b.pid)));
    }
    // Fallback for data logged before aggregates existed: scan once and backfill.
    return await summaryFromEvents();
  } catch (e) {
    return onReadError(e, []);
  }
}

// One-time full scan, used only when the `agg` collection is empty (legacy data).
async function summaryFromEvents() {
  const m = new Map();
  for (const e of await allDocs()) {
    const key = (e.pid ?? "") + "|" + (e.cond ?? "") + "|" + (e.task ?? "");
    if (!m.has(key)) m.set(key, { pid: e.pid, cond: e.cond, task: e.task, events: 0, chat_turns: 0, artifacts: 0, interactions: 0, first_ts: e.ts, last_ts: e.ts });
    const r = m.get(key);
    r.events++;
    if (e.kind === "chat") r.chat_turns++;
    if (e.kind === "artifact") r.artifacts++;
    if (e.kind === "telemetry") r.interactions++;
    if (e.ts < r.first_ts) r.first_ts = e.ts;
    if (e.ts > r.last_ts) r.last_ts = e.ts;
  }
  return [...m.values()].sort((a, b) => String(a.pid).localeCompare(String(b.pid)));
}

export async function countArtifacts(pid, cond, task) {
  try {
    if (!pid) return 0;
    return (await pidDocs(pid)).reduce(
      (n, e) => n + (e.kind === "artifact" && e.cond === (cond ?? null) && e.task === (task ?? null) ? 1 : 0),
      0
    );
  } catch (e) {
    return onReadError(e, 0);
  }
}

// Researcher-editable task instruction, stored in the shared DB so every machine
// (and every participant session) sees the same edited text. One doc per task.
const scenariosCol = db.collection("scenarios");
export async function getScenario(task) {
  try {
    const d = await scenariosCol.doc(String(task ?? "")).get();
    return d.exists ? d.data().text ?? null : null;
  } catch (e) {
    return onReadError(e, null);
  }
}
export async function setScenario(task, text) {
  try {
    await scenariosCol.doc(String(task ?? "")).set({ text, updated: new Date().toISOString() });
  } catch (e) {
    console.error("setScenario (firestore) failed:", e?.message || e);
  }
}
