// What a scan decided, and why — rendered for a terminal and for a browser.
//
// Both renderers live here on purpose. The feedback that produced this file was
// "half-readable tables, with no clear way to compare the headlines,
// descriptions, and summaries, and no clickable links", and the fix is only
// real if what you see on running the scan is the same thing the shareable
// report shows. One set of types, two renderers, no drift.
//
// The console output is the primary surface: it is what someone sees the moment
// they run the command. The HTML file is the supplement — a 500-character
// Summary on each side is cramped in a terminal, and the file can be forwarded
// or reopened without paying for another scan.

export type ReportSide = {
  id: string; name: string; backlinks: number; relations: number;
  description: string; summary: string; date: string | null;
  claimCount: number; engagedClaims: number;
  /** Human phrase for the engagement, e.g. "2 claims engaged (1↑, 1 ranked)". */
  engagement?: string;
};

export type ReportTransfer = {
  claimId: string; claimName: string; targetBlockName: string;
  replaces?: { id: string; name: string }; why: string;
};

export type ReportPair = {
  space: string; spaceId: string;
  keep: ReportSide; drop: ReportSide;
  confidence: number; evidence: string;
  transfers?: ReportTransfer[];
};

/** A pair detection surfaced and the scan then declined to queue. */
export type ReportSkipped = {
  space: string; spaceId: string; reason: string;
  stories: { id: string; name: string; date: string }[];
};

const GEO = 'https://www.geobrowser.io/space';
export const geoUrl = (spaceId: string, id: string) => `${GEO}/${spaceId}/${id}`;

// ─── console ────────────────────────────────────────────────────────────────

const tty = Boolean(process.stdout.isTTY);
const c = {
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (tty ? `\x1b[36m${s}\x1b[0m` : s),
};

/** Wrap to width, indenting every line after the first. */
function wrap(text: string, width: number, indent: string): string[] {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : indent + l));
}

const WIDTH = 96;
const LABEL = 12;

function field(label: string, text: string, bodyWidth = WIDTH - LABEL - 10): string[] {
  if (!text?.trim()) return [];
  // Matches the 9-space gutter + padded label of the first line exactly, so
  // wrapped text sits flush under where the value started.
  const indent = ' '.repeat(9 + LABEL);
  const lines = wrap(text, bodyWidth, indent);
  return [`         ${c.dim(label.padEnd(LABEL))}${lines[0]}`, ...lines.slice(1)];
}

function sideConsole(side: ReportSide, spaceId: string, role: 'keep' | 'drop'): string[] {
  const tag = role === 'keep' ? c.green('KEEP  ') : c.red('DELETE');
  const engaged = side.engagedClaims > 0
    ? c.cyan(` · ${side.engagement || `${side.engagedClaims} engaged`}`)
    : '';
  const out = [
    `  ${tag}  ${c.bold(side.name || '(untitled)')}`,
    `         ${c.dim(`${side.date ?? 'no date'} · ${side.claimCount} claims · ${side.backlinks} backlinks · ${side.relations} relations`)}${engaged}`,
    `         ${geoUrl(spaceId, side.id)}`,
  ];
  out.push(...field('Description', side.description));
  out.push(...field('Summary', side.summary));
  return out;
}

/**
 * One pair, in full, for someone reading the terminal.
 *
 * Used by the scan AND by the publish step. Publish is the last screen before a
 * proposal goes on chain, so it shows exactly what the scan showed rather than a
 * shortened restatement of it — a compact summary there meant deciding on less
 * information than the scan had already gathered.
 *
 * `index` numbers the pair when publish lists them, so the number lines up with
 * the "how many to propose" answer.
 */
