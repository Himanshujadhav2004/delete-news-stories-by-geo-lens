// Find duplicate news stories and delete them, without anyone assembling a list
// first.
//
// Two commands, deliberately separate:
//
//   bun run 14_dedupe_news_stories.ts              scan: find duplicates, write a plan
//   bun run 14_dedupe_news_stories.ts --publish    read the plan, ask how many, propose
//
// Candidate sources are selectable. --lens adds geo-lens vector neighbours;
// --no-sweep drops the paid model sweep. Using both is the widest net:
//
//   --lens                       mirror + model sweep + the free local passes
//   --lens --no-sweep            mirror only, no vendor cost for detection
//   --lens-field name            search headlines instead of descriptions
//   --lens-score 0.92            lower the floor (more candidates, more judging)
//
// Separate because the publish step must propose exactly what was reviewed. If
// it re-ran detection it would re-run the model, and what got proposed could
// differ from what someone just read. The plan file is the contract between the
// two.
//
// The method is the one from the 2026-07-21 audit, which confirmed 187 duplicate
// pairs across 4,289 stories. Candidates come from four places: stories citing
// the same article, headlines that read alike, a Claude sweep over overlapping
// date windows, and — with --lens — vector neighbours from a geo-lens mirror.
// Every candidate is then judged again on its own, with both full descriptions.
//
// --lens exists because the sweep has two costs the mirror does not: it is paid
// per window per run, and it only ever compares stories within 8 days of each
// other, so a story re-injected months after its twin cannot be found by it at
// all. The mirror has no window. It is a candidate source and nothing more:
// rule 2 below applies to it exactly as it applies to word overlap.
//
// Two rules it will not break, both learned from that audit:
//
//   1. Exactly one story of a pair is deleted and the other is kept. Clusters of
//      three or more are never touched: the audit found 187 pairs but also 37
//      chains of 3 to 12 stories, and those were rolling coverage of an evolving
//      story (the Hormuz saga, the Venezuela quake tolls), not duplicates.
//      Deleting a chain destroys a timeline. Chains go to a review file.
//
//   2. Cheap similarity finds candidates and never confirms them. The editor
//      team's own candidate list was ~85% false positives because it was built
//      from description-similarity thresholds that slid as low as 0.19.
//
// In a DAO space the SDK proposes rather than writes, and auto-vote is off in
// functions.ts, so the last step is an editor voting on a proposal that names
// exactly what it removes.
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { Graph, type Op } from '@geoprotocol/geo-sdk';
import { printOps, publishOps, preflight } from './src/functions.js';
import { deleteEntity, type OpsBatch } from './src/entity_ops.js';
import { TYPES } from './src/constants.js';
import {
  DEFAULT_DESCRIPTION_SIMILARITY, DEFAULT_SUMMARY_SIMILARITY,
  SPACES, candidates, cluster, fetchStories, pickKeeper,
  protectedClaimIds, type Story,
} from './src/dedupe.js';
import { judgePair, pairKey, semanticSweep, type SweepCache, type Verdict } from './src/judge.js';
import { describeLens, lensCandidates } from './src/lens.js';
import {
  describeProtection, fetchRankedEntityIds, isProtected, resolveProtection, UNPROTECTED,
} from './src/protection.js';
import { type ClaimTransfer, TRANSFER_RELATIONS, planTransfers } from './src/transfer.js';
import {
  geoUrl, renderPairConsole, renderReport, renderSkippedConsole,
  type ReportPair, type ReportSkipped,
} from './src/report.js';

// Orphan cleanup is limited to the parts of a story: its blocks, claims,
// quotes, articles. A Person or Company referenced by a deleted story is not
// itself rubbish. Same list 13_delete_news_stories.ts uses.
const ORPHAN_TYPES = new Set([
  TYPES.text_block, TYPES.data_block, TYPES.image,
  TYPES.topic, TYPES.claim, TYPES.article, TYPES.quote, TYPES.page,
]);

// ─── options ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const PUBLISH = argv.includes('--publish');
/** Stop after counting candidates, before anything is judged. */
const DETECT_ONLY = argv.includes('--detect-only');
/** Skip the model sweep and use only the free local passes. Much cheaper, and
 *  much worse: the free passes alone found 29% of known duplicates. */
