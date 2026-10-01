// Candidate generation through geo-lens: a local mirror of the Geo graph with
// per-cache vector indexes.
//
// This is a drop-in alternative to judge.ts's semanticSweep. Both answer the
// same question — "which stories might be covering the same event?" — and both
// hand their answer to the same judge, which is the only thing that decides.
// Nothing here confirms a duplicate. That rule is the whole reason the 2026-07
// audit's ~85%-false-positive candidate list was thrown out, and a faster
// candidate source is not a reason to relax it.
//
// Why this exists alongside the model sweep:
//
//   1. It is free. The sweep sends every window of every space to the model on
//      every run; this sends nothing to a vendor.
//   2. It has no date window. The sweep reads 8-day windows (judge.ts), so a
//      story re-injected months after its twin is invisible to it — dedupe.ts
//      calls that out as a ceiling on what the pipeline can ever find. A vector
//      index has no such horizon: the whole space is one neighbourhood.
//   3. It is semantic, not lexical. "White House Accuses China of AI Model
//      Theft" and "Trump Administration Announces Crackdown on Chinese AI"
//      share no distinctive word, which is exactly what the Jaccard routes in
//      dedupe.ts miss and what embeddings are for.
//
// What it is NOT good at: judging. A cosine score near 0.9 separates "same
// event" from "same topic" only loosely, which is why minScore is a floor on
// what gets ASKED about, never a threshold for action.
import { type Story } from './dedupe.js';

/** One hit as the geo-lens query route returns it. */
type LensHit = {
  id: string;
  name: string | null;
  score: number;
  payload: Record<string, unknown>;
};

export type LensOptions = {
  /** Base URL of the deployed geo-lens API, no trailing slash. */
  url: string;
  /** Value for the X-API-Key header; resolves to a consumer id server-side. */
  apiKey: string;
  /** Cache handle, as created by POST /caches. */
  handle?: string;
  /** Restricts the search to one Geo space, matching the per-space scan. */
  spaceId: string;
  /** Neighbours requested per story. The story itself comes back as one of
   *  them, so the usable number is k-1. */
  k?: number;
  /**
   * Cosine floor for a neighbour to become a candidate.
   *
   * geo-lens reports Neo4j's normalised cosine, (1 + cos) / 2, so the scale
   * runs 0.5–1.0 for unrelated-to-identical rather than 0–1. Everything is
   * compressed into the top of that range, which is why the floor is high and
   * why small moves in it matter so much.
   *
   * Measured on health (1,278 stories, description slot, k=8) 2026-10-01:
   *
   *     floor   pairs   per 100 stories
   *     0.88     1080   84.5
   *     0.90      567   44.4
   *     0.92      305   23.9
   *     0.94      103    8.1     ← default
   *     0.96       22    1.7
   *     0.98        6    0.5
   *
   * The bands do not degrade smoothly, they change in kind. At 0.94 and above
   * the pairs are the same event ("AI Can Predict Pancreatic Cancer Years in
   * Advance" / "AI Model Detects Pancreatic Cancer Up to 3 Years Earlier"), and
   * three pairs scored a flat 1.0000 — byte-identical headlines. Between 0.90
   * and 0.92 they are the same TOPIC and plainly different events ("Congo to
   * receive 70,000 doses of Ervebo vaccine" / "WHO reveals Congo's outbreak
   * began months before officials knew"). That lower band is the ~85%
   * false-positive shape the 2026-07 audit rejected, so the default sits above
   * it. Lower it only with the judge switched on, where a bad candidate costs
   * a model call rather than a deletion.
   */
  minScore?: number;
  /** Which embedding slot to search. The news cache carries two. `description`
   *  is the better signal — two write-ups of one event say the same things at
   *  length even when their headlines share nothing — but `name` catches
   *  near-verbatim re-posts whose bodies were rewritten. */
  field?: 'name' | 'description';
  /** Score every cache member instead of using the approximate HNSW index.
   *  Exhaustive and slower. Worth it for a final run, wasteful for a probe. */
  exact?: boolean;
  concurrency?: number;
};

