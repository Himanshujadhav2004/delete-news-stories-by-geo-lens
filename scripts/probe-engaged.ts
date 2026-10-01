// Read-only probe for the v2 engagement work. Publishes nothing, writes nothing.
//
// Two questions the free passes cannot answer on their own:
//   1. which stories hold engaged claims, and do any candidate pairs touch them
//   2. does the transfer planner actually produce a placement against real
//      block data — the path that only fires when BOTH copies are engaged, a
//      case that does not currently exist anywhere in the graph
//
// For (2) the probe forces the counterfactual: it takes a real pair with ONE
// engaged side, treats the engaged story as the loser, and plans the move onto
// the other. Same planTransfers() the real scan calls, so a pass here is a pass
// there.
import { SPACES, candidates, fetchStories, DEFAULT_SUMMARY_SIMILARITY, type Story } from '../src/dedupe.js';
import {
  describeProtection, fetchRankedEntityIds, isProtected, resolveProtection, UNPROTECTED,
} from '../src/protection.js';
import { isBlocker, planTransfers } from '../src/transfer.js';

const slugs = (process.argv[2] ?? 'health').split(',');
/** Plan transfers too. Costs one model call per engaged claim on the loser. */
const WITH_TRANSFERS = process.argv.includes('--transfers');
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';
const KEY = process.env.ANTHROPIC_API_KEY ?? '';

const ranked = await fetchRankedEntityIds(m => console.log('  ' + m));

for (const slug of slugs) {
  const stories = await fetchStories(SPACES[slug]);
  const prot = await resolveProtection(new Map(stories.map(s => [s.id, s.claims.map(c => c.id)])), ranked);
  for (const s of stories) s.protection = prot.get(s.id) ?? UNPROTECTED;
  const engaged = stories.filter(s => isProtected(s.protection));

  console.log(`\n── ${slug}: ${stories.length} stories, ${engaged.length} with engaged claims ──`);
  for (const s of engaged) {
    console.log(`  ${s.id}  ${s.name.slice(0, 70)}`);
    console.log(`      ${describeProtection(s.protection!)}  |  ${s.claims.length} claims total`);
  }

  const cands = candidates(stories, {
    minSimilarity: 0.5, minSummarySimilarity: DEFAULT_SUMMARY_SIMILARITY,
  });
  const engagedIds = new Set(engaged.map(s => s.id));
  const touching = cands.filter(c => engagedIds.has(c.a.id) || engagedIds.has(c.b.id));
  const both = cands.filter(c => engagedIds.has(c.a.id) && engagedIds.has(c.b.id));
  console.log(`  ${cands.length} candidate pairs (free pass); ${touching.length} involve an engaged story; ${both.length} have BOTH engaged`);

  for (const c of touching) {
    console.log(`   * ${engagedIds.has(c.a.id) ? '[E]' : '[ ]'} ${c.a.name.slice(0, 58)}`);
    console.log(`     ${engagedIds.has(c.b.id) ? '[E]' : '[ ]'} ${c.b.name.slice(0, 58)}   (${c.why})`);

    if (!WITH_TRANSFERS || !KEY) continue;
    // Force the both-engaged case: engaged side plays the loser.
    const loser: Story = engagedIds.has(c.a.id) ? c.a : c.b;
    const keeper: Story = loser.id === c.a.id ? c.b : c.a;
    const plan = await planTransfers({
      keeperId: keeper.id,
      keeperClaims: keeper.claims,
      keeperEngagedIds: new Set((keeper.protection ?? UNPROTECTED).claims.map(x => x.id)),
      loserClaims: loser.claims,
      engagedOnLoser: loser.protection!.claims,
      model: MODEL, apiKey: KEY,
    });
    if (!plan.ok) {
      console.log(`       ✗ would go to review: ${plan.blockers.map(b => b.reason).join('; ')}`);
      continue;
    }
    for (const t of plan.transfers) {
      console.log(`       ✓ MOVE "${t.claimName.slice(0, 54)}"`);
      console.log(`           → block "${t.targetBlockName}" (${t.why})`);
      if (t.replaces) console.log(`           replacing "${t.replaces.name.slice(0, 50)}"`);
      console.log(`           position ${t.position ?? '(append)'}`);
    }
  }
}
