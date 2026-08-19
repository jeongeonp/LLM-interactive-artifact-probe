// One-time: copy P03's events from local SQLite into Firestore, preserving
// original timestamps. Artifact HTML files stay on local disk and are served
// by the /artifacts route regardless of backend, so Open/Preview still works.
// Run once:  node migrate-p03.mjs
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID = "P03";

const sa = JSON.parse(readFileSync(new URL("./serviceAccountKey.json", import.meta.url)));
initializeApp({ credential: cert(sa) });
const store = getFirestore();
const events = store.collection("events");

// Guard: don't run twice.
const existing = await events.where("pid", "==", PID).limit(1).get();
if (!existing.empty) {
  console.error(`Firestore already has ${PID} events — aborting to avoid duplicates.`);
  process.exit(1);
}

// Read from SQLite, preserving original ts/kind/type/data.
const db = new DatabaseSync(path.join(__dirname, "data", "probe.db"));
const rows = db.prepare("SELECT ts, pid, cond, kind, type, data FROM events WHERE pid = ? ORDER BY id").all(PID);
console.log(`Read ${rows.length} ${PID} events from SQLite.`);

let n = 0;
for (let i = 0; i < rows.length; i += 450) {
  const batch = store.batch();
  for (const r of rows.slice(i, i + 450)) {
    batch.set(events.doc(), { ts: r.ts, pid: r.pid, cond: r.cond, kind: r.kind, type: r.type, data: r.data });
    n++;
  }
  await batch.commit();
  console.log(`  committed ${n}/${rows.length}`);
}
console.log(`Done. Migrated ${n} ${PID} events to Firestore. Open /review.html (default backend) → select ${PID}.`);
process.exit(0);
