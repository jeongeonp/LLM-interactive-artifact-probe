// Nightly backup of the coding data in Firestore to local JSON files (run by launchd, see
// ~/Library/LaunchAgents/edu.ucsd.artifactprobe.backup.plist). Writes backups/<date>/<collection>.json
// and keeps the last KEEP days. Study event logs aren't included (large, and no longer edited).
//   node backup-codes.mjs
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "fs";

const COLLECTIONS = ["processCodes", "processCodesHistory", "artifactCodes", "artifactCodebook", "scenarios"];
const KEEP = 30;
const root = new URL("./backups/", import.meta.url);

initializeApp({ credential: cert(JSON.parse(readFileSync(new URL("./serviceAccountKey.json", import.meta.url)))) });
const db = getFirestore();

const day = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
const dir = new URL(`${day}/`, root);
mkdirSync(dir, { recursive: true });
for (const name of COLLECTIONS) {
  const snap = await db.collection(name).get();
  writeFileSync(new URL(`${name}.json`, dir), JSON.stringify(Object.fromEntries(snap.docs.map((d) => [d.id, d.data()])), null, 1));
  console.log(`${new Date().toISOString()} ${day} ${name}: ${snap.size} docs`);
}
for (const old of readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(0, -KEEP)) rmSync(new URL(`${old}/`, root), { recursive: true });
