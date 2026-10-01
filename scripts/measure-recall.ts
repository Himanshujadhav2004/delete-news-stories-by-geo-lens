// Does candidate generation actually find known duplicates?
//
// The 2026-07-21 audit confirmed 187 duplicate pairs by hand. This replays them
// against the current detector and reports what fraction it would surface.
// Pairs whose stories have since been deleted are excluded — nothing can find
// them, and counting them would understate recall.
//
// The free local passes alone measured 29.1%, which is why the sweep exists.
// Run with --sweep to measure the full pipeline; it costs model calls.
//
//   bun run scripts/measure-recall.ts [csv] [--sweep] [--spaces ai,health]
import { readFileSync } from 'fs';
import { DEFAULT_SUMMARY_SIMILARITY, SPACES, candidates, fetchStories, type Story } from '../src/dedupe.js';
import { semanticSweep } from '../src/judge.js';

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const CSV = argv.find(a => a.endsWith('.csv')) ?? '/root/geo-learnings/final-duplicate-stories-2026-07-21.csv';
const WITH_SWEEP = argv.includes('--sweep');
const SIMILARITY = Number(flag('similarity', '0.5'));
// Sweep a range to see what the summary route buys: `--summary-similarity 1.1`
// is above any achievable overlap, which turns the route off for a baseline.
const SUMMARY_SIMILARITY = Number(flag('summary-similarity', String(DEFAULT_SUMMARY_SIMILARITY)));
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { cur.push(field); field = ''; }
    else if (c === '\n') { cur.push(field.replace(/\r$/, '')); rows.push(cur); cur = []; field = ''; }
    else field += c;
  }
  if (field || cur.length) { cur.push(field); rows.push(cur); }
  return rows.filter(r => r.length > 1);
}

const rows = parseCsv(readFileSync(CSV, 'utf8'));
const header = rows[0].map(h => h.trim().toLowerCase());
const iTier = header.indexOf('tier');
const iSpace = header.indexOf('space');
const iCluster = header.indexOf('cluster');
const iEntity = header.indexOf('entity_id');

// Confirmed clusters only — chains are rolling coverage and are not meant to be
// found as duplicates.
const clusters = new Map<string, { space: string; ids: string[] }>();
for (const r of rows.slice(1)) {
  if (r[iTier]?.trim() !== 'confirmed') continue;
  const key = `${r[iSpace]}|${r[iCluster]}`;
  if (!clusters.has(key)) clusters.set(key, { space: r[iSpace].trim(), ids: [] });
  clusters.get(key)!.ids.push(r[iEntity].trim());
}

const truth: Array<{ space: string; a: string; b: string }> = [];
for (const { space, ids } of clusters.values()) {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) truth.push({ space, a: ids[i], b: ids[j] });
  }
}

const only = flag('spaces');
const spacesToTest = [...new Set(truth.map(t => t.space))]
  .filter(s => !only || only.split(',').map(x => x.trim()).includes(s));

console.log(`ground truth: ${truth.length} confirmed pairs`);
console.log(`testing ${spacesToTest.join(', ')} | sweep ${WITH_SWEEP ? `ON (${MODEL})` : 'OFF'}\n`);

const KEY = process.env.ANTHROPIC_API_KEY ?? '';
if (WITH_SWEEP && !KEY) { console.error('ANTHROPIC_API_KEY required for --sweep'); process.exit(1); }

let found = 0, live = 0, gone = 0, candidateCount = 0;
const misses: string[] = [];

for (const slug of spacesToTest) {
  const spaceId = SPACES[slug];
  if (!spaceId) { console.log(`  skip unknown space ${slug}`); continue; }

  const stories = await fetchStories(spaceId);
  const byId = new Map(stories.map((s: Story) => [s.id, s]));

  const swept = new Set<string>();
  if (WITH_SWEEP) {
    const pairs = await semanticSweep(stories,
      { model: MODEL, apiKey: KEY, concurrency: 8 },
      m => process.stdout.write(`\r  ${slug}: ${m}                    `));
    for (const [a, b] of pairs) swept.add([a, b].sort().join('|'));
  }

  const pairs = candidates(stories, {
    minSimilarity: SIMILARITY,
    minSummarySimilarity: SUMMARY_SIMILARITY,
    swept,
  });
  const detected = new Set(pairs.map(p => [p.a.id, p.b.id].sort().join('|')));
  candidateCount += pairs.length;

  const mine = truth.filter(t => t.space === slug);
  const alive = mine.filter(t => byId.has(t.a) && byId.has(t.b));
  gone += mine.length - alive.length;
  live += alive.length;

  let hit = 0;
  for (const t of alive) {
    if (detected.has([t.a, t.b].sort().join('|'))) { hit++; found++; }
    else misses.push(`  ${slug}: ${byId.get(t.a)!.name.slice(0, 52)}\n         ${byId.get(t.b)!.name.slice(0, 52)}`);
  }
  console.log(`\r${slug.padEnd(14)} ${String(stories.length).padStart(4)} stories · ${String(pairs.length).padStart(4)} candidates · found ${hit}/${alive.length}${alive.length ? ` (${((hit / alive.length) * 100).toFixed(0)}%)` : ''}          `);
}

console.log(`\n${gone} ground-truth pairs no longer exist in Geo and were excluded.`);
console.log(`recall: ${found}/${live} = ${live ? ((found / live) * 100).toFixed(1) : '0'}% · ${candidateCount} candidates to judge`);
if (misses.length) {
  console.log(`\nmissed (first 10 of ${misses.length}):`);
  console.log(misses.slice(0, 10).join('\n'));
}
