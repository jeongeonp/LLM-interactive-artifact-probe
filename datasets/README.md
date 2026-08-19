# Task datasets

Drop the data you want the probe to ground its artifacts in here, one folder per task:

```
datasets/
  sd/           ← used when the "SD affordability" task is selected
  relocation/   ← used when the "Relocation" task is selected
```

**How it's used:** when a participant runs a task, the server reads *every file*
in that task's folder, concatenates them (each prefixed with its filename), and
injects them into the model's context as a cached system block. The model is
told to base its facts and artifacts on this data and to say so when the data
doesn't cover something. The folder name is the `dataset` key set by the
launcher preset (`sd`, `relocation`).

**Formats:** plain text works best — `.md`, `.csv`, `.txt`, `.json`, `.tsv`.
Pair a compact **quantitative** file (aggregated stats, not raw million-row
dumps) with a **qualitative** corpus (resident quotes, reviews, interview
snippets). That pairing is what forces quant+qual sensemaking.

## How much data fits?

- **Hard ceiling:** the model (Claude Sonnet 5) has a **1,000,000-token** context
  window ≈ ~750k words ≈ ~4 MB of plain text. You will not hit this.
- **Practical target:** keep each task's dataset **under ~100k tokens**
  (~400 KB of text / ~65k words). Even **20–50k tokens** is plenty for a rich
  quant+qual task, and keeps responses fast.
- The dataset is sent every turn but **prompt-cached** (≈0.1× cost after the
  first turn), so a larger file mainly costs latency on turn 1, not per-turn $$.
- Rough conversion: **1 token ≈ 4 characters ≈ ¾ of a word.** So a 200 KB file
  ≈ ~50k tokens. A 50-row CSV + 100 quotes is only a few thousand tokens.

**Tip:** summarize/aggregate big CSVs before dropping them in (e.g., median rent
by neighborhood, not every listing). Raw giant files waste context and slow
turn 1 without adding much the model can actually use in an artifact.
