// Duplicate detection for news stories: fetching, candidate generation,
// clustering, and the decision about which copy survives.
//
// Kept apart from the script that runs it so the thresholds can be measured
// against known duplicates instead of trusted. Nothing here talks to a model or
// signs anything — it is all cheap and local, which is the point: this stage
// proposes candidates, and the judge decides.
import { gql } from './functions.js';

import { NOTABLE_CLAIMS_RELATION, type Protection, UNPROTECTED, isProtected } from './protection.js';

export const NEWS_STORY_TYPE = 'e550fe517e904b2c8fffdf13408f5634';
export const SOURCES_RELATION = '49c5d5e1679a4dbdbfd33f618f227c94';
export const PROP_PUBLISH_DATE = '94e43fe8faf241009eb887ab4f999723';
export const PROP_DESCRIPTION = '9b1f76ff9711404c861e59dc3fa7d037';
/**
 * The Summary property — a DIFFERENT field from Description, and the one
 * Armando meant when he asked for summaries to be part of detection.
 *
 * Description is a ~25-token blurb; Summary is the ~50-token write-up. 99% of
 * stories carry both. Until 2026-08-18 this file read Description alone and
 * called it "the summary", so the ask was never actually implemented. They
 * catch different pairs — measured on ai/health/us-politics, each found
 * duplicates the other missed — so both are used, with their own thresholds.
 */
export const PROP_SUMMARY = 'aa5da9278af44294a8a9b79421762c3a';

export const SPACES: Record<string, string> = {
  'crypto': 'c9f267dcb0d270718c2a3c45a64afd32',
  'ai': '41e851610e13a19441c4d980f2f2ce6b',
  'world-affairs': '89bd89bf28ff8a0963faf92a8c905e20',
  'health': '52c7ae149838b6d47ce0f3b2a5974546',
  'us-politics': '4582fbbee28a16589154f7e36f1ee3c5',
};

export type Story = {
  id: string;
  space: string;
  name: string;
  description: string;
  /** The Summary property. Longer and more distinctive than description; both
   *  are compared, because each catches duplicates the other misses. */
  summary: string;
  date: number | null;
  urls: Set<string>;
  /** Both scoped to the space being scanned. A story carried in two spaces
   *  reports every relation twice, which would let "is in more spaces" quietly
   *  win the richness tie-break against an equally rich twin. */
  backlinks: number;
  relations: number;
  /** Its Notable claims. Engagement on any of them decides whether this story
   *  can be deleted at all — see protection.ts. Names are carried because a
   *  transfer has to ask whether a claim already exists on the keeper. */
  claims: { id: string; name: string }[];
  /** Filled in after fetch by resolveProtection. Undefined means not looked up
   *  yet, which is why isProtected treats it as unknown rather than clean. */
  protection?: Protection;
};

export type Candidate = { a: Story; b: Story; why: string; shared: number };

/** Comparable form of a URL, so a tracking parameter is not a different source. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return String(url ?? '').trim().toLowerCase();
  }
}

/**
 * One entry per claim id, keeping the first.
 *
 * A story's relations come back once per space the story appears in, so a story
 * carried in two spaces reports each of its claims twice — 28 rows for 14
 * claims, measured on world-affairs. Harmless for counting, not harmless
 * downstream: a doubled claim was planned for transfer twice, which would have
 * written the relation twice and deleted the claim it replaced twice.
 */
function dedupeById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map(i => [i.id, i])).values()];
}