const NO_SWEEP = argv.includes('--no-sweep');
/** Use geo-lens vector search as a candidate source. Free, no date window, and
 *  semantic — the three things the model sweep is paid for. It feeds the same
 *  `swept` set, so candidates from either source are indistinguishable
 *  downstream and both still face the judge. Needs LENS_URL + LENS_API_KEY. */
const USE_LENS = argv.includes('--lens');
/** Score every cache member instead of the approximate index. Exhaustive. */
const LENS_EXACT = argv.includes('--lens-exact');
const LENS_URL = (process.env.LENS_URL ?? '').replace(/\/+$/, '');
const LENS_API_KEY = process.env.LENS_API_KEY ?? '';
const LENS_HANDLE = flag('lens-handle', process.env.LENS_CACHE_HANDLE ?? 'news')!;
// 0.94 measured on health: below it the pairs are same-topic rather than
// same-event. See the table in src/lens.ts.
const LENS_SCORE = Number(flag('lens-score', '0.94'));
const LENS_K = Number(flag('lens-k', '8'));
const LENS_FIELD = (flag('lens-field', 'description') as 'name' | 'description');
if (USE_LENS && (!LENS_URL || !LENS_API_KEY)) {
  console.error('--lens needs LENS_URL and LENS_API_KEY in the environment.');
  console.error('  LENS_URL=https://your-geo-lens.up.railway.app');
  console.error('  LENS_API_KEY=<the key that maps to your consumer>');
  process.exit(1);
}
if (USE_LENS && LENS_FIELD !== 'name' && LENS_FIELD !== 'description') {
  console.error(`--lens-field must be "name" or "description", got "${LENS_FIELD}"`);
  process.exit(1);
}
/** Take the plan as-is instead of asking. For cron, never for a first run. */
const ASSUME_YES = argv.includes('--yes');
/** Build the ops and write them out, but propose nothing. The only way to read
 *  a claim transfer in full before it exists on chain. */
const DRY_RUN = argv.includes('--dry-run');
/** Optional publish-date range. Not a detection setting — it narrows WHICH
 *  stories are scanned, so a run can be pointed at "last month" without the
 *  pairing itself being limited to a window. Absent = the whole archive. */
const FROM = flag('from');
const TO = flag('to');
const parseBound = (v: string | undefined, label: string) => {
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) { console.error(`--${label} must be a date like 2026-08-01, got "${v}"`); process.exit(1); }
  return t;
};
const FROM_MS = parseBound(FROM, 'from');
// Inclusive: --to 2026-08-17 should cover everything published that day.
const TO_MS = TO ? parseBound(TO, 'to')! + 86_399_999 : null;
const MAX_PAIRS = Number(flag('max-pairs', '1500'));
const TITLE_SIMILARITY = Number(flag('similarity', '0.5'));
const DESCRIPTION_SIMILARITY = Number(flag('description-similarity', String(DEFAULT_DESCRIPTION_SIMILARITY)));
const SUMMARY_SIMILARITY = Number(flag('summary-similarity', String(DEFAULT_SUMMARY_SIMILARITY)));
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';
const CONCURRENCY = 8;
const OUT_DIR = './output/dedupe_news';
const STATE_FILE = `${OUT_DIR}/proposed-clusters.json`;
const JUDGED_FILE = `${OUT_DIR}/judged-pairs.json`;
const SWEEP_FILE = `${OUT_DIR}/swept-windows.json`;

const targets = (flag('spaces') ?? Object.keys(SPACES).join(','))
  .split(',').map(s => s.trim()).filter(Boolean);
for (const t of targets) {
  if (!SPACES[t]) { console.error(`Unknown space "${t}". Known: ${Object.keys(SPACES).join(', ')}`); process.exit(1); }
}

/** What the scan hands to the publish step. */
type Side = {
  id: string; name: string; backlinks: number; relations: number;
  /** Carried so the report can show a side-by-side without re-fetching. */
  description: string; summary: string; date: string | null;
  claimCount: number; engagedClaims: number;
  engagement?: string;
};
type PlanEntry = {
  keep: Side;
  drop: Side;
  confidence: number;
  evidence: string;
  /** Claims on the keeper that must survive orphan cleanup. */
  protectedClaims: string[];
  /** Engaged claims moved off the dropped story onto the keeper, when both
   *  copies held engagement. Empty in the ordinary case. */
  transfers?: ClaimTransfer[];
};
type Plan = {
  createdAt: string;
  model: string;
  spaces: Record<string, { spaceId: string; clusters: PlanEntry[] }>;
};

