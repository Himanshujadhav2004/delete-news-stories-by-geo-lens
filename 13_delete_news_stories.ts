import { printOps, publishOps, preflight } from './src/functions.js';
import {
  deleteEntity,
  type OpsBatch,
} from './src/entity_ops.js';
import { TYPES } from './src/constants.js';
import { readFileSync } from 'fs';

// Only delete orphans of these types — entities like Person, Company etc. are kept
const ORPHAN_TYPES = new Set([
  TYPES.text_block,
  TYPES.data_block,
  TYPES.image,
  TYPES.topic,
  TYPES.claim,
  TYPES.article,
  TYPES.quote,
  TYPES.page
]);

const SPACE_SLUGS: Record<string, string> = {
  'crypto': 'c9f267dcb0d270718c2a3c45a64afd32',
  'ai': '41e851610e13a19441c4d980f2f2ce6b',
  'world-affairs': '89bd89bf28ff8a0963faf92a8c905e20',
  'health': '52c7ae149838b6d47ce0f3b2a5974546',
  'us-politics': '4582fbbee28a16589154f7e36f1ee3c5',
};

const BATCH_NUM = process.argv[2];
const CSV_PATH = process.argv[3];
if (!BATCH_NUM || !CSV_PATH) {
  console.error('Usage: bun run 13_delete_news_stories.ts <batch_number> <csv_path> [--publish]');
  console.error('CSV needs an entity_id column plus a space column (slug or space id) or a geo_url column.');
  console.error('If a "delete" column exists, only rows marked yes/true/1/x are deleted.');
  process.exit(1);
}

// --- CSV parsing (handles quoted fields with commas) ---
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
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

const raw = parseCsv(readFileSync(CSV_PATH, 'utf8'));
const header = raw[0].map(h => h.trim().toLowerCase());
const col = (name: string) => header.indexOf(name);
const iEntity = col('entity_id');
const iSpace = col('space');
const iUrl = col('geo_url');
const iDelete = col('delete');
if (iEntity < 0 || (iSpace < 0 && iUrl < 0)) {
  console.error(`CSV must have an entity_id column and a space or geo_url column. Found: ${header.join(', ')}`);
  process.exit(1);
}

function resolveSpaceId(row: string[]): string | null {
  if (iSpace >= 0) {
    const s = row[iSpace]?.trim() ?? '';
    if (/^[0-9a-f]{32}$/.test(s)) return s;
    if (SPACE_SLUGS[s]) return SPACE_SLUGS[s];
  }
  if (iUrl >= 0) {
    const m = row[iUrl]?.match(/\/space\/([0-9a-f]{32})\//);
    if (m) return m[1];
  }
  return null;
}

// --- collect entities per space ---
const bySpace = new Map<string, string[]>();
let skippedUnmarked = 0, skippedBadSpace = 0;
const seen = new Set<string>();
for (const row of raw.slice(1)) {
  if (iDelete >= 0 && !/^(yes|true|1|x)$/i.test(row[iDelete]?.trim() ?? '')) { skippedUnmarked++; continue; }
  const entityId = row[iEntity]?.trim();
  if (!entityId || !/^[0-9a-f]{32}$/.test(entityId)) continue;
  const spaceId = resolveSpaceId(row);
  if (!spaceId) { skippedBadSpace++; continue; }
  const key = `${spaceId}|${entityId}`;
  if (seen.has(key)) continue;
  seen.add(key);
  if (!bySpace.has(spaceId)) bySpace.set(spaceId, []);
  bySpace.get(spaceId)!.push(entityId);
}

const DRY_RUN = !process.argv.includes('--publish');
const total = [...bySpace.values()].reduce((s, v) => s + v.length, 0);

// Confirm the network and the signing identity before touching anything — a
// run against the wrong chain, or with an unrecognised wallet, looks exactly
// like a successful one until you go looking for the result.
const { callerSpaceId } = await preflight();
if (!DRY_RUN && !callerSpaceId) {
  console.error('Refusing to publish: this wallet has no personal space on the current network.');
  process.exit(1);
}

console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE PUBLISH'} | entities=${total} across ${bySpace.size} spaces`);
if (skippedUnmarked) console.log(`Skipped ${skippedUnmarked} rows not marked for deletion (delete column)`);
if (skippedBadSpace) console.log(`WARNING: skipped ${skippedBadSpace} rows with unresolvable space`);
for (const [spaceId, ids] of bySpace) console.log(`  ${spaceId}: ${ids.length} entities`);

// --- build delete ops per space ---
for (const [spaceId, entityIds] of bySpace) {
  const batch: OpsBatch = new Map();
  const deletingIds = new Set(entityIds);
  for (const entityId of entityIds) {
    await deleteEntity({
      entityId,
      spaceId,
      opsBatch: batch,
      deletingIds,
      orphanTypeFilter: ORPHAN_TYPES,
    });
  }
  const ops = batch.get(spaceId) ?? [];
  printOps(ops, './output/delete_news', `delete_news_${spaceId}_${BATCH_NUM}.txt`);
  console.log(`\n[${spaceId}] Total ops: ${ops.length} -> ./output/delete_news/delete_news_${spaceId}_${BATCH_NUM}.txt`);

  if (!DRY_RUN) {
    await publishOps(ops, `Delete duplicate news stories - Batch ${BATCH_NUM}`, spaceId);
    console.log(`\n[${spaceId}] Deleted:`);
    for (const entityId of entityIds) {
      console.log(`- https://geobrowser.io/space/${spaceId}/${entityId}`);
    }
  }
}

if (DRY_RUN) {
  console.log('\nDry run complete. Re-run with --publish to submit one proposal per space.');
}
