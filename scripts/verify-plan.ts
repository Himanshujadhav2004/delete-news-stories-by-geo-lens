// Independent safety check on a plan file: re-query the graph and assert that
// no story marked for deletion holds a voted or ranked claim. Deliberately does
// not trust the scan's own bookkeeping — it asks the API again.
import { readFileSync } from 'fs';
import { fetchRankedEntityIds, fetchClaimVotes, NOTABLE_CLAIMS_RELATION } from '../src/protection.js';
import { gql } from '../src/functions.js';

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const drops: { slug: string; id: string; name: string }[] = [];
for (const [slug, s] of Object.entries<any>(plan.spaces))
  for (const c of s.clusters) drops.push({ slug, id: c.drop.id, name: c.drop.name });
console.log(`${drops.length} stories marked for deletion`);

const ranked = await fetchRankedEntityIds(m => console.log('  ' + m));

const claimsOf = new Map<string, string[]>();
for (const d of drops) {
  const data: any = await gql(`query($id: UUID!) {
    entity(id: $id) {
      claims: relations(first: 200, filter: { typeId: { is: "${NOTABLE_CLAIMS_RELATION}" } }) {
        nodes { toEntity { id } }
      }
    }
  }`, { id: d.id });
  claimsOf.set(d.id, [...new Set((data.entity?.claims?.nodes ?? [])
    .map((n: any) => n.toEntity?.id).filter(Boolean) as string[])]);
}
const all = [...new Set([...claimsOf.values()].flat())];
console.log(`${all.length} distinct claims across them`);
const votes = await fetchClaimVotes(all);

let bad = 0;
for (const d of drops) {
  const hits = (claimsOf.get(d.id) ?? []).filter(id => {
    const v = votes.get(id) ?? { up: 0, down: 0 };
    return v.up > 0 || v.down > 0 || ranked.has(id);
  });
  if (hits.length) {
    bad++;
    console.log(`  ✗ [${d.slug}] ${d.name.slice(0, 60)}`);
    for (const h of hits) {
      const v = votes.get(h) ?? { up: 0, down: 0 };
      console.log(`      claim ${h}  ${v.up}↑ ${v.down}↓ ${ranked.has(h) ? 'RANKED' : ''}`);
    }
  }
}
console.log(bad ? `\n✗ ${bad} stories would destroy engagement` : '\n✓ CLEAN — no story marked for deletion holds a voted or ranked claim');
