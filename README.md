# Geo Content Management

Tools for managing entities in the [Geo knowledge graph](https://geobrowser.io) via the
[GRC-20 SDK](https://github.com/geobrowser/grc-20).

This branch carries the **news story deduplication** work:

- `14_dedupe_news_stories.ts` — finds duplicate news stories and proposes deleting them. The
  main workflow; start at [Deduplicating news stories](#deduplicating-news-stories).
- `13_delete_news_stories.ts` — bulk-deletes a reviewed CSV of stories.

The generic entity operations (delete, move, merge) exist here as a **library** in
`src/entity_ops.ts`, used by the two scripts above. Their standalone entry points
(`01_entity_operations.ts`, `02_find_duplicates.ts`, `03_merge_duplicates.ts`) are **not on this
branch** — see [Entity operations as a library](#entity-operations-as-a-library).

## Setup

```bash
bun install
cp .env.example .env    # then fill it in
```

| Variable | Needed for | Notes |
|---|---|---|
| `LENS_URL` | `--lens` | Deployed geo-lens API, no trailing slash |
| `LENS_API_KEY` | `--lens` | Sent as `X-API-Key`; resolves to a consumer id |
| `LENS_CACHE_HANDLE` | `--lens` | Cache handle, default `news` |
| `ANTHROPIC_API_KEY` | judging | Required unless `--detect-only` |
| `PK_SW` | publishing only | Wallet key from [geobrowser.io/export-wallet](https://www.geobrowser.io/export-wallet) |

`.env` is gitignored. **`.env.example` is not** — never put a real secret in it.

Publishing also needs a personal space on testnet, or editorship in the target DAO space.

---

# Deduplicating news stories

Finds duplicate stories across the five news spaces and proposes deleting one of each pair.
Nothing is deleted directly: in a DAO space the SDK proposes, auto-vote is off, and an editor
votes on a proposal that names exactly what it removes.

## How it works

```
         ┌─────────────── candidate sources ───────────────┐
         │  shared source URLs          free, local        │
         │  title/description/summary   free, local        │
         │  geo-lens vector search      free, --lens       │
         │  Claude window sweep         paid, default on   │
         └───────────────────┬────────────────────────────┘
                             ▼
                    Claude judges each pair          ← the only thing that decides
                             ▼
              clusters → pairs only (3+ → review)
                             ▼
                 pick keeper → plan file (JSON)
                             ▼
                  --publish → proposal on Geo
                             ▼
                      editors vote
```

**Two rules the pipeline will not break**, both from the 2026-07-21 audit:

1. **Exactly one story of a pair is deleted.** Clusters of three or more are never touched —
   those are rolling coverage of an evolving story, and deleting a chain destroys a timeline.
   Chains go to `needs-review.csv`.
2. **Cheap similarity finds candidates and never confirms them.** That includes vector
   similarity. Every candidate faces the judge with both full descriptions.

Measured on `health` (1,278 stories, 2026-10-01): of **152 candidates, 29 were duplicates and
119 were not**. Proposing without the judge would have deleted ~119 legitimate stories.

## The two workflows

### Workflow 1 — detection only (free)

```bash
bun run 14_dedupe_news_stories.ts --detect-only --lens --no-sweep --spaces health
```

Counts candidates and stops. No vendor cost, no plan file, **cannot propose**. Use it to size
a space, or to produce a shortlist a person reviews by hand.

### Workflow 2 — judged (can propose)

The full pipeline, in four steps.

**1. Scan**

```bash
bun run 14_dedupe_news_stories.ts --lens --no-sweep --spaces health
```

Judges every candidate and writes to `output/dedupe_news/`:

| File | What |
|---|---|
| `report-<ts>.html` | every confirmed duplicate, side by side — **the review surface** |
| `plan-<ts>.json` | the contract `--publish` reads |
| `needs-review.csv` | chains of 3+ and pairs the judge would not commit on |
| `judged-pairs.json` | verdict cache, keyed on story text |

Nothing is proposed. Costs one Claude call per candidate — but results are cached, so re-running
an unchanged space is free.

**2. Review**

Read `report-<ts>.html`. Decide which pairs you actually agree with. Skim `needs-review.csv`
for what was deliberately *not* queued.

**3. Dry run**

```bash
bun run 14_dedupe_news_stories.ts --publish --dry-run
```

Builds the real delete operations and writes `dedupe_<space>_<date>.txt` plus a plain-English
`_manifest.txt`. **Sends nothing, needs no wallet.** The only way to read a deletion in full
before it exists on chain.

**4. Propose** ⚠️

```bash
bun run 14_dedupe_news_stories.ts --publish
```

Shows each pair, then asks `How many to propose? [23, 0 to skip]`. Answering `3` takes the three
highest-confidence pairs; the rest stay in the plan and are offered again next run. Proposed
pairs are recorded in `proposed-clusters.json` and never offered twice.

Start with a small number on a first run.

## Flags

```
--spaces health,ai          which spaces (default: all five)
--detect-only               stop after counting candidates
--lens                      add geo-lens vector candidates
--no-sweep                  skip the paid Claude window sweep
--lens-score 0.92           similarity floor (default 0.94)
--lens-field name           search headlines instead of descriptions
--lens-k 12                 neighbours per story (default 8)
--lens-exact                exhaustive scan instead of approximate HNSW
--from 2026-08-01 --to 2026-09-30   narrow by publish date
--max-pairs 300             cap judge calls
--yes                       take the plan as-is (for cron, never a first run)
--dry-run                   with --publish: build ops, send nothing
--plan <path>               publish a specific plan file
```

## Why `--lens`

The Claude sweep reads **8-day windows**, so a story re-injected months after its twin is
invisible to it. geo-lens has no window — the whole space is one neighbourhood — and it is free.
With `--lens --no-sweep` the paid sweep never runs, and you pay for judgment only.

Choosing `--lens-score` matters. Measured on `health`:

| floor | pairs | what the band contains |
|---|---|---|
| 0.90 | 567 | same **topic**, different events |
| **0.94** | **103** | same event — **default** |
| 0.97 | 10 | near-identical, three byte-identical |

Below 0.94 the pairs change in kind, not just in quality. Lower it only with the judge on,
where a bad candidate costs a model call rather than a deletion. See `src/lens.ts` for the full
table.

## Bulk deletion from a CSV

`13_delete_news_stories.ts` deletes a reviewed list of stories. Dry run unless `--publish`.

```bash
bun run 13_delete_news_stories.ts <batch-num> <csv-path>            # preview
bun run 13_delete_news_stories.ts <batch-num> <csv-path> --publish  # propose
```

Orphan cleanup is limited to the parts of a story (blocks, claims, quotes, articles). A Person
or Company a deleted story referenced is kept.

---

# Entity operations as a library

These live in `src/entity_ops.ts` and are imported by `13_` and `14_`. On branches that have
them, `01_entity_operations.ts` is a scratch entry point you edit and run; it is **not present
here**, so call these from your own script.

```ts
import { deleteEntity, changeEntityId, changeSpace, mergeEntities } from './src/entity_ops.js';
```

| Function | What it does |
|---|---|
| `deleteEntity` | Removes an entity and its properties/relations from a space. Optional recursive orphan cleanup, restrictable with `orphanTypeFilter`. |
| `changeEntityId` | Moves an entity to a new ID in the same space, recreating properties, relations and backlinks, then deleting the old one. |
| `changeSpace` | Moves an entity to another space keeping its ID. Returns `{ createOps, deleteOps }`. |
| `mergeEntities` | Merges secondaries into a main entity, same-space or cross-space. Redirects backlinks, appends non-duplicate relations, deletes secondaries. |
| `migratePropertyReferences` | Repoints references from one property id to another across accessible spaces. |
| `updateDataBlockFilters` | Rewrites the filters on a data block. |

Every one accepts `dryRun` to preview, and `opsBatch` (`Map<string, Op[]>`) to accumulate ops
across several calls and publish once per space:

```ts
const batch: OpsBatch = new Map();
await deleteEntity({ entityId: 'ID', spaceId: 'SPACE', opsBatch: batch, dryRun: true });
await publishOps(batch.get('SPACE') ?? [], 'Edit name', 'SPACE');
```

Merge selects the main entity among same-space candidates by backlink count, then by
property+relation count. Duplicate relation detection checks exact target IDs and "soft
duplicates" (same name + type). If the main entity is a Property type, property references are
migrated across all accessible spaces.

---

## Project structure

```
13_delete_news_stories.ts   # bulk-delete a reviewed CSV of stories
14_dedupe_news_stories.ts   # find + propose duplicate news stories  ← main workflow
src/
  dedupe.ts                 # story fetch, candidate routes, clustering, keeper rule
  lens.ts                   # geo-lens vector candidates (--lens)
  judge.ts                  # Claude window sweep + per-pair judgement
  protection.ts             # vote/ranking engagement — what must not be deleted
  transfer.ts               # moving engaged claims onto the keeper
  report.ts                 # console and HTML renderers
  entity_ops.ts             # delete, move, merge, migrate
  constants.ts              # ontology IDs
  functions.ts              # GraphQL client, publishing, ops serialization
scripts/
  measure-recall.ts         # candidate recall against known duplicates
  verify-plan.ts            # re-check a plan before publishing
  claim-detail.ts           # inspect one claim
  probe-engaged.ts          # inspect engagement on a story
output/dedupe_news/         # reports, plans, caches (gitignored)
knowledge-graph-ontology.md # full ontology specification
```

## References

- [GRC-20 Serialization Spec](https://github.com/geobrowser/grc-20/blob/main/spec.md)
- [Knowledge Graph Ontology](knowledge-graph-ontology.md)
- [geo-lens](https://github.com/Himanshujadhav2004/geo-lens) — the mirror `--lens` reads