const short = (s: string, n = 62) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ═══ publish ════════════════════════════════════════════════════════════════

if (PUBLISH) {
  const planPath = flag('plan') ?? (() => {
    const plans = existsSync(OUT_DIR)
      // Only timestamped plans, so a hand-made file cannot become "the newest"
      // by sorting after the digits. Names are plan-YYYYMMDDHHMMSS.json, where
      // lexicographic order is chronological order.
      ? readdirSync(OUT_DIR).filter(f => /^plan-[\d-]+\.json$/.test(f)).sort()
      : [];
    return plans.length ? `${OUT_DIR}/${plans[plans.length - 1]}` : null;
  })();

  if (!planPath || !existsSync(planPath)) {
    console.error('No plan found. Run the scan first:');
    console.error('  bun run 14_dedupe_news_stories.ts');
    process.exit(1);
  }

  const plan: Plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const ageHours = (Date.now() - Date.parse(plan.createdAt)) / 3_600_000;
  console.log(`Plan: ${planPath} (${ageHours < 1 ? 'just now' : `${Math.round(ageHours)}h old`}, ${plan.model})`);
  if (ageHours > 48) {
    console.log('⚠ This plan is over two days old. Stories may have changed since.');
    console.log('  Re-run the scan if you want it refreshed.');
  }

  // A dry run signs nothing and sends nothing, so it needs no wallet. Requiring
  // one would mean the ops could not be read until after a key was set up,
  // which is backwards: reading them is how you decide whether to send them.
  if (!DRY_RUN) {
    const { callerSpaceId } = await preflight();
    if (!callerSpaceId) {
      console.error('Refusing to publish: this wallet has no personal space on the current network.');
      process.exit(1);
    }
  }

  const state: Record<string, string> = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
  let proposedTotal = 0;

  for (const [slug, { spaceId, clusters }] of Object.entries(plan.spaces)) {
    if (!targets.includes(slug)) continue;
    const pending = clusters.filter(c => !state[[c.keep.id, c.drop.id].sort().join('|')]);
    if (!pending.length) continue;

    console.log(`\n── ${slug}: ${pending.length} duplicate${pending.length === 1 ? '' : 's'} ──`);
    // Most confident first, so answering "5" takes the five clearest.
    pending.sort((a, b) => b.confidence - a.confidence);
    // The same full rendering the scan produced. This is the last screen before
    // a proposal goes on chain, so it shows everything the scan knew — both
    // headlines, both body fields, the claim situation and a link per story —
    // rather than a shortened restatement someone has to cross-check.
    pending.forEach((c, i) => {
      console.log(renderPairConsole({
        space: slug, spaceId,
        keep: c.keep, drop: c.drop,
        confidence: c.confidence, evidence: c.evidence, transfers: c.transfers,
      }, i + 1));
    });

    let take = pending.length;
    if (!ASSUME_YES) {
      const answer = prompt(`  How many to propose? [${pending.length}, 0 to skip] `);
      if (answer !== null && answer.trim() !== '') {
        const n = Number(answer.trim());
        if (!Number.isFinite(n) || n < 0) { console.log('  Not a number — skipping this space.'); continue; }
        take = Math.min(Math.floor(n), pending.length);
      }
    }
    if (take === 0) { console.log('  Skipped.'); continue; }

    const chosen = pending.slice(0, take);
    const batch: OpsBatch = new Map();
    const deletingIds = new Set(chosen.map(c => c.drop.id));

    // Transfers first, so an engaged claim is attached to the keeper before the
    // story that currently holds it goes away. Both relations are written: the
    // Notable claims link makes it the keeper's claim, the Collection item link
    // is what puts it on the page. One without the other is a claim nobody can
    // see. Any keeper claim being replaced is removed here too — it said the
    // same thing and nobody had engaged with it.
    const transferOps: Op[] = [];
    for (const c of chosen) {
      for (const t of c.transfers ?? []) {
        transferOps.push(...Graph.createRelation({
          fromEntity: c.keep.id, toEntity: t.claimId, type: TRANSFER_RELATIONS.notableClaims,
        }).ops);
        transferOps.push(...Graph.createRelation({
          fromEntity: t.targetBlockId, toEntity: t.claimId, type: TRANSFER_RELATIONS.collectionItem,
          ...(t.position ? { position: t.position } : {}),
        }).ops);
        if (t.replaces) {
          await deleteEntity({
            entityId: t.replaces.id, spaceId, opsBatch: batch, deletingIds,
            orphanTypeFilter: ORPHAN_TYPES, quiet: true,
          });
        }
      }
    }
    // Belt and braces on top of the keeper rule: a claim someone voted on or
    // ranked is never removed as an orphan, whatever the graph says about who
    // else still points at it. Deleting the story is reversible by republishing;
    // deleting the vote attached to its claim is not.
    const keepClaims = [...new Set(chosen.flatMap(c => c.protectedClaims ?? []))];
    if (keepClaims.length) {
      console.log(`  ${keepClaims.length} engaged claim(s) held back from orphan cleanup`);
    }
    for (const c of chosen) {
      // Quiet: the pair detail above is the review surface. deleteEntity's own
      // cascade logging ran to ~1,580 lines for 17 stories and buried it.
      await deleteEntity({
        entityId: c.drop.id, spaceId, opsBatch: batch, deletingIds, orphanTypeFilter: ORPHAN_TYPES,
        excludeFromOrphanCheck: keepClaims, quiet: true,
      });
    }
    const ops = [...transferOps, ...(batch.get(spaceId) ?? [])];
    const stamp = new Date().toISOString().slice(0, 10);
    printOps(ops, OUT_DIR, `dedupe_${slug}_${stamp}.txt`);
    writeFileSync(`${OUT_DIR}/dedupe_${slug}_${stamp}_manifest.txt`,
      chosen.map(c =>
        `DELETE ${c.drop.id}  ${c.drop.name}\n` +
        `  keep ${c.keep.id}  ${c.keep.name}\n` +
        `  keeper has ${c.keep.backlinks} backlinks / ${c.keep.relations} relations ` +
        `vs ${c.drop.backlinks} / ${c.drop.relations}\n` +
        (c.keep.engagement ? `  keeper holds ${c.keep.engagement}\n` : '') +
        (c.transfers ?? []).map(t =>
          `  MOVE claim ${t.claimId}  ${t.claimName}\n` +
          `    → block "${t.targetBlockName}" (${t.why})\n` +
          (t.replaces ? `    replacing ${t.replaces.id}  ${t.replaces.name}\n` : '')).join('') +
        `  ${c.evidence}\n`).join('\n'));

    const movedCount = chosen.reduce((n, c) => n + (c.transfers?.length ?? 0), 0);
    if (DRY_RUN) {
      console.log(`  DRY RUN — ${chosen.length} deletion${chosen.length === 1 ? '' : 's'}`
        + (movedCount ? ` and ${movedCount} claim move(s)` : '')
        + ` would be proposed (${ops.length} ops). Nothing sent.`);
      console.log(`  Read them: ${OUT_DIR}/dedupe_${slug}_${stamp}.txt and _manifest.txt`);
      continue;
    }

    console.log(`  Proposing ${chosen.length} deletion${chosen.length === 1 ? '' : 's'}`
      + (movedCount ? ` and ${movedCount} claim move(s)` : '') + ` (${ops.length} ops)…`);
    await publishOps(ops, `Delete ${chosen.length} duplicate news stories (${slug}, ${stamp})`, spaceId);
    for (const c of chosen) state[[c.keep.id, c.drop.id].sort().join('|')] = new Date().toISOString();
    proposedTotal += chosen.length;
    for (const c of chosen) console.log(`  - https://geobrowser.io/space/${spaceId}/${c.drop.id}`);
  }

  writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  console.log(`\nProposed ${proposedTotal} deletion${proposedTotal === 1 ? '' : 's'}.`);
  console.log('Editors vote on the proposals in Geo to execute them.');
  console.log('Anything not proposed stays in the plan and will be offered again next time.');
  process.exit(0);
}

