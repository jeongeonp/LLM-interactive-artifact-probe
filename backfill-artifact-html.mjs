// One-time backfill: copy each already-saved artifact's HTML from local disk INTO
// its Firestore event doc, so other machines (a collaborator's review.html) can
// re-materialize the file. Run ONCE, on the machine that has data/artifacts/.
//
//   node backfill-artifact-html.mjs
//
// Skips artifacts that already have html stored, or whose local file is missing.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ART_DIR = path.join(__dirname, "data", "artifacts");
const MAX = 900000; // Firestore 1MB doc guard

const sa = JSON.parse(readFileSync(new URL("./serviceAccountKey.json", import.meta.url)));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const snap = await db.collection("events").where("kind", "==", "artifact").get();
console.log(`Found ${snap.size} artifact event(s).`);

let updated = 0, skipped = 0, missing = 0, toobig = 0;
for (const doc of snap.docs) {
  const e = doc.data();
  const d = e.data ? JSON.parse(e.data) : {};
  if (d.html) { skipped++; continue; }                       // already has HTML
  const rel = (d.file || "").replace(/^\/artifacts\//, "");  // pid/fname
  const abs = path.join(ART_DIR, rel);
  if (!rel || !existsSync(abs)) { missing++; continue; }     // no local file
  const html = readFileSync(abs, "utf8");
  if (html.length > MAX) { toobig++; console.log(`  too big, skipped: ${d.file}`); continue; }
  d.html = html;
  await doc.ref.update({ data: JSON.stringify(d) });
  updated++;
  console.log(`  + ${d.file} (${html.length} chars)`);
}
console.log(`Done. updated=${updated} already-had=${skipped} missing-file=${missing} too-big=${toobig}`);
process.exit(0);