export function renderPairConsole(p: ReportPair, index?: number): string {
  const conf = p.confidence >= 0.9 ? c.green(p.confidence.toFixed(2))
    : p.confidence >= 0.75 ? c.yellow(p.confidence.toFixed(2))
    : c.dim(p.confidence.toFixed(2));

  const n = index === undefined ? '' : `${c.bold(`#${index}`)}  `;
  const lines: string[] = ['', `  ${n}${conf}  ${c.dim(p.evidence)}`, ''];
  lines.push(...sideConsole(p.keep, p.spaceId, 'keep'), '');
  lines.push(...sideConsole(p.drop, p.spaceId, 'drop'), '');

  const moved = p.transfers ?? [];
  if (moved.length) {
    lines.push(`  ${c.cyan('CLAIMS')}  ${moved.length} to transfer before the delete`);
    for (const t of moved) {
      lines.push(...wrap(`• ${t.claimName}`, WIDTH - 12, ' '.repeat(12)).map(l => `         ${l}`));
      lines.push(`           ${c.dim(`→ into block "${t.targetBlockName}"`)}`);
      if (t.replaces) {
        lines.push(...wrap(`→ replaces "${t.replaces.name}", which nobody engaged with`, WIDTH - 14, ' '.repeat(14))
          .map(l => `           ${c.dim(l)}`));
      }
    }
  } else {
    // Never silent: silence here read as "claims were never considered", which
    // was exactly the review complaint. Nothing to move is itself a finding.
    lines.push(`  ${c.cyan('CLAIMS')}  ${c.dim(`nothing to move — no claim on the deleted story carries a vote or ranking; the kept story keeps its ${p.keep.claimCount}`)}`);
  }
  return lines.join('\n');
}

/** Counts by reason, so "candidates it didn't select" is a pattern not a list. */
export function renderSkippedConsole(skipped: ReportSkipped[]): string {
  if (!skipped.length) return '';
  const byReason = new Map<string, number>();
  for (const s of skipped) {
    const key = s.reason.split('—')[0].trim();
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  const rows = [...byReason.entries()].sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `    ${String(n).padStart(4)}  ${r}`);
  return [`  ${c.dim('Considered and not queued:')}`, ...rows].join('\n');
}

// ─── html ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
}

function sideHtml(side: ReportSide, spaceId: string, role: 'keep' | 'drop'): string {
  const engaged = side.engagedClaims > 0
    ? `<span class="badge">${esc(side.engagement || `${side.engagedClaims} engaged`)}</span>` : '';
  return `<div class="side ${role}">
    <div class="role">${role === 'keep' ? 'KEEP' : 'DELETE'}</div>
    <h3><a href="${geoUrl(spaceId, side.id)}" target="_blank" rel="noreferrer">${esc(side.name) || '(untitled)'}</a></h3>
    <div class="meta">${side.date ?? 'no date'} · ${side.claimCount} claims · ${side.backlinks} backlinks · ${side.relations} relations ${engaged}</div>
    <div class="field"><span class="label">Description</span>${esc(side.description) || '<em>none</em>'}</div>
    <div class="field"><span class="label">Summary</span>${esc(side.summary) || '<em>none</em>'}</div>
    <div class="linkrow"><a href="${geoUrl(spaceId, side.id)}" target="_blank" rel="noreferrer">open in Geo →</a></div>
  </div>`;
}

function claimsHtml(p: ReportPair): string {
  const moved = p.transfers ?? [];
  if (!moved.length) {
    return `<div class="claims"><span class="label">Claims</span>Nothing to move — no claim on the deleted story carries a vote or a ranking. Its claims go with it; the kept story keeps its ${p.keep.claimCount}.</div>`;
  }
  return `<div class="claims"><span class="label">Claims to transfer (${moved.length})</span><ul>${
    moved.map(t => `<li><strong>${esc(t.claimName)}</strong><br>→ into block <em>${esc(t.targetBlockName)}</em>${
      t.replaces ? `<br>→ replaces <em>${esc(t.replaces.name)}</em>, which nobody engaged with` : ''}</li>`).join('')
  }</ul></div>`;
}