// ═══ scan ═══════════════════════════════════════════════════════════════════

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? '';
if (!ANTHROPIC_KEY && !DETECT_ONLY) {
  console.error('ANTHROPIC_API_KEY is required: it sweeps for candidates and judges every pair.');
  console.error('Without it this would delete on word overlap alone, which is the');
  console.error('~85%-false-positive approach the last audit threw out.');
  process.exit(1);
}

/** Bounded parallelism — the model calls are the only slow and paid steps. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

mkdirSync(OUT_DIR, { recursive: true });

// Every run is a full scan. What makes that affordable is these two caches:
// both are keyed on the text of the stories involved, so an unchanged pair is
// never re-judged and an unchanged stretch of history is never re-swept. Only
// genuinely new or edited stories cost anything. Delete output/dedupe_news/ to
// start over from nothing.
const judged: Record<string, Verdict> = existsSync(JUDGED_FILE)
  ? JSON.parse(readFileSync(JUDGED_FILE, 'utf8')) : {};
const sweepCache: SweepCache = existsSync(SWEEP_FILE)
  ? JSON.parse(readFileSync(SWEEP_FILE, 'utf8')) : {};
const alreadyProposed: Record<string, string> = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};

console.log(`Scanning ${targets.join(', ')} | model ${MODEL}${NO_SWEEP ? ' | sweep OFF' : ''}`);
if (USE_LENS) {
  console.log(`Candidates also from ${describeLens({ url: LENS_URL, apiKey: LENS_API_KEY, handle: LENS_HANDLE, spaceId: '', k: LENS_K, minScore: LENS_SCORE, field: LENS_FIELD, exact: LENS_EXACT })}`);
}
if (NO_SWEEP && !USE_LENS) {
  console.log('⚠ No semantic candidate source: only shared URLs and word overlap.');
  console.log('  The free passes alone found 29% of known duplicates. Add --lens or drop --no-sweep.');
}

// Every entity anyone has placed in a ranking submission. Fetched once for the
// whole run: there are a few hundred submissions and tens of thousands of
// claims, so asking the small side is the cheap direction.
const rankedEntityIds = await fetchRankedEntityIds(m => console.log(`  ranking: ${m}`));

const review: string[][] = [['space', 'reason', 'cluster', 'entity_id', 'story_name', 'date', 'geo_url', 'evidence']];
/** Same rejections as the CSV, kept structured for the console and the report. */
const declined: ReportSkipped[] = [];

