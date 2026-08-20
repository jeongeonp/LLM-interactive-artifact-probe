// Connection diagnostic. Run on ANY machine:  node diag.mjs
// Tells you: which Firebase project this machine writes to, whether a write
// actually lands, and which participant IDs already exist in that database.
// If two machines print DIFFERENT project_id, they are using different databases.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "fs";

console.log("DB_BACKEND env =", process.env.DB_BACKEND || "(unset → Firestore)");

let sa;
try {
  sa = JSON.parse(readFileSync(new URL("./serviceAccountKey.json", import.meta.url)));
} catch (e) {
  console.error("\n❌ serviceAccountKey.json missing or unreadable:", e.message);
  console.error("   Without it this machine cannot reach Firestore.\n");
  process.exit(1);
}
console.log("project_id   =", sa.project_id);
console.log("client_email =", sa.client_email);

initializeApp({ credential: cert(sa) });
const db = getFirestore();
const events = db.collection("events");

// 1) Prove a WRITE lands.
try {
  const ref = await events.add({
    ts: new Date().toISOString(), pid: "__diag__", cond: null, task: null,
    kind: "telemetry", type: "diag", data: null,
  });
  console.log("\n✅ Write OK — created test doc", ref.id);
  await ref.delete();
  console.log("   (test doc deleted)");
} catch (e) {
  console.error("\n❌ Write FAILED:", e.message);
}

// 2) Show which participants exist here (so you can compare across machines).
try {
  const snap = await events.get();
  const pids = {};
  snap.forEach((d) => { const p = d.data().pid || "(none)"; pids[p] = (pids[p] || 0) + 1; });
  console.log(`\nThis database has ${snap.size} events across these participants:`);
  for (const [p, n] of Object.entries(pids).sort()) console.log(`   ${p}: ${n} events`);
} catch (e) {
  console.error("\n❌ Read FAILED:", e.message);
}
process.exit(0);
