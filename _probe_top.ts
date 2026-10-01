// Are the highest-scoring lens pairs real duplicates? If they are, a judge-free
// mode at a high floor is defensible. If they are not, it is the 2026-07 audit
// repeating itself with a better embedding.
import { fetchStories, SPACES, type Story } from './src/dedupe.js';

const URL = process.env.LENS_URL!;
const KEY = process.env.LENS_API_KEY!;
const SPACE = process.argv[2] ?? 'health';
const FLOOR = Number(process.argv[3] ?? '0.97');
const spaceId = SPACES[SPACE];

const stories: Story[] = await fetchStories(spaceId);
const byId = new Map(stories.map(s => [s.id, s]));
const inScope = new Set(stories.map(s => s.id));
const askable = stories.filter(s => s.description?.trim());

const found = new Map<string, number>();
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  for (;;) {
    const i = next++;
    if (i >= askable.length) return;
    const s = askable[i];
    try {
      const res = await fetch(`${URL}/caches/news/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
        body: JSON.stringify({
          strategy: 'vector', input: { text: s.description, field: 'description' },
          k: 8, filters: { spaceIds: [spaceId] }, consistency: 'cached',
        }),
      });
      const body = await res.json() as { hits?: Array<{ id: string; score: number }> };
      for (const h of body.hits ?? []) {
        if (h.id === s.id || !inScope.has(h.id) || h.score < FLOOR) continue;
        found.set([s.id, h.id].sort().join('|'), h.score);
      }
    } catch { /* ignore */ }
  }
}));

console.log(`\n${SPACE}: ${found.size} pairs at or above ${FLOOR}\n${'='.repeat(78)}`);
for (const [key, score] of [...found].sort((a, b) => b[1] - a[1])) {
  const [ia, ib] = key.split('|');
  const a = byId.get(ia)!, b = byId.get(ib)!;
  const sameTitle = a.name.trim() === b.name.trim();
  const sameDesc = a.description.trim() === b.description.trim();
  const sharedUrls = [...a.urls].filter(u => b.urls.has(u)).length;
  console.log(`\nscore ${score.toFixed(4)}   ${sameTitle ? 'IDENTICAL TITLE' : 'different titles'}`
    + `   ${sameDesc ? 'IDENTICAL DESC' : 'different descs'}`
    + `   ${sharedUrls} shared source URL${sharedUrls === 1 ? '' : 's'}`);
  console.log(`  A ${a.id}  ${a.date ? new Date(a.date).toISOString().slice(0, 10) : 'no date'}`
    + `  ${a.backlinks} backlinks, ${a.claims.length} claims`);
  console.log(`    ${a.name.slice(0, 84)}`);
  console.log(`  B ${b.id}  ${b.date ? new Date(b.date).toISOString().slice(0, 10) : 'no date'}`
    + `  ${b.backlinks} backlinks, ${b.claims.length} claims`);
  console.log(`    ${b.name.slice(0, 84)}`);
  if (!sameDesc) {
    console.log(`  A desc: ${a.description.slice(0, 150)}`);
    console.log(`  B desc: ${b.description.slice(0, 150)}`);
  }
}