/**
 * Record a pair detection surfaced and the scan declined.
 *
 * Writes the CSV row and the report entry from one call, because the previous
 * shape let the two drift: the CSV had reasons the console never mentioned,
 * which is how "it says there were other candidates it didn't select" turned
 * into a complaint about weak reasoning.
 */
function decline(args: {
  slug: string; spaceId: string; reason: string; cluster: string; evidence: string;
  stories: Story[];
}) {
  const { slug, spaceId, reason, cluster, evidence, stories } = args;
  const day = (m: Story) => (m.date ? new Date(m.date).toISOString().slice(0, 10) : '');
  for (const m of stories) {
    review.push([slug, reason, cluster, m.id, m.name, day(m), geoUrl(spaceId, m.id), evidence]);
  }
  declined.push({
    space: slug, spaceId, reason,
    stories: stories.map(m => ({ id: m.id, name: m.name, date: day(m) })),
  });
}
const plan: Plan = { createdAt: new Date().toISOString(), model: MODEL, spaces: {} };

for (const slug of targets) {
  const spaceId = SPACES[slug];
  console.log(`\n── ${slug} ──`);

  let stories = await fetchStories(spaceId);
  if (FROM_MS !== null || TO_MS !== null) {
    const before = stories.length;
    // A story with no publish date cannot be placed in the range, and silently
    // dropping it would hide it from a range the user believes is complete.
    const undated = stories.filter((s: Story) => s.date == null).length;
    stories = stories.filter((s: Story) =>
      s.date != null && (FROM_MS === null || s.date >= FROM_MS) && (TO_MS === null || s.date <= TO_MS));
    console.log(`  ${before} stories, ${stories.length} in range`
      + `${FROM ? ` from ${FROM}` : ''}${TO ? ` to ${TO}` : ''}`
      + (undated ? ` (${undated} have no publish date and were excluded)` : ''));
  } else {
    console.log(`  ${stories.length} stories`);
  }

  // Claim engagement, resolved before anything is judged so the keeper rule and
  // the review routing can both see it.
  const protection = await resolveProtection(
    new Map(stories.map((s: Story) => [s.id, s.claims.map(c => c.id)])),
    rankedEntityIds,
  );
  for (const s of stories) s.protection = protection.get(s.id) ?? UNPROTECTED;
  const engaged = stories.filter((s: Story) => isProtected(s.protection));
  if (engaged.length) {
    const claims = engaged.reduce((n: number, s: Story) => n + (s.protection?.claims.length ?? 0), 0);
    console.log(`  ${engaged.length} stories hold ${claims} voted or ranked claim(s) — protected from deletion`);
  }

  // Stage 1: the model reads overlapping windows of headlines and groups the
  // ones covering a single event. This is what finds paraphrases, which word
  // overlap cannot: "White House Accuses China of AI Model Theft" and "Trump
  // Administration Announces Crackdown on Chinese AI" share no distinctive word.
  //
  // Every window, every run. Windows whose stories are unchanged come back from
  // the cache for nothing, so the cost tracks what actually changed rather than
  // how far back the archive goes.
  const swept = new Set<string>();
  if (!NO_SWEEP && ANTHROPIC_KEY) {
    const found = await semanticSweep(
      stories,
      { model: MODEL, apiKey: ANTHROPIC_KEY, concurrency: CONCURRENCY, cache: sweepCache },
      m => console.log(`  sweep: ${m}`),
    );
    for (const [a, b] of found) swept.add([a, b].sort().join('|'));
    console.log(`  sweep proposed ${swept.size} pairs`);
    // Written per space rather than at the end, so a run interrupted halfway
    // does not throw away the windows it already paid for.
    writeFileSync(SWEEP_FILE, JSON.stringify(sweepCache));
  }

  // Vector neighbours from the mirror. Folded into the same `swept` set the
  // model sweep fills: downstream nothing knows or cares which source proposed
  // a pair, and every pair still faces the judge either way. Counted separately
  // only so a run can be read — "lens found 40, 12 the sweep had not" is the
  // number that says whether the paid sweep is still earning its place.
  if (USE_LENS) {
    const before = swept.size;
    const found = await lensCandidates(
      stories,
      {
        url: LENS_URL, apiKey: LENS_API_KEY, handle: LENS_HANDLE, spaceId,
        k: LENS_K, minScore: LENS_SCORE, field: LENS_FIELD,
        exact: LENS_EXACT, concurrency: CONCURRENCY,
      },
      m => console.log(`  lens: ${m}`),
    );
    for (const [a, b] of found) swept.add([a, b].sort().join('|'));
    const added = swept.size - before;
    console.log(`  lens proposed ${found.length} pairs`
      + (before ? `, ${added} the sweep had not` : ''));
  }

  const found = candidates(stories, {
    minSimilarity: TITLE_SIMILARITY,
    minDescriptionSimilarity: DESCRIPTION_SIMILARITY,
    minSummarySimilarity: SUMMARY_SIMILARITY,
    swept,
  });
  // Strongest first, so a cap drops the weakest evidence rather than whatever
  // happened to sort last. A shared source URL beats a headline resemblance.
  found.sort((x, y) => Number(y.shared > 0) - Number(x.shared > 0) || y.shared - x.shared);
  const pairs = found.slice(0, MAX_PAIRS);
  console.log(`  ${found.length} candidate pairs${found.length > pairs.length ? `, judging the strongest ${pairs.length}` : ''}`);
  if (found.length > pairs.length) {
    console.log(`  ⚠ ${found.length - pairs.length} candidates not judged — raise --max-pairs to cover them`);
  }
  if (DETECT_ONLY || !pairs.length) continue;

  // Stage 2: every candidate judged on its own, with both full descriptions.
  // The sweep saw headlines in a crowd; this sees one pair properly.
  let failures = 0;
  let reused = 0;
  const verdicts: Verdict[] = await mapLimit(pairs, CONCURRENCY, async (pair, i) => {
    const key = pairKey(pair);
    const cached = judged[key];
    // A cached "uncertain" from a failed call is not a decision, so it is retried.
    if (cached && !cached.reason.startsWith('judge failed')) { reused++; return cached; }
    if ((i + 1) % 25 === 0) process.stdout.write(`\r  judging ${i + 1}/${pairs.length}`);
    try {
      const verdict = await judgePair(pair, MODEL, ANTHROPIC_KEY);
      judged[key] = verdict;
      return verdict;
    } catch (e) {
      // A pair we could not judge is a pair we do not delete.
      failures++;
      return { verdict: 'uncertain' as const, confidence: 0, reason: `judge failed: ${String(e).slice(0, 60)}` };
    }
  });
  process.stdout.write(`\r  judged ${pairs.length - reused}/${pairs.length}${reused ? `, ${reused} reused from cache` : ''}          \n`);
  if (failures) console.log(`  ⚠ ${failures} pairs could not be judged and were sent to review`);

  const byId = new Map(stories.map((s: Story) => [s.id, s]));
  const confirmed = pairs.filter((_, i) => verdicts[i].verdict === 'duplicate');
  const unsure = pairs.filter((_, i) => verdicts[i].verdict === 'uncertain');
  console.log(`  ${confirmed.length} duplicates, ${unsure.length} uncertain, ${pairs.length - confirmed.length - unsure.length} distinct`);

  // Everything the model would not commit on goes to a person rather than being
  // silently treated as "not a duplicate".
  for (let i = 0; i < pairs.length; i++) {
    if (verdicts[i].verdict !== 'uncertain') continue;
    decline({
      slug, spaceId,
      reason: `uncertain — ${verdicts[i].reason || 'the model would not commit'}`,
      cluster: pairs[i].a.id.slice(0, 8),
      evidence: pairs[i].why,
      stories: [pairs[i].a, pairs[i].b],
    });
  }
  if (!confirmed.length) continue;

  const evidence = new Map<string, string>();
  const confidence = new Map<string, number>();
  for (let i = 0; i < pairs.length; i++) {
    if (verdicts[i].verdict !== 'duplicate') continue;
    const key = [pairs[i].a.id, pairs[i].b.id].sort().join('|');
    evidence.set(key, `${pairs[i].why}; ${verdicts[i].reason}`);
    confidence.set(key, verdicts[i].confidence);
  }

  const clusters = cluster(confirmed.map(p => [p.a.id, p.b.id] as [string, string]));
  const entries: PlanEntry[] = [];
  let chains = 0;
  let skipped = 0;
  let bothEngaged = 0;
  let transferred = 0;

  for (const [root, ids] of clusters) {
    const members = ids.map(id => byId.get(id)!).filter(Boolean);
    if (members.length < 2) continue;
    const key = [...ids].sort().slice(0, 2).join('|');

    // Three or more is rolling coverage until a person says otherwise.
    if (members.length > 2) {
      chains++;
      decline({
        slug, spaceId,
        reason: `chain of ${members.length} — rolling coverage of one evolving story, never deleted automatically`,
        cluster: root, evidence: evidence.get(key) ?? '', stories: members,
      });
      continue;
    }

    if (alreadyProposed[ids.slice().sort().join('|')]) { skipped++; continue; }

    // Exactly one survives. Engaged claims decide first — a vote or a rank
    // position cannot be moved to another entity, so the copy holding one has
    // to be the copy that stays. Backlinks, richness and age break ties below
    // that.
    const keeper = pickKeeper(members);
    const loser = members.find(m => m.id !== keeper.id)!;

    // When BOTH copies hold engaged claims the loser's engagement would die
    // with it, so those claims move to the keeper instead of being lost. The
    // pair is only abandoned when a claim cannot be placed — see transfer.ts.
    let transfers: ClaimTransfer[] = [];
    if (isProtected(loser.protection)) {
      const plan = await planTransfers({
        keeperId: keeper.id,
        keeperClaims: keeper.claims,
        keeperEngagedIds: new Set((keeper.protection ?? UNPROTECTED).claims.map(c => c.id)),
        loserClaims: loser.claims,
        engagedOnLoser: loser.protection!.claims,
        model: MODEL, apiKey: ANTHROPIC_KEY,
      });
      if (!plan.ok) {
        bothEngaged++;
        decline({
          slug, spaceId,
          reason: `engaged claims could not be moved — ${plan.blockers.map(b => b.reason).join('; ')}`,
          cluster: root, evidence: evidence.get(key) ?? '', stories: members,
        });
        continue;
      }
      transfers = plan.transfers;
      transferred += transfers.length;
    }
    const side = (s: Story): Side => ({
      id: s.id, name: s.name, backlinks: s.backlinks, relations: s.relations,
      description: s.description, summary: s.summary,
      date: s.date ? new Date(s.date).toISOString().slice(0, 10) : null,
      claimCount: s.claims.length,
      engagedClaims: (s.protection ?? UNPROTECTED).claims.length,
    });
    entries.push({
      keep: { ...side(keeper), engagement: describeProtection(keeper.protection ?? UNPROTECTED) },
      drop: side(loser),
      confidence: confidence.get(key) ?? 0,
      evidence: evidence.get(key) ?? '',
      protectedClaims: protectedClaimIds(members),
      transfers,
    });
  }

  entries.sort((a, b) => b.confidence - a.confidence);
  if (entries.length) plan.spaces[slug] = { spaceId, clusters: entries };
  console.log(`  ${entries.length} ready to propose, ${chains} chains to review`
    + (transferred ? `, ${transferred} engaged claim(s) to move` : '')
    + (bothEngaged ? `, ${bothEngaged} unmovable sent to review` : '')
    + (skipped ? `, ${skipped} proposed in an earlier run` : ''));
}

