// The two model steps, both Anthropic, both from the 2026-07-21 news-story
// audit that produced 187 confirmed duplicate pairs.
//
//   sweep  — read a window of headlines and group the ones covering one event.
//            Wide net, cheap per story, and deliberately loose.
//   judge  — take one pair and both full descriptions and decide.
//
// Two stages because the sweep is looser than pair judging: grouping by
// headline within a window says "these look related", which is not the same as
// "deleting one loses nothing". Everything the sweep proposes is judged again.
import type { Candidate, Story } from './dedupe.js';

const API = 'https://api.anthropic.com/v1/messages';

async function anthropic(body: unknown, apiKey: string, attempt = 0): Promise<any> {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 5) throw new Error(`anthropic ${res.status} after retries`);
    await new Promise(r => setTimeout(r, Math.min(2 ** attempt * 1000, 30_000)));
    return anthropic(body, apiKey, attempt + 1);
  }
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

// ─── stage 1: window sweep ──────────────────────────────────────────────────

const SWEEP_TOOL = {
  name: 'record_groups',
  description: 'Record groups of headlines that cover the same underlying event.',
  input_schema: {
    type: 'object' as const,
    properties: {
      groups: {
        type: 'array',
        description: 'Each group is a list of two or more headline numbers covering one event. Omit anything with no match.',
        items: { type: 'array', items: { type: 'integer' } },
      },
    },
    required: ['groups'],
  },
};

/** How much of a summary each headline carries into the sweep. Enough to tell
 *  two same-day stories apart, short enough that a window still fits. */
const SWEEP_SUMMARY_CHARS = 160;

/**
 * One window of headlines in, groups of same-event headlines out.
 *
 * Each line carries a short slice of the story's summary as well as its
 * headline. Headlines alone were missing pairs that describe one event in
 * different words — the summary is what makes them recognisable, and it was
 * adding the summary by hand that surfaced the misses this fixes. Full
 * descriptions still belong to the next stage; this one only needs enough to
 * say "these two might be the same story".
 */
async function sweepWindow(window: Story[], model: string, apiKey: string): Promise<Story[][]> {
  if (window.length < 2) return [];

  const listing = window
    .map((s, i) => {
      const date = s.date ? new Date(s.date).toISOString().slice(0, 10) : '????-??-??';
      // Summary first: it is the longer, more distinctive field. Description is
      // the fallback for the ~1% of stories that have no Summary.
      const body = s.summary || s.description;
      const summary = body
        ? `\n   ${body.replace(/\s+/g, ' ').trim().slice(0, SWEEP_SUMMARY_CHARS)}`
        : '';
      return `${i}. [${date}] ${s.name}${summary}`;
    })
    .join('\n');

  const reply = await anthropic({
    model,
    max_tokens: 2000,
    tools: [SWEEP_TOOL],
    tool_choice: { type: 'tool' as const, name: 'record_groups' },
    messages: [{
      role: 'user',
      content: `News stories published within a few days of each other, from one news space. Each is a headline followed by the opening of its summary.

${listing}

Group the numbers of any stories that cover THE SAME underlying event, so that one of them could be deleted without losing information. Read the summaries as well as the headlines: two write-ups of one event often share no distinctive headline word.

Group them:
- the same announcement, ruling, launch, filing or incident, written up twice

Do NOT group them:
- a later development in a continuing story: a toll that rose, a bill that advanced, a follow-up ruling
- an announcement and its later completion, a proposal and its approval
- separate events involving the same company, country or person
- a roundup alongside a story it happens to mention

Be generous here — a pair you are unsure about is checked properly afterwards, so
include it. Return an empty list if nothing matches.`,
    }],
  }, apiKey);

  const tool = (Array.isArray(reply?.content) ? reply.content : []).find((b: any) => b.type === 'tool_use');
  const raw = tool?.input?.groups;
  // The schema asks for a list of lists, and occasionally a flat list of numbers
  // comes back instead. Iterating that throws on the first number, which took
  // out two windows of a 250-window run before this guard.
  const groups: unknown[] = Array.isArray(raw) ? raw : [];
  return groups
    .filter((g): g is number[] => Array.isArray(g))
    .map(g => [...new Set(g)].filter(i => Number.isInteger(i) && i >= 0 && i < window.length).map(i => window[i]))
    .filter(g => g.length >= 2);
}

