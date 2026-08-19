// One-off: register the 8 gallery artifacts as a "demo" participant so they
// show up in review.html (transcript + Artifacts tab + Open/Preview).
// Run once:  node seed-demo.mjs
import { logEvent } from "./db-firebase.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, "public", "demo-artifacts");
const PID = "demo", COND = "demo";

const FILES = [
  ["Word cloud — what residents talk about", "1-wordcloud.html"],
  ["Affinity board — cluster the voices", "2-affinity.html"],
  ["Claim board — supports / contradicts", "3-claim.html"],
  ["Annotated rent timeline", "4-timeline.html"],
  ["Dual-layer neighborhood map", "5-dualmap.html"],
  ["Aggregate ↔ story slider", "6-aggregate.html"],
  ["Highlight & code the reviews", "7-code-reader.html"],
  ["Causal concept map", "8-causalmap.html"],
];

const SCENARIO = `Maya Torres (34, ICU nurse) + Josh (remote SWE) + daughter Elena (7, mild ADHD) are relocating from a car-dependent Bay Area suburb on $95k. Choose where within Baltimore / Philadelphia / Minneapolis / Chicago to live: rent ≤ $2,200/mo, ≤25 min to a major hospital, an elementary school with real learning-support (not just high test scores), a walkable neighborhood with community, and some cultural/economic diversity.`;

await logEvent({ pid: PID, cond: COND, kind: "scenario", type: "set", data: { text: SCENARIO } });
await logEvent({
  pid: PID, cond: COND, kind: "chat", type: "turn",
  data: { user: "Show me different ways to make sense of this — beyond charts.",
          assistant: "Here are eight interactive artifacts that blend the numbers with residents' voices for Maya's decision." },
});

for (let i = 0; i < FILES.length; i++) {
  const [title, file] = FILES[i];
  const chars = fs.statSync(path.join(DIR, file)).size;
  await logEvent({
    pid: PID, cond: COND, kind: "artifact", type: "created",
    data: { seq: i + 1, file: "/demo-artifacts/" + file, chars, title },
  });
}

console.log(`Seeded ${FILES.length} demo artifacts under pid="${PID}". Open /review.html → select "demo".`);
process.exit(0);
