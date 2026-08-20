// One-time backfill: build the `agg` (per-session summary) collection from the
// existing `events` collection. Run ONCE after deploying the aggregate summary.
//
//   node backfill-agg.mjs
//
// Costs a single full scan of `events` (reads = number of event docs) plus one
// write per pid|cond|task session. After this, summary() reads only `agg`.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "fs";

const sa = JSON.parse(readFileSync(new URL("./serviceAccountKey.json", import.meta.url)));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const aggId = (pid, cond, task) =>
  [pid ?? "", cond ?? "", task ?? ""].map((s) => String(s).replace(/[/#]/g, "_")).join("__");

const snap = await db.collection("events").get();
console.log(`Scanned ${snap.size} event docs.`);

const m = new Map();
for (const d of snap.docs) {
  const e = d.data();
  const key = aggId(e.pid, e.cond, e.task);
  if (!m.has(key))
    m.set(key, { pid: e.pid ?? null, cond: e.cond ?? null, task: e.task ?? null,
      events: 0, chat_turns: 0, artifacts: 0, interactions: 0, first_ts: e.ts, last_ts: e.ts });
  const r = m.get(key);
  r.events++;
  if (e.kind === "chat") r.chat_turns++;
  if (e.kind === "artifact") r.artifacts++;
  if (e.kind === "telemetry") r.interactions++;
  if (e.ts && e.ts < r.first_ts) r.first_ts = e.ts;
  if (e.ts && e.ts > r.last_ts) r.last_ts = e.ts;
}

let n = 0;
for (const [key, r] of m) {
  await db.collection("agg").doc(key).set(r, { merge: true });
  n++;
  console.log(`  ${key}: ${r.events} events, ${r.artifacts} artifacts`);
}
console.log(`Backfilled ${n} session aggregate(s). Done.`);
process.exit(0);