/**
 * How many days of stories go into one sweep call.
 *
 * This is a batching size, not a detection setting: a whole space will not fit
 * in one prompt, so it is read in chunks. Long-range duplicates are the
 * candidate pass's job — it compares every pair in the space with no date
 * limit — while the sweep's job is catching same-event paraphrases, which are
 * published within days of each other by definition.
 */
const SWEEP_WINDOW_DAYS = 8;

/** Windows are anchored to this epoch rather than to the earliest story, so a
 *  window covers the same dates on every run. If boundaries shifted whenever an
 *  older story appeared, every cache key would change and the whole space would
 *  be re-swept for the sake of one backfilled story. */
const WINDOW_EPOCH = Date.UTC(2020, 0, 1);

/** Content fingerprint, so a key changes exactly when the text does. */
function fnv1a(text: string): string {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Identity of one window: which stories are in it and what they say. */
function windowKey(window: Story[]): string {
  // Includes the summary because the sweep prompt now shows it. Leaving it out
  // would reuse results computed from a different prompt for the same window.
  const body = window.map(s => `${s.id}\n${s.name}\n${s.summary}\n${s.description}`).sort().join('\n--\n');
  return `${window.length}.${fnv1a(body)}`;
}

/** Sweep results keyed by window fingerprint, persisted between runs. */
export type SweepCache = Record<string, Array<[string, string]>>;

/**
 * Sweep a whole space in overlapping windows.
 *
 * Windows step by half their width so a pair either side of a boundary is still
 * seen together once — stepping by the full width would hide exactly the pairs
 * that sit on the seam.
 *
 * Every window is swept every run. What keeps that affordable is the cache:
 * a window is identified by the text of the stories in it, so an untouched
 * stretch of history is free and only windows containing something new or
 * edited cost a call. That is strictly better than the old "skip windows with
 * no new stories" rule, which was also blind to a story whose text had changed.
 */
export async function semanticSweep(
  stories: Story[],
  opts: {
    model: string; apiKey: string; concurrency: number;
    /** Read and written in place; persist it to make the next run cheap. */
    cache?: SweepCache;
  },
  log: (msg: string) => void = () => {},
): Promise<Array<[string, string]>> {
  const dated = stories.filter(s => s.date != null).sort((a, b) => a.date! - b.date!);
  if (dated.length < 2) return [];

  const windowMs = SWEEP_WINDOW_DAYS * 86_400_000;
  const stepMs = windowMs / 2;
  const end = dated[dated.length - 1].date!;
  const start = WINDOW_EPOCH + Math.floor((dated[0].date! - WINDOW_EPOCH) / stepMs) * stepMs;

  const windows: Story[][] = [];
  for (let t = start; t <= end; t += stepMs) {
    const slice = dated.filter(s => s.date! >= t && s.date! < t + windowMs);
    if (slice.length >= 2) windows.push(slice);
  }

  const cache = opts.cache;
  const keys = windows.map(windowKey);
  const cached = cache ? keys.filter(k => cache[k]).length : 0;
  log(`${windows.length} windows of ~${Math.round(dated.length / Math.max(windows.length, 1) * 2)} stories`
    + (cached ? `, ${cached} unchanged since the last run` : ''));

  const pairs = new Set<string>();
  const add = (found: Array<[string, string]>) => { for (const p of found) pairs.add(p.join('|')); };

  let done = 0;
  let next = 0;
  let calls = 0;
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, windows.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= windows.length) return;
      const hit = cache?.[keys[i]];
      if (hit) { add(hit); done++; continue; }
      try {
        const found: Array<[string, string]> = [];
        for (const group of await sweepWindow(windows[i], opts.model, opts.apiKey)) {
          // A group of N becomes every pair within it; clustering later puts
          // them back together, and every pair is judged on its own merits.
          for (let x = 0; x < group.length; x++) {
            for (let y = x + 1; y < group.length; y++) {
              found.push([group[x].id, group[y].id].sort() as [string, string]);
            }
          }
        }
        calls++;
        // Cached only on success — a window that threw must be retried next run,
        // not remembered as having found nothing.
        if (cache) cache[keys[i]] = found;
        add(found);
      } catch (e) {
        log(`window ${i} failed: ${String(e).slice(0, 70)}`);
      }
      if (++done % 5 === 0) log(`swept ${done}/${windows.length} windows, ${pairs.size} pairs so far`);
    }
  }));
  log(`${calls} window${calls === 1 ? '' : 's'} sent to the model, ${windows.length - calls} reused`);

  return [...pairs].map(p => p.split('|') as [string, string]);
}

