import { gql } from '../src/functions.js';
import { fetchClaimVotes, fetchRankedEntityIds, RANK_TYPE, RANK_VOTES_RELATION } from '../src/protection.js';

const id = process.argv[2];
const d: any = await gql(`query($id: UUID!) { entity(id: $id) {
  id name spaceIds types { name }
  backlinks(first: 30) { nodes { fromEntity { id name types { name } } } }
} }`, { id });
const e = d.entity;
console.log('claim   :', e.id);
console.log('name    :', e.name);
console.log('types   :', e.types.map((t: any) => t.name).join(', '));
console.log('spaces  :', e.spaceIds.join(', '));

const votes = await fetchClaimVotes([id]);
const v = votes.get(id) ?? { up: 0, down: 0 };
console.log('votes   :', `${v.up}↑ ${v.down}↓`);
const ranked = await fetchRankedEntityIds();
console.log('ranked  :', ranked.has(id) ? 'YES — appears in a ranking submission' : 'no');

console.log('\nwho points at this claim:');
for (const b of e.backlinks.nodes) {
  const f = b.fromEntity;
  console.log(`  ${f.id}  [${(f.types ?? []).map((t: any) => t.name).join('/') || 'no type'}]  ${(f.name ?? '(unnamed)').slice(0, 62)}`);
}

// Which ranking submissions include it.
const r: any = await gql(`query($id: UUID!) {
  entitiesConnection(typeId: "${RANK_TYPE}", first: 100, filter: { relations: { some: { typeId: { is: "${RANK_VOTES_RELATION}" }, toEntityId: { is: $id } } } }) {
    totalCount nodes { id name spaceIds }
  }
}`, { id }).catch((err: any) => { console.log('\n(rank lookup: ' + String(err).slice(0, 80) + ')'); return null; });
if (r) {
  console.log(`\nranking submissions containing it: ${r.entitiesConnection.totalCount}`);
  for (const n of r.entitiesConnection.nodes) console.log(`  Rank ${n.id}  ${n.name ?? ''}  spaces ${n.spaceIds.join(',')}`);
}
