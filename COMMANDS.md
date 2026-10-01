# News-story dedupe — commands

Finds duplicate news stories across the news spaces and proposes deletions,
without anyone assembling a CSV first. Nothing is ever deleted directly: the
tool creates **on-chain proposals** that name exactly what they remove, and an
editor accepts or rejects them in Geo. Runs with **bun** (the interactive
publish step uses bun's `prompt()`).

## Setup

`.env` in the repo root needs three keys:

```
PK_SW = "0x<private key>"        # from https://www.geobrowser.io/export-wallet
DEMO_SPACE_ID = "<personal space id>"
ANTHROPIC_API_KEY = "sk-ant-…"   # the scan judges candidates with Claude
```

## The two commands

The workflow is deliberately split in two, so what gets proposed is exactly
what you reviewed — the plan file is the contract between the steps.

```bash
# 1. SCAN — find duplicates, judge them, write a plan. Proposes nothing.
bun run 14_dedupe_news_stories.ts

# 2. PUBLISH — read the latest plan, show it, ask how many to propose per space.
bun run 14_dedupe_news_stories.ts --publish
```

The scan prints a per-space summary and writes
`output/dedupe_news/plan-<timestamp>.json`. The publish step lists each pair
(`delete …` / `keep …` with confidence and evidence), then asks
`How many to propose? [N, 0 to skip]` per space — answering `0` skips the
space, so you can walk through the whole flow without proposing anything.

## Common variations

```bash
# One space only
bun run 14_dedupe_news_stories.ts --spaces health

# Only stories published in a date range
bun run 14_dedupe_news_stories.ts --from 2026-07-01 --to 2026-07-31

# Several spaces
bun run 14_dedupe_news_stories.ts --spaces crypto,us-politics

# Free dry look: count candidates, no Claude calls, no judging (~seconds)
bun run 14_dedupe_news_stories.ts --spaces health --detect-only --no-sweep

# Publish a specific plan instead of the newest one
bun run 14_dedupe_news_stories.ts --publish --plan output/dedupe_news/plan-20260811.json
```

Known spaces: `crypto`, `ai`, `world-affairs`, `health`, `us-politics`
(default = all five).

## Flags

| flag | default | meaning |
|---|---|---|
| `--spaces a,b` | all five | which spaces to scan / publish |
| `--publish` | off | propose from the latest (or `--plan`) plan file |
| `--plan <path>` | newest plan | which plan file `--publish` reads |
| `--detect-only` | off | stop after counting candidates, judge nothing |
| `--no-sweep` | off | skip the Claude window sweep (free, but finds only ~29% of known duplicates — fine for a quick look, not for a real run) |
| `--from <date>` | none | only scan stories published on/after this date, e.g. `2026-07-01` |
| `--to <date>` | none | only scan stories published on/before this date (inclusive) |
| `--similarity <x>` | 0.5 | title-similarity threshold for the free candidate pass |
| `--description-similarity <x>` | 0.6 | Description overlap that qualifies a pair on its own |
| `--summary-similarity <x>` | 0.35 | Summary overlap that qualifies a pair on its own. Lower than the Description bar because Summary text runs about twice as long |
| `--max-pairs <n>` | 1500 | cap on pairs sent to the judge; a warning tells you if candidates were left unjudged |
| `--yes` | off | publish without prompting (for cron — never for a first run) |
| `--dry-run` | off | with `--publish`: build the proposal, write the ops and manifest, send nothing. The way to read a claim move before it exists on chain |

## What it will and won't do

- **Never deletes a claim that has been engaged with.** If a claim has an
  upvote, a downvote, or a position in someone's ranking submission, it does not
  disappear. Votes and rank positions are tied to an entity id and cannot be
  moved, so deleting the claim destroys them.
  - One copy of the pair engaged, the other not → the engaged one is kept.
  - **Both engaged** → the loser's engaged claims are **moved onto the keeper**,
    into the collection block that already covers their subject, and only then
    is the duplicate story deleted. If a moved claim duplicates a claim the
    keeper already has, and that one is untouched, the untouched copy is
    replaced by the engaged one. If both copies of a claim are engaged, or a
    claim has nowhere sensible to go, the whole pair goes to
    `needs-review.csv` instead — no partial moves.
- **What you see when it runs.** Every pair is printed in full: both headlines
  untruncated, publish dates, claim counts, the Description *and* the Summary
  for each story, what happens to the claims, the confidence and the judge's
  reasoning — with a `geobrowser.io` link per story. The same content is written
  to `output/dedupe_news/report-<timestamp>.html`, which is the one to open or
  forward when comparing long summaries side by side.
- **Detection reads summaries, not just headlines.** Two write-ups of the same
  event often share no distinctive headline word; the summary is what makes
  them recognisable. Both the candidate pass and the model sweep use it.
  Note there are **two** fields and both are compared: **Description** (a short
  blurb, ~25 words) and **Summary** (the fuller write-up, ~50 words). They catch
  different pairs — measured across three spaces, each found duplicates the
  other missed — so a pair qualifies on either.
- **Always a full scan, over the whole history.** There is no date window and
  no "recent only" mode: every story is compared against every other in its
  space, so a story re-injected months after its twin is still caught. Repeat
  runs stay cheap because the caches are keyed on story text, not on dates —
  see below.
- **Pairs only.** Exactly one story of a pair is deleted, the other kept
  (keeper = engaged claims → more backlinks → more relations → older). Clusters of 3+ are
  **never touched** — the 2026-07 audit showed those are rolling coverage of
  an evolving story, not duplicates. They go to
  `output/dedupe_news/needs-review.csv`; add a `delete` column marked `yes`
  and feed it to `13_delete_news_stories.ts` if any truly are duplicates.
- **Cheap similarity finds candidates, Claude confirms them.** Every candidate
  pair is judged individually with both full descriptions before it enters the
  plan. (The old editor-assembled candidate list was ~85% false positives.)
- **Proposals, not writes.** DAO spaces get a proposal an editor votes on;
  auto-vote is off.

## Cost & state notes

- `--detect-only` **without** `--no-sweep` still runs the paid Claude sweep —
  add `--no-sweep` for a genuinely free run.
- **Every run is a full scan; two caches make repeat runs nearly free.**
  `judged-pairs.json` remembers each pair's verdict and `swept-windows.json`
  remembers each sweep window's result. Both are keyed on the *text* of the
  stories involved, so unchanged history costs nothing and an edited story is
  correctly re-examined. Anyone on the team can run the full scan; they only
  pay for what changed since the last run. Delete `output/dedupe_news/` to
  start over from scratch.
- **The first run after upgrading re-sweeps everything**, because the window
  cache starts empty — roughly 260 windows across the five spaces. After that
  a daily run touches only the few windows containing new stories.
- The publish step warns when a plan is over two days old — re-scan rather
  than proposing from a stale plan.
- Model: `claude-sonnet-5` (override with `ANTHROPIC_MODEL` in `.env`).
