// Shared by artifact-review.html and artifact-compare.html: the agreed codebook plus codes the
// annotators add while coding (stored in /api/artifact-codebook).
// Codebook agreed in discussion. Artifact components apply to every artifact; interactions
// only to the interactive condition (I#). Ids are stored, so relabel freely but keep ids stable.
const CODEBOOK = [
  { id: "artifact", label: "Artifact components", groups: [
    { id: "rep", label: "Representations", items: [["rep.diagram", "Diagram / map"], ["rep.chart", "Charts / graphs"], ["rep.table", "Tables"], ["rep.timeline", "Timelines, steps"], ["rep.other", "Other"]] },
    { id: "rank", label: "Rankings / judgements", items: [["rank.score", "Numerical anchors / score"], ["rank.ordinal", "Ordinal rankings"], ["rank.tags", "Categorical tags"], ["rank.other", "Other"]] },
    { id: "desc", label: "Descriptions / evidence", items: [["desc.dims", "Text descriptions of dimensions"], ["desc.source", "Source"], ["desc.cards", "Evidence cards"], ["desc.other", "Other"]] },
  ] },
  { id: "interaction", label: "Interactions", onlyCond: "interactive", groups: [
    { id: "learn", label: "Learning / quizzes", items: [["learn.predict", "Predict then reveal"], ["learn.quiz", "Quizzes"]] },
    { id: "hide", label: "Hide / reveal information", items: [["hide.reveal", "Click-to-reveal"], ["hide.expand", "Click-to-expand"]] },
    { id: "org", label: "Organize information", items: [["org.sort", "Sorting"], ["org.filter", "Filtering"]] },
    { id: "move", label: "Move through sections", items: [["move.toggle", "Toggle views"]] },
    { id: "score", label: "Select criteria → score items", hint: "compresses information", items: [["score.1to1", "One dimension → one output"], ["score.1toN", "One dimension → multiple outputs"], ["score.Nto1", "Multiple dimensions → one output"], ["score.NtoN", "Multiple dimensions → multiple outputs"]] },
    { id: "sim", label: "Simulations", items: [["sim", "Simulations"]] },
    { id: "iother", label: "Other", items: [["iother", "Other"]] },
  ] },
  // Pirolli & Card (2005) sensemaking loop nodes (boxes in the figure, numbered as in
  // process-review.html) the artifact embodies — tick every one that applies.
  { id: "sensemaking", label: "Sensemaking loop nodes", groups: [
    { id: "forage", label: "Foraging loop", items: [["sm.1", "1 · External data sources"], ["sm.4", "4 · Shoebox"], ["sm.7", "7 · Evidence file"]] },
    { id: "smloop", label: "Sensemaking loop", items: [["sm.10", "10 · Schema"], ["sm.13", "13 · Hypothesis"], ["sm.16", "16 · Presentation"]] },
  ] },
];
// The working codebook = CODEBOOK above + codes the annotators added while coding
// (new categories, new codes in a category, or sub-codes of a code). Sub-codes roll up:
// ticking one ticks its parent too, so analysis can always collapse back to the parent.
let BOOK = [], ADDS = [];
const CODE = {};        // id -> { label (full path), short, group, scheme, parent, custom, by }
const GROUP_ITEMS = {}; // group id -> every code id inside it (sub-codes included)
const DESC = {};        // code id -> [itself, ...its sub-codes]
// Built-in codes / categories removed in the codebook editor (artifact-compare) — kind "hide" entries.
let HIDDEN = new Set();
function buildBook() {
  HIDDEN = new Set(ADDS.filter((c) => c.kind === "hide").map((c) => c.target));
  BOOK = CODEBOOK.map((sc) => ({ ...sc, groups: sc.groups.filter((g) => !HIDDEN.has(g.id)).map((g) => {
    const solo = g.items.length === 1 && g.items[0][0] === g.id;
    return { ...g, solo, items: g.items.filter(([id]) => !HIDDEN.has(id)).map(([id, label]) => ({ id, label, subs: [] })) };
  }) }));
  const placed = new Set();
  // Added codes can nest under other added codes, so place them in passes until stable.
  for (let pass = 0; pass < 4; pass++) for (const c of ADDS) {
    if (placed.has(c.id)) continue;
    const sc = BOOK.find((x) => x.id === c.scheme);
    if (!sc) continue;
    const node = { id: c.id, label: c.label, custom: true, by: c.createdBy, subs: [] };
    if (c.kind === "group") { sc.groups.push({ id: c.id, label: c.label, custom: true, by: c.createdBy, items: [] }); placed.add(c.id); continue; }
    const g = sc.groups.find((x) => x.id === c.parent);
    if (c.kind === "item" && g) { g.items.push(node); placed.add(c.id); continue; }
    const parentItem = sc.groups.flatMap((x) => x.items).find((x) => x.id === c.parent);
    if (c.kind === "sub" && parentItem) { parentItem.subs.push(node); placed.add(c.id); }
  }
  for (const o of [CODE, GROUP_ITEMS, DESC]) for (const k of Object.keys(o)) delete o[k];
  for (const sc of BOOK) for (const g of sc.groups) {
    GROUP_ITEMS[g.id] = [];
    for (const it of g.items) {
      const base = g.solo && it.id === g.id ? it.label : `${g.label} › ${it.label}`;
      CODE[it.id] = { label: base, short: it.label === "Other" ? `${g.label.split(" ")[0]}: other` : it.label, group: g.id, scheme: sc.id, parent: null, custom: !!it.custom, by: it.by };
      DESC[it.id] = [it.id];
      GROUP_ITEMS[g.id].push(it.id);
      for (const sub of it.subs) {
        CODE[sub.id] = { label: `${base} › ${sub.label}`, short: `${it.label} › ${sub.label}`, group: g.id, scheme: sc.id, parent: it.id, custom: true, by: sub.by };
        DESC[sub.id] = [sub.id];
        DESC[it.id].push(sub.id);
        GROUP_ITEMS[g.id].push(sub.id);
      }
    }
  }
}
buildBook();
const isOther = (id) => id.endsWith(".other") || id === "iother";
async function loadBook() {
  try {
    const r = await fetch("/api/artifact-codebook");
    if (!r.ok) return false;
    const next = await r.json();
    const changed = JSON.stringify(next) !== JSON.stringify(ADDS);
    ADDS = next;
    if (changed) buildBook();
    return changed;
  } catch { return false; }
}