const DEFAULTS = {
  handle: 'news',
  k: 8,
  minScore: 0.94,
  field: 'description' as const,
  exact: false,
  concurrency: 8,
};

/** Bounded parallelism, same shape as the one in 14_dedupe_news_stories.ts. */
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

/**
 * One query against the cache. Retries transient failures, because a single
 * dropped request would silently cost us every pair that story was part of.
 */
async function queryOne(
  text: string, opts: Required<LensOptions>, attempt = 0,
): Promise<LensHit[]> {
  try {
    const res = await fetch(`${opts.url}/caches/${opts.handle}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': opts.apiKey },
      body: JSON.stringify({
        strategy: 'vector',
        input: { text, field: opts.field },
        k: opts.k,
        exact: opts.exact,
        filters: { spaceIds: [opts.spaceId] },
        // 'cached' deliberately: a dedupe run must see one consistent snapshot.
        // 'fresh' would make each query refresh the cache mid-scan, so stories
        // could appear or change between two queries of the same run.
        consistency: 'cached',
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    const body = await res.json() as { hits?: LensHit[] };
    return body.hits ?? [];
  } catch (e) {
    if (attempt >= 3) throw e;
    await new Promise(r => setTimeout(r, 400 * 2 ** attempt));
    return queryOne(text, opts, attempt + 1);
  }
}

/**
 * Pairs worth judging, found by vector similarity.
 *
 * Returns sorted [idA, idB] tuples, the same shape semanticSweep returns, so
 * the caller folds both into one `swept` set without caring which produced what.
 *
 * Only pairs where BOTH stories are in `stories` are returned. The cache holds
 * the whole News story type; a scan may be narrowed by --from/--to, and a
 * neighbour outside that range is not a candidate for this run.
 */
export async function lensCandidates(
  stories: Story[],
  options: LensOptions,
  log: (msg: string) => void = () => {},
): Promise<Array<[string, string]>> {
  const opts = { ...DEFAULTS, ...options } as Required<LensOptions>;
  const inScope = new Set(stories.map(s => s.id));

  // A story with nothing in the searched field cannot be queried on it. Falling
  // back to the other field would compare a headline against descriptions,
  // which scores on a different scale and would make minScore mean two things.
  const askable = stories.filter(s => (opts.field === 'name' ? s.name : s.description)?.trim());
  const skipped = stories.length - askable.length;
  log(`${askable.length} stories to query on "${opts.field}"`
    + (skipped ? `, ${skipped} skipped (no ${opts.field})` : '')
    + (opts.exact ? ', exact scan' : ''));

  const pairs = new Set<string>();
  let failures = 0;
  let done = 0;

  await mapLimit(askable, opts.concurrency, async (story) => {
    const text = (opts.field === 'name' ? story.name : story.description).trim();
    try {
      for (const hit of await queryOne(text, opts)) {
        // The story matches itself at ~1.0; that is not a pair.
        if (hit.id === story.id) continue;
        if (hit.score < opts.minScore) continue;
        if (!inScope.has(hit.id)) continue;
        pairs.add([story.id, hit.id].sort().join('|'));
      }
    } catch (e) {
      // A story we could not query is a story whose pairs we simply do not
      // propose. Loud, because silently losing recall is worse than a slow run.
      failures++;
      if (failures <= 3) log(`query failed for ${story.id.slice(0, 8)}: ${String(e).slice(0, 70)}`);
    }
    if (++done % 250 === 0) log(`queried ${done}/${askable.length}, ${pairs.size} pairs so far`);
  });

  if (failures) log(`⚠ ${failures} queries failed — their pairs were not found`);
  log(`${pairs.size} pairs above ${opts.minScore}`);
  return [...pairs].map(p => p.split('|') as [string, string]);
}

/** Readable one-liner for the scan header. */
export function describeLens(opts: LensOptions): string {
  const o = { ...DEFAULTS, ...opts };
  return `geo-lens ${o.url} (${o.handle}, ${o.field}, k=${o.k}, ≥${o.minScore}${o.exact ? ', exact' : ''})`;
}