// ─── stage 2: pair judgement ────────────────────────────────────────────────

// Three outcomes, not two: "uncertain" is a real answer and it routes to a
// person. Collapsing it into "not a duplicate" would quietly discard the pairs
// most worth a human glance.
export type Verdict = {
  verdict: 'duplicate' | 'not_duplicate' | 'uncertain';
  confidence: number;
  reason: string;
};

const JUDGE_TOOL = {
  name: 'record_verdict',
  description: 'Record whether the two news stories are duplicates.',
  input_schema: {
    type: 'object' as const,
    properties: {
      verdict: { type: 'string', enum: ['duplicate', 'not_duplicate', 'uncertain'] },
      confidence: { type: 'number', description: '0 to 1' },
      reasoning: { type: 'string', description: 'under 20 words' },
    },
    required: ['verdict', 'confidence', 'reasoning'],
  },
};

/**
 * A stable key for a pair, changing only if either story's text changes.
 *
 * The judging cost of a daily run is otherwise dominated by re-deciding pairs
 * that were settled weeks ago. Keying on content rather than id alone means an
 * edited story is reconsidered, which is the one case where a stale "not a
 * duplicate" would be wrong.
 */
export function pairKey(pair: Candidate): string {
  // Summary is part of the key: it is now shown to the judge, so a story whose
  // summary changed must be reconsidered. Adding it here also correctly voided
  // every verdict decided before the judge could see summaries at all.
  const text = (s: { name: string; description: string; summary: string }) =>
    `${s.name}\n${s.description}\n${s.summary}`;
  // Joined on NUL: a separator that cannot occur inside a headline or summary.
  // This byte was literal in the source until 2026-08-18, which made the whole
  // file read as binary to grep and other tooling. Written as an escape now.
  // Do not "tidy" it to a space: that rehashes every pair and voids the cache.
  const body = [text(pair.a), text(pair.b)].sort().join('\0');
  return `${[pair.a.id, pair.b.id].sort().join('|')}@${fnv1a(body)}`;
}

// ─── stage 3: claim comparison, for transfers ───────────────────────────────

// Asked once per claim being moved. Two questions in one call because both
// answers come from the same reading: does the keeper already say this, and if
// not, which of its claims is this closest to? The second answer decides which
// collection block the claim joins, so a moved claim lands beside its subject
// rather than in a block of its own.
const CLAIM_TOOL = {
  name: 'record_claim_match',
  description: 'Record whether an existing claim says the same thing, and which is closest.',
  input_schema: {
    type: 'object' as const,
    properties: {
      duplicate_index: {
        type: ['integer', 'null'],
        description: 'Index of the existing claim asserting the SAME fact, or null if none does.',
      },
      closest_index: {
        type: ['integer', 'null'],
        description: 'Index of the existing claim on the most similar subject, even if it asserts something different. Null only if none are related at all.',
      },
      reasoning: { type: 'string', description: 'under 20 words' },
    },
    required: ['duplicate_index', 'closest_index', 'reasoning'],
  },
};

export type ClaimMatch = { duplicateIndex: number | null; closestIndex: number | null; reason: string };

/**
 * Compare one claim against the claims already on the keeper.
 *
 * Word overlap cannot do this job. Two duplicate stories are enriched from
 * different sources, so they state the same fact in different words — the exact
 * case a token comparison misses, and the reason this is worth a model call.
 * It stays cheap because only claims someone has voted on or ranked are ever
 * moved, and there are a few hundred of those in the whole graph.
 */