export async function fetchStories(spaceId: string): Promise<Story[]> {
  const stories: Story[] = [];
  let after: string | null = null;

  for (;;) {
    const data: any = await gql(`query($after: Cursor) {
      entitiesConnection(typeId: "${NEWS_STORY_TYPE}", spaceId: "${spaceId}", first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id name
          backlinks(first: 1, filter: { spaceId: { is: "${spaceId}" } }) { totalCount }
          relations(first: 1, filter: { spaceId: { is: "${spaceId}" } }) { totalCount }
          values(first: 12) { nodes { property { id } text datetime } }
          sources: relations(first: 40, filter: { typeId: { is: "${SOURCES_RELATION}" } }) {
            nodes { toEntity { values(first: 8) { nodes { property { name } text } } } }
          }
          claims: relations(first: 200, filter: { typeId: { is: "${NOTABLE_CLAIMS_RELATION}" } }) {
            nodes { toEntity { id name } }
          }
        }
      }
    }`, { after });

    const conn = data.entitiesConnection;
    for (const n of conn.nodes) {
      const value = (propId: string) => n.values.nodes.find((v: any) => v.property.id === propId);
      const dateRaw = value(PROP_PUBLISH_DATE);
      const date = dateRaw ? Date.parse(dateRaw.datetime ?? dateRaw.text ?? '') : NaN;
      const urls = new Set<string>();
      for (const s of n.sources.nodes) {
        const u = s.toEntity?.values?.nodes?.find((v: any) => v.property.name === 'Web URL')?.text;
        if (u) urls.add(canonicalUrl(u));
      }
      stories.push({
        id: n.id,
        space: spaceId,
        name: n.name ?? '',
        description: value(PROP_DESCRIPTION)?.text ?? '',
        summary: value(PROP_SUMMARY)?.text ?? '',
        date: Number.isNaN(date) ? null : date,
        urls,
        backlinks: n.backlinks.totalCount ?? 0,
        relations: n.relations.totalCount ?? 0,
        claims: dedupeById((n.claims?.nodes ?? [])
          .map((c: any) => ({ id: c.toEntity?.id as string, name: (c.toEntity?.name ?? '') as string }))
          .filter((c: { id: string }) => !!c.id)),
      });
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return stories;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'as', 'at', 'by', 'with', 'from', 'after', 'over', 'amid', 'its', 'is', 'are', 'says', 'said', 'new']);

export function titleTokens(name: string): Set<string> {
  return new Set(
    name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Description overlap that qualifies a pair on its own. Description is the
 *  short blurb, ~25 tokens, so a high bar still means something. */
export const DEFAULT_DESCRIPTION_SIMILARITY = 0.6;
/**
 * Summary overlap that qualifies a pair on its own.
 *
 * Lower than the description bar on purpose. Summary runs about twice as long,
 * and Jaccard divides by the union, so identical coverage scores lower simply
 * for being wordier. Measured on health: 0.60 found 1 pair, 0.35 found 6, and
 * 0.30 found 22 — the last is where it starts dragging in noise.
 */
export const DEFAULT_SUMMARY_SIMILARITY = 0.35;
/** Description overlap that counts when the headline is also part-way there. */
const DESCRIPTION_ASSIST = 0.4;
/** Summary overlap that counts when the headline is also part-way there. */
const SUMMARY_ASSIST = 0.25;
/** Headline overlap a body field is allowed to rescue. */
const TITLE_ASSIST = 0.3;

export type CandidateOptions = {
  /** Headline token overlap that makes a pair worth judging. */
  minSimilarity: number;
  /** Description token overlap that makes a pair worth judging on its own. */
  minDescriptionSimilarity?: number;
  /** Summary token overlap that makes a pair worth judging on its own. */
  minSummarySimilarity?: number;
  /** Pairs the model's window sweep proposed, as sorted "idA|idB" keys. */
  swept?: Set<string>;
};

/**
 * Pairs worth a model call.
 *
 * Four routes in: stories citing the same article, stories whose headlines say
 * the same thing, stories whose SUMMARIES say the same thing, and pairs the
 * model's window sweep grouped. Each alone is weak evidence — a shared source
 * can just mean one outlet covered two events — which is why nothing is deleted
 * on this basis, only sent to be judged.
 *
 * The summary route exists because two write-ups of one event routinely share
 * no distinctive headline word while describing the same thing at length, and
 * those were being missed. It is deliberately not the description-similarity
 * approach the 2026-07 audit threw out: that list was acted on directly at
 * thresholds down to 0.19, whereas here every candidate still faces the judge
 * with both full descriptions. A looser net costs judge calls, not deletions.
 *
 * Every pair in the space is considered, with no date window. An earlier version
 * only compared stories published within N days of each other, which quietly put
 * a ceiling on what could ever be found: a story re-injected months after its
 * twin was invisible to the whole pipeline. Measured 2026-08-17, dropping the
 * window took the five spaces from 292 candidate pairs to 336 — the similarity
 * thresholds were doing the filtering all along, and the window was mostly
 * limiting recall. The cost is O(n²) token comparisons, a few seconds on the
 * ~1,800 stories in the largest space.
 */
export function candidates(stories: Story[], opts: CandidateOptions): Candidate[] {
  const { minSimilarity, swept } = opts;
  const minDescription = opts.minDescriptionSimilarity ?? DEFAULT_DESCRIPTION_SIMILARITY;
  const minSummary = opts.minSummarySimilarity ?? DEFAULT_SUMMARY_SIMILARITY;
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const tokens = new Map(stories.map(s => [s.id, titleTokens(s.name)]));
  // Bodies run long, so both are tokenised once here rather than per pair.
  const descTokens = new Map(stories.map(s => [s.id, titleTokens(s.description)]));
  const summaryTokens = new Map(stories.map(s => [s.id, titleTokens(s.summary)]));

  // Date order is no longer load-bearing, but keeping it makes the output
  // chronological and stable between runs.
  const dated = [...stories].sort((x, y) => (x.date ?? 0) - (y.date ?? 0));

  for (let i = 0; i < dated.length; i++) {
    for (let j = i + 1; j < dated.length; j++) {
      const a = dated[i], b = dated[j];
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      if (seen.has(key)) continue;

      let shared = 0;
      for (const u of a.urls) if (b.urls.has(u)) shared++;
      const sim = jaccard(tokens.get(a.id)!, tokens.get(b.id)!);
      const descSim = jaccard(descTokens.get(a.id)!, descTokens.get(b.id)!);
      const summarySim = jaccard(summaryTokens.get(a.id)!, summaryTokens.get(b.id)!);
      const sweptIn = swept?.has(key) ?? false;
      // Each body field qualifies on its own, or moderately when the headline
      // was already part-way there. Both are checked because they disagree:
      // measured across three spaces, each found duplicates the other missed.
      const descHit = descSim >= minDescription
        || (descSim >= DESCRIPTION_ASSIST && sim >= TITLE_ASSIST);
      const summaryHit = summarySim >= minSummary
        || (summarySim >= SUMMARY_ASSIST && sim >= TITLE_ASSIST);

      if (shared > 0 || sim >= minSimilarity || descHit || summaryHit || sweptIn) {
        seen.add(key);
        const why = [
          shared > 0 ? `${shared} shared source URL${shared > 1 ? 's' : ''}` : null,
          sim >= minSimilarity ? `title overlap ${sim.toFixed(2)}` : null,
          descHit ? `description overlap ${descSim.toFixed(2)}` : null,
          summaryHit ? `summary overlap ${summarySim.toFixed(2)}` : null,
          sweptIn ? 'grouped by the window sweep' : null,
        ].filter(Boolean).join(', ');
        out.push({ a, b, shared, why });
      }
    }
  }
  return out;
}

/** Union-find, so A~B and B~C become one cluster of three rather than two pairs
 *  that would each delete a different member. */
export function cluster(pairs: Array<[string, string]>): Map<string, string[]> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
    return parent.get(x)!;
  };
  for (const [a, b] of pairs) parent.set(find(a), find(b));

  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(id);
  }
  return groups;
}