// Written even though nothing was proposed: knowing a pair is not a duplicate
// is a fact about the graph rather than an action taken on it.
writeFileSync(JUDGED_FILE, JSON.stringify(judged));

if (review.length > 1) {
  const csv = review.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  writeFileSync(`${OUT_DIR}/needs-review.csv`, csv);
}

const total = Object.values(plan.spaces).reduce((n, s) => n + s.clusters.length, 0);
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
const range = FROM || TO ? `${FROM ?? 'start'} → ${TO ?? 'now'}` : undefined;

// Flatten the plan into what both renderers read. Doing it once here means the
// terminal and the HTML are showing the same thing by construction.
const reportPairs: ReportPair[] = Object.entries(plan.spaces).flatMap(([slug, s]) =>
  s.clusters.map(cl => ({
    space: slug, spaceId: s.spaceId,
    keep: cl.keep, drop: cl.drop,
    confidence: cl.confidence, evidence: cl.evidence,
    transfers: cl.transfers,
  })));

// The full detail, in the terminal, at the moment the scan finishes — headline,
// date, both body fields, claim counts and the claim moves, with a link per
// story. This is the surface people actually read; the file below is for
// sharing and for coming back to it later.
if (reportPairs.length) {
  for (const [slug, s] of Object.entries(plan.spaces)) {
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`  ${slug} — ${s.clusters.length} duplicate${s.clusters.length === 1 ? '' : 's'}`);
    console.log('═'.repeat(72));
    for (const p of reportPairs.filter(x => x.space === slug)) console.log(renderPairConsole(p));
  }
}

const reportPath = `${OUT_DIR}/report-${stamp}.html`;
writeFileSync(reportPath, renderReport(reportPairs, declined, {
  createdAt: plan.createdAt, model: MODEL, range,
}));

console.log(`\n${'─'.repeat(72)}`);
for (const [slug, s] of Object.entries(plan.spaces)) {
  console.log(`  ${slug.padEnd(16)} ${String(s.clusters.length).padStart(3)} duplicate${s.clusters.length === 1 ? '' : 's'} to delete`);
}
console.log(`  ${'total'.padEnd(16)} ${String(total).padStart(3)}`);
if (declined.length) console.log(`\n${renderSkippedConsole(declined)}`);
console.log(`\nReport  ${reportPath}`);
if (review.length > 1) console.log(`Review  ${OUT_DIR}/needs-review.csv  (${review.length - 1} rows)`);

if (!total) {
  console.log('\nNo duplicates ready to propose.');
  process.exit(0);
}

const planPath = `${OUT_DIR}/plan-${stamp}.json`;
writeFileSync(planPath, JSON.stringify(plan, null, 1));
console.log(`Plan    ${planPath}`);
console.log('\nNothing has been proposed. To review and propose:');
console.log('  bun run 14_dedupe_news_stories.ts --publish');
