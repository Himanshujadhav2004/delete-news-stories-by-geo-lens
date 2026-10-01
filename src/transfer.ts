// Moving an engaged claim from a story being deleted onto the story that
// survives.
//
// A claim hangs off a story by exactly two incoming relations, and it needs
// both to be real:
//
//   Notable claims   story → claim     the semantic membership
//   Collection item  block → claim     what actually renders on the page
//
// Verified against live data: every Notable claim sits in exactly one
// collection block and every collection item is a Notable claim. Recreating
// only the first would leave a claim that is attached, keeps its votes, and is
// invisible to every reader — so a transfer always writes both.
//
// Claims themselves carry nothing that points back at a story (their outgoing
// relations are Types, Topics and Sources), which is what makes this a clean
// move rather than a rewrite.
import { gql } from './functions.js';
import { compareClaim } from './judge.js';
import { NOTABLE_CLAIMS_RELATION } from './protection.js';
import { PROPERTIES } from './constants.js';

export type BlockItem = { claimId: string; position: string | null };
export type StoryBlock = { id: string; name: string; items: BlockItem[] };

/** One claim's journey from the dropped story to the keeper. */
export type ClaimTransfer = {
  claimId: string;
  claimName: string;
  /** Existing block on the keeper this claim joins. Never a new block: a
   *  transferred claim goes where its subject already lives, or not at all. */
  targetBlockId: string;
  targetBlockName: string;
  /** Position to write on the Collection item relation. Null appends. */
  position: string | null;
  /** Set when this claim takes the place of an unengaged keeper claim that
   *  said the same thing. That claim is deleted in the same proposal. */
  replaces?: { id: string; name: string };
  why: string;
};

/** Why a pair could not be transferred and went to a person instead. */
export type TransferBlocker = { claimName: string; reason: string };

export type TransferPlan =
  | { ok: true; transfers: ClaimTransfer[] }
  | { ok: false; blockers: TransferBlocker[] };

/**
 * The keeper's collection blocks and which claims sit in each.
 *
 * Only called for the handful of pairs where both stories hold engaged claims,
 * so the extra round trip costs nothing across a run.
 */
export async function fetchStoryBlocks(storyId: string): Promise<StoryBlock[]> {
  const data: any = await gql(`query($id: UUID!) {
    entity(id: $id) {
      blocks: relations(first: 30, filter: { typeId: { is: "${PROPERTIES.blocks}" } }) {
        nodes {
          toEntity {
            id name
            items: relations(first: 60, filter: { typeId: { is: "${PROPERTIES.collection_item}" } }) {
              nodes { position toEntity { id } }
            }
          }
        }
      }
    }
  }`, { id: storyId });

  const out: StoryBlock[] = [];
  for (const b of data.entity?.blocks?.nodes ?? []) {
    const e = b.toEntity;
    if (!e?.id) continue;
    out.push({
      id: e.id,
      name: e.name ?? '',
      items: (e.items?.nodes ?? [])
        .map((i: any) => ({ claimId: i.toEntity?.id as string, position: i.position ?? null }))
        .filter((i: BlockItem) => !!i.claimId),
    });
  }
  return out;
}

/** Which block holds a given claim, if any. */
export function blockOf(blocks: StoryBlock[], claimId: string): StoryBlock | null {
  return blocks.find(b => b.items.some(i => i.claimId === claimId)) ?? null;
}

/** The position recorded for a claim inside its block. */
export function positionOf(blocks: StoryBlock[], claimId: string): string | null {
  for (const b of blocks) {
    const item = b.items.find(i => i.claimId === claimId);
    if (item) return item.position;
  }
  return null;
}

/**
 * Turn one comparison verdict into a transfer, or into a reason it cannot happen.
 *
 * Three outcomes, matching the rule agreed with Armando:
 *
 *   no duplicate on the keeper      → join the block of the closest claim
 *   duplicate, keeper's is untouched → replace it: it says the same thing and
 *                                      nobody has voted on it, so the engaged
 *                                      copy is strictly the better one to keep
 *   duplicate, keeper's is engaged   → stop. Two claims saying one thing with
 *                                      votes on both is a merge decision, and
 *                                      no rule picks whose votes to discard.
 */