export async function compareClaim(
  claim: string,
  existing: string[],
  model: string,
  apiKey: string,
): Promise<ClaimMatch> {
  if (!existing.length) return { duplicateIndex: null, closestIndex: null, reason: 'keeper has no claims' };

  const listing = existing.map((c, i) => `${i}. ${c}`).join('\n');
  const reply = await anthropic({
    model,
    max_tokens: 400,
    tools: [CLAIM_TOOL],
    tool_choice: { type: 'tool' as const, name: 'record_claim_match' },
    messages: [{
      role: 'user',
      content: `A claim is being moved onto a news story that already carries the claims below.

CLAIM BEING MOVED
${claim}

CLAIMS ALREADY ON THE STORY
${listing}

Two questions.

1. duplicate_index — does any existing claim assert THE SAME FACT? Same fact in different words still counts; these come from different outlets and rarely share wording. A claim about the same subject that asserts something different is NOT a duplicate: a revised figure, a later development, or a different aspect all stand on their own. Null if none.

2. closest_index — which existing claim is about the most similar subject? This decides where the moved claim is filed, so pick the one a reader would expect to find it next to. Answer this even when duplicate_index is null. Null only if nothing on the story is related.`,
    }],
  }, apiKey);

  const tool = (reply.content ?? []).find((b: any) => b.type === 'tool_use');
  if (!tool) throw new Error('no tool_use block in claim comparison');
  const input = tool.input ?? {};
  const idx = (v: unknown): number | null =>
    Number.isInteger(v) && (v as number) >= 0 && (v as number) < existing.length ? (v as number) : null;
  return {
    duplicateIndex: idx(input.duplicate_index),
    closestIndex: idx(input.closest_index),
    reason: String(input.reasoning ?? '').slice(0, 120),
  };
}

export async function judgePair(pair: Candidate, model: string, apiKey: string): Promise<Verdict> {
  const reply = await anthropic({
    model,
    max_tokens: 400,
    tools: [JUDGE_TOOL],
    tool_choice: { type: 'tool' as const, name: 'record_verdict' },
    messages: [{
      role: 'user',
      content: `Two news story entities from a knowledge graph. Decide whether they are DUPLICATES: the same event, reported twice, such that deleting one loses nothing.

STORY A
Headline: ${pair.a.name}
Published: ${pair.a.date ? new Date(pair.a.date).toISOString().slice(0, 10) : 'unknown'}
Description: ${pair.a.description.slice(0, 1500) || '(none)'}
Summary: ${pair.a.summary.slice(0, 2000) || '(none)'}

STORY B
Headline: ${pair.b.name}
Published: ${pair.b.date ? new Date(pair.b.date).toISOString().slice(0, 10) : 'unknown'}
Description: ${pair.b.description.slice(0, 1500) || '(none)'}
Summary: ${pair.b.summary.slice(0, 2000) || '(none)'}

NOT duplicates, however similar they read:
- a later development in the same ongoing story (a toll that rose, a bill that advanced, a follow-up ruling)
- the same subject at a different stage: an announcement and its completion, a proposal and its approval
- one covering a detail or angle the other does not
- a roundup that happens to mention the other's event

Duplicates:
- the same event, same facts, nothing in one that the other lacks
- one is a strict subset of the other

Why this pair was flagged: ${pair.why}

Answer "uncertain" rather than guessing when the descriptions do not settle it. A
wrong deletion is unrecoverable; an uncertain pair goes to a person, which costs
almost nothing.`,
    }],
  }, apiKey);

  const tool = (reply.content ?? []).find((b: any) => b.type === 'tool_use');
  if (!tool) throw new Error('no tool_use block in judgement');
  const input = tool.input ?? {};
  const verdict = ['duplicate', 'not_duplicate', 'uncertain'].includes(input.verdict)
    ? input.verdict : 'uncertain';
  return {
    verdict,
    confidence: Math.max(0, Math.min(1, Number(input.confidence) || 0)),
    reason: String(input.reasoning ?? '').slice(0, 120),
  };
}