/**
 * Which copy survives.
 *
 * Claim engagement first, and nothing else comes close. A vote or a rank
 * position is keyed to an entity id with no operation that moves it, so the
 * copy whose claims a person has voted on or ranked is the copy that has to
 * stay — even when it is newer and thinner than its twin. Backlinks and
 * relations are graph-derived and can be rebuilt; a vote cannot.
 *
 * (An earlier version of this function claimed backlinks stood in for votes.
 * They do not: backlinks are incoming relations, votes live in their own table,
 * and nothing here ever read one. See protection.ts.)
 *
 * Only meaningful when exactly one side is engaged. When both are, the pair
 * never reaches this function — the caller sends it to review instead, because
 * no rule can decide which person's judgement to discard.
 */
export function pickKeeper(members: Story[]): Story {
  return [...members].sort((a, b) =>
    Number(isProtected(b.protection)) - Number(isProtected(a.protection)) ||
    b.backlinks - a.backlinks ||
    b.relations - a.relations ||
    (a.date ?? Infinity) - (b.date ?? Infinity) ||
    a.id.localeCompare(b.id),
  )[0];
}

/** Claim ids that must survive any deletion in this batch, so orphan cleanup
 *  cannot sweep an engaged claim up as collateral. */
export function protectedClaimIds(stories: Story[]): string[] {
  return [...new Set(stories.flatMap(s => (s.protection ?? UNPROTECTED).claims.map(c => c.id)))];
}