export function planOneTransfer(args: {
  claim: { id: string; name: string };
  keeperBlocks: StoryBlock[];
  /** Index into keeperClaims that says the same thing, or null. */
  duplicateOf: { id: string; name: string } | null;
  /** Index into keeperClaims that is thematically nearest. */
  closestTo: { id: string; name: string } | null;
  /** Is that duplicate claim itself voted on or ranked? */
  duplicateIsEngaged: boolean;
}): ClaimTransfer | TransferBlocker {
  const { claim, keeperBlocks, duplicateOf, closestTo, duplicateIsEngaged } = args;

  if (duplicateOf) {
    if (duplicateIsEngaged) {
      return {
        claimName: claim.name,
        reason: `both copies of this claim are engaged ("${duplicateOf.name.slice(0, 60)}") — needs a person to merge`,
      };
    }
    const block = blockOf(keeperBlocks, duplicateOf.id);
    if (!block) {
      return { claimName: claim.name, reason: 'the keeper claim it replaces is not in any block' };
    }
    return {
      claimId: claim.id,
      claimName: claim.name,
      targetBlockId: block.id,
      targetBlockName: block.name,
      // Slot into the position the replaced claim occupied, so the story reads
      // the same afterwards — just backed by the copy people engaged with.
      position: positionOf(keeperBlocks, duplicateOf.id),
      replaces: { id: duplicateOf.id, name: duplicateOf.name },
      why: `replaces an unengaged duplicate in "${block.name}"`,
    };
  }

  const anchor = closestTo ? blockOf(keeperBlocks, closestTo.id) : null;
  if (!anchor) {
    // Deliberately no fallback. A transferred claim belongs beside the claims
    // it is about; a block invented to hold one orphan is worse than leaving
    // the pair for a person.
    return { claimName: claim.name, reason: 'no block on the keeper covers this subject' };
  }
  return {
    claimId: claim.id,
    claimName: claim.name,
    targetBlockId: anchor.id,
    targetBlockName: anchor.name,
    position: null,
    why: `joins "${anchor.name}"`,
  };
}

export function isBlocker(x: ClaimTransfer | TransferBlocker): x is TransferBlocker {
  return 'reason' in x;
}

/**
 * Plan every engaged claim's move from the dropped story onto the keeper.
 *
 * All or nothing. If a single claim cannot be placed the whole plan fails, and
 * the pair goes to a person untouched — moving the rest would delete the story
 * still holding the one that could not move, which is the exact loss this
 * whole path exists to prevent.
 */
export async function planTransfers(args: {
  keeperId: string;
  keeperClaims: { id: string; name: string }[];
  /** Which of the keeper's own claims are themselves voted on or ranked. */
  keeperEngagedIds: Set<string>;
  /** Every claim on the dropped story, for looking names up. */
  loserClaims: { id: string; name: string }[];
  /** The subset of those that carry engagement, i.e. what has to move. */
  engagedOnLoser: { id: string }[];
  model: string;
  apiKey: string;
}): Promise<TransferPlan> {
  const { keeperId, keeperClaims, keeperEngagedIds, loserClaims, engagedOnLoser, model, apiKey } = args;

  const keeperBlocks = await fetchStoryBlocks(keeperId);
  const transfers: ClaimTransfer[] = [];
  const blockers: TransferBlocker[] = [];
  /** Keeper claims already spoken for. One claim cannot be replaced twice. */
  const claimed = new Set<string>();

  for (const { id } of engagedOnLoser) {
    const claim = loserClaims.find(c => c.id === id) ?? { id, name: '' };
    let match;
    try {
      match = await compareClaim(claim.name, keeperClaims.map(c => c.name), model, apiKey);
    } catch (e) {
      // An unanswered comparison is not a licence to move blindly.
      blockers.push({ claimName: claim.name, reason: `could not compare: ${String(e).slice(0, 50)}` });
      continue;
    }
    const planned = planOneTransfer({
      claim,
      keeperBlocks,
      duplicateOf: match.duplicateIndex !== null ? keeperClaims[match.duplicateIndex] : null,
      closestTo: match.closestIndex !== null ? keeperClaims[match.closestIndex] : null,
      duplicateIsEngaged: match.duplicateIndex !== null
        && keeperEngagedIds.has(keeperClaims[match.duplicateIndex].id),
    });
    if (isBlocker(planned)) { blockers.push(planned); continue; }
    // Two moved claims both matching one keeper claim means the dropped story
    // says the same thing twice. Replacing it twice would delete one claim and
    // leave two in its place, so a person decides instead.
    if (planned.replaces) {
      if (claimed.has(planned.replaces.id)) {
        blockers.push({
          claimName: claim.name,
          reason: `two moved claims both replace "${planned.replaces.name.slice(0, 50)}"`,
        });
        continue;
      }
      claimed.add(planned.replaces.id);
    }
    transfers.push(planned);
  }

  return blockers.length ? { ok: false, blockers } : { ok: true, transfers };
}

/** Relation type ids a transfer writes. Re-exported so the publish step does
 *  not need to know where they came from. */
export const TRANSFER_RELATIONS = {
  notableClaims: NOTABLE_CLAIMS_RELATION,
  collectionItem: PROPERTIES.collection_item,
};
