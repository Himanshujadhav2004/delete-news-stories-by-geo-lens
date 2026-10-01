// Which stories must not be deleted, because a person has engaged with their
// claims.
//
// Two kinds of engagement, both irreversible once the entity is gone:
//
//   voted   — an up or down vote on a claim. Either direction counts. A
//             downvote is a judgement someone made, not a licence to delete.
//   ranked  — the claim appears in someone's Ranking Block submission. Those
//             live on chain as Rank entities pointing at their entries through
//             the `Rank votes` relation, which is what "Trending claims" is
//             built from.
//
// Votes and rank positions are keyed to an entity id and there is no operation
// that moves them. Backlinks and relations can be rebuilt from the graph; these
// cannot. That is why they outrank every other keeper signal.
import { gql } from './functions.js';

/** Story → its claims. */
export const NOTABLE_CLAIMS_RELATION = 'e1371bcda7044396adb7ea7ecc8fe3d4';
/** Rank entity → the entities it ranks. Geogenesis `ranking-block-ids.ts`. */
export const RANK_VOTES_RELATION = '19a4cfff45f24150abf2af0f43eb2eec';
export const RANK_TYPE = '5c74731dfabb4dc8b5c53346521c639a';

/** Engagement on one claim. `ranked` and either vote count makes it protected. */
export type ClaimEngagement = {
  id: string;
  upvotes: number;
  downvotes: number;
  ranked: boolean;
};

export type Protection = {
  /** Claims carrying a vote or a rank position. Empty means free to delete. */
  claims: ClaimEngagement[];
  upvotes: number;
  downvotes: number;
  ranked: number;
};

export const UNPROTECTED: Protection = { claims: [], upvotes: 0, downvotes: 0, ranked: 0 };

export function isProtected(p: Protection | undefined): boolean {
  return !!p && p.claims.length > 0;
}

/** One line for a plan file or a review row. */
export function describeProtection(p: Protection): string {
  if (!p.claims.length) return '';
  const bits: string[] = [];
  if (p.upvotes) bits.push(`${p.upvotes}↑`);
  if (p.downvotes) bits.push(`${p.downvotes}↓`);
  if (p.ranked) bits.push(`${p.ranked} ranked`);
  return `${p.claims.length} claim${p.claims.length === 1 ? '' : 's'} engaged (${bits.join(', ')})`;
}

/**
 * Every entity that appears in someone's ranking submission.
 *
 * One pass over the Rank entities rather than a lookup per claim: there are a
 * few hundred of them in total and tens of thousands of claims, so asking the
 * small side is the cheap direction. Returns a set to test membership against.
 *
 * DO NOT scope this to the space being scanned. Measured 2026-08-17: of 474
 * Rank entities, 473 live in PERSONAL spaces, spread across 157 of them, while
 * the claims they rank live in the DAO news spaces. A curator ranks from their
 * own space, so filtering by the news space would return almost nothing and
 * every ranked claim would read as unprotected — the deletion this file exists
 * to prevent. Protection is graph-wide by necessity, not by laziness.
 */
export async function fetchRankedEntityIds(
  log: (msg: string) => void = () => {},
): Promise<Set<string>> {
  const ranked = new Set<string>();
  let after: string | null = null;
  let ranks = 0;

  for (;;) {
    const data: any = await gql(`query($after: Cursor) {
      entitiesConnection(typeId: "${RANK_TYPE}", first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          votes: relations(first: 100, filter: { typeId: { is: "${RANK_VOTES_RELATION}" } }) {
            nodes { toEntity { id } }
          }
        }
      }
    }`, { after });

    const conn = data.entitiesConnection;
    for (const n of conn.nodes) {
      ranks++;
      for (const v of n.votes.nodes) {
        const id = v.toEntity?.id;
        if (id) ranked.add(id);
      }
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  log(`${ranks} ranking submissions cover ${ranked.size} entities`);
  return ranked;
}

/**
 * Vote counts for a set of claims, summed across spaces.
 *
 * Votes are recorded per space, so the same claim surfaced in two spaces has two
 * rows. Any row with a vote protects the claim, so they are added rather than
 * compared.
 */
export async function fetchClaimVotes(claimIds: string[]): Promise<Map<string, { up: number; down: number }>> {
  const votes = new Map<string, { up: number; down: number }>();
  // Chunked: the id list travels in the query variables and a whole space's
  // claims at once would be an unreasonable request.
  const CHUNK = 200;

  for (let i = 0; i < claimIds.length; i += CHUNK) {
    const ids = claimIds.slice(i, i + CHUNK);
    const data: any = await gql(`query($ids: [UUID!]) {
      votesCounts(filter: { objectId: { in: $ids } }, first: 1000) {
        objectId upvotes downvotes
      }
    }`, { ids });

    for (const row of data.votesCounts ?? []) {
      const prev = votes.get(row.objectId) ?? { up: 0, down: 0 };
      prev.up += Number(row.upvotes ?? 0);
      prev.down += Number(row.downvotes ?? 0);
      votes.set(row.objectId, prev);
    }
  }
  return votes;
}

/**
 * Resolve protection for stories whose claim ids are already known.
 *
 * Only engaged claims are kept. A story with forty untouched claims and one
 * upvoted claim reports exactly that one, so the plan file can say which claim
 * is holding the deletion back.
 */
export async function resolveProtection(
  storyClaims: Map<string, string[]>,
  rankedEntityIds: Set<string>,
): Promise<Map<string, Protection>> {
  const allClaimIds = [...new Set([...storyClaims.values()].flat())];
  const votes = allClaimIds.length ? await fetchClaimVotes(allClaimIds) : new Map();

  const out = new Map<string, Protection>();
  for (const [storyId, claimIds] of storyClaims) {
    const claims: ClaimEngagement[] = [];
    // Deduped here as well as at the fetch: a claim listed twice would be
    // counted twice in the summary line and, worse, transferred twice.
    for (const id of new Set(claimIds)) {
      const v = votes.get(id) ?? { up: 0, down: 0 };
      const ranked = rankedEntityIds.has(id);
      if (v.up > 0 || v.down > 0 || ranked) {
        claims.push({ id, upvotes: v.up, downvotes: v.down, ranked });
      }
    }
    out.set(storyId, {
      claims,
      upvotes: claims.reduce((n, c) => n + c.upvotes, 0),
      downvotes: claims.reduce((n, c) => n + c.downvotes, 0),
      ranked: claims.filter(c => c.ranked).length,
    });
  }
  return out;
}
