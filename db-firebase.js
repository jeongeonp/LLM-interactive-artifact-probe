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
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "fs";

const sa = JSON.parse(readFileSync(new URL("./serviceAccountKey.json", import.meta.url)));
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const events = db.collection("events");

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

export async function logEvent({ pid, cond, task, kind, type, data }) {
  try {
    await events.add({
      ts: new Date().toISOString(),
      pid: pid ?? null,
      cond: cond ?? null,
      task: task ?? null,
      kind: kind ?? null,
      type: type ?? null,
      data: data == null ? null : JSON.stringify(data), // JSON string, like SQLite
    });
    _cache.delete("pid:" + pid); // this participant's cached reads must reflect the write
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

export async function summary() {
  try {
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
  } catch (e) {
    return onReadError(e, []);
  }
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

// Unused now (scenarios are task-derived server-side) — kept for interface parity.
export async function getScenario() { return null; }