export function renderReport(
  pairs: ReportPair[],
  skipped: ReportSkipped[],
  meta: { createdAt: string; model: string; range?: string },
): string {
  const bySpace = new Map<string, ReportPair[]>();
  for (const p of pairs) {
    if (!bySpace.has(p.space)) bySpace.set(p.space, []);
    bySpace.get(p.space)!.push(p);
  }

  const sections = [...bySpace.entries()].map(([space, ps]) => `
    <h2>${esc(space)} <span class="count">${ps.length} duplicate${ps.length === 1 ? '' : 's'}</span></h2>
    ${ps.slice().sort((a, b) => b.confidence - a.confidence).map(p => `
      <div class="pair">
        <div class="pairhead">
          <span class="conf ${p.confidence >= 0.9 ? 'high' : p.confidence >= 0.75 ? 'mid' : 'low'}">${p.confidence.toFixed(2)}</span>
          <span class="why">${esc(p.evidence)}</span>
        </div>
        <div class="sides">${sideHtml(p.keep, p.spaceId, 'keep')}${sideHtml(p.drop, p.spaceId, 'drop')}</div>
        ${claimsHtml(p)}
      </div>`).join('')}`).join('');

  const byReason = new Map<string, ReportSkipped[]>();
  for (const s of skipped) {
    const key = s.reason.split('—')[0].trim();
    if (!byReason.has(key)) byReason.set(key, []);
    byReason.get(key)!.push(s);
  }
  const skippedHtml = !byReason.size ? '' : `
    <h2>Considered but not queued <span class="count">${skipped.length}</span></h2>
    <p class="note">Detection surfaced these and the scan declined them. Nothing here is deleted.</p>
    ${[...byReason.entries()].sort((a, b) => b[1].length - a[1].length).map(([reason, items]) => `
      <details><summary><strong>${esc(reason)}</strong> — ${items.length}</summary>
        ${items.map(i => `<div class="skip"><div class="skipreason">${esc(i.reason)}</div>
          ${i.stories.map(s => `<div>· <a href="${geoUrl(i.spaceId, s.id)}" target="_blank" rel="noreferrer">${esc(s.name) || s.id}</a> <span class="meta">${esc(s.date)}</span></div>`).join('')}
        </div>`).join('')}
      </details>`).join('')}`;

  return `<meta charset="utf-8"><title>News duplicates — ${meta.createdAt.slice(0, 10)}</title>
<style>
 body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:1180px;margin:32px auto;padding:0 20px;color:#1a1a1a}
 h1{margin:0 0 4px}h2{margin:36px 0 12px;border-bottom:2px solid #eee;padding-bottom:6px}
 .count{font-weight:400;color:#666;font-size:15px}.sub{color:#666;margin:0 0 8px}
 .pair{border:1px solid #e2e2e2;border-radius:10px;margin:14px 0;overflow:hidden}
 .pairhead{display:flex;gap:10px;align-items:center;background:#fafafa;padding:9px 14px;border-bottom:1px solid #eee}
 .conf{font-weight:700;padding:2px 9px;border-radius:20px;color:#fff;font-size:13px}
 .conf.high{background:#1a7f37}.conf.mid{background:#b36b00}.conf.low{background:#8b8b8b}
 .why{color:#555;font-size:13px}
 .sides{display:grid;grid-template-columns:1fr 1fr}
 .side{padding:14px 16px}.side.keep{background:#f4fbf5;border-right:1px solid #eee}.side.drop{background:#fdf6f6}
 .role{font-size:11px;font-weight:700;letter-spacing:.09em}
 .side.keep .role{color:#1a7f37}.side.drop .role{color:#b42318}
 .side h3{margin:4px 0 6px;font-size:16px;line-height:1.35}
 .side h3 a{color:#0b4fa8;text-decoration:none}.side h3 a:hover{text-decoration:underline}
 .meta{color:#666;font-size:12.5px;margin-bottom:10px}
 .badge{background:#0b4fa8;color:#fff;padding:1px 7px;border-radius:10px;font-size:11px;margin-left:6px}
 .field{margin:8px 0;font-size:13.5px}
 .label{display:block;font-size:11px;font-weight:700;color:#888;letter-spacing:.06em;text-transform:uppercase;margin-bottom:2px}
 .linkrow{margin-top:10px;font-size:13px}
 .claims{padding:11px 16px;background:#fffdf5;border-top:1px solid #eee;font-size:13.5px}
 .claims ul{margin:6px 0 0;padding-left:20px}.claims li{margin-bottom:7px}
 details{margin:8px 0;border:1px solid #eee;border-radius:8px;padding:9px 12px}summary{cursor:pointer}
 .skip{margin:9px 0 9px 8px;padding-left:10px;border-left:3px solid #eee;font-size:13.5px}
 .skipreason{color:#8a6d00;margin-bottom:3px}.note{color:#666;font-size:13.5px}a{color:#0b4fa8}
 @media(max-width:820px){.sides{grid-template-columns:1fr}.side.keep{border-right:none;border-bottom:1px solid #eee}}
</style>
<h1>News story duplicates</h1>
<p class="sub">${new Date(meta.createdAt).toUTCString()} · judged by ${esc(meta.model)}${meta.range ? ` · ${esc(meta.range)}` : ''}<br>
${pairs.length} pair${pairs.length === 1 ? '' : 's'} queued for deletion · ${skipped.length} considered and rejected</p>
<p class="note">Each pair deletes the story on the right and keeps the one on the left. Nothing is deleted by this report —
deletions are on-chain proposals an editor still has to accept.</p>
${sections}
${skippedHtml}`;
}
