// mend: one patch tool for every AI edit format (SPEC.md).
// Reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edit
// calls, matches the lines an edit names at the first of three tiers
// (exact, trailing-whitespace-insensitive, fully trim-insensitive),
// and writes every change or none. Node 22, standard library only.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL
// set; the last lines hand over to runner.ts, kept as the kit has it.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class ParseProblem {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class EditProblem {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const stripTrailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function pathSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function demandSafe(p: string): void {
  if (!pathSafe(p)) throw new EditProblem('unsafe', p);
}

// A text file split into lines on its own line break.
interface FileParts {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileParts {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, finalBreak: false };
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function joinFile(parts: FileParts): string {
  if (parts.lines.length === 0) return '';
  return parts.lines.join(parts.br) + (parts.finalBreak ? parts.br : '');
}

// The tree as the edits leave it. `now` holds only paths an edit touched
// (null means deleted); anything else is read from disk on demand.
class Tree {
  private readonly before = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.before.has(p)) {
      let value: string | null = null;
      try {
        if (statSync(p).isFile()) value = readFileSync(p, 'utf8');
      } catch {
        value = null;
      }
      this.before.set(p, value);
    }
    return this.before.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  snapshot(): Map<string, string | null> {
    return new Map(this.now);
  }
  restore(snap: Map<string, string | null>, moveCount: number): void {
    this.now.clear();
    for (const [k, v] of snap) this.now.set(k, v);
    this.moves.length = moveCount;
  }
}

type Edit = (tree: Tree) => void;

// ---- Matching lines at three tiers (SPEC section 5) ----

function lineMatchesAt(fileLine: string, patchLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === patchLine;
  if (tier === 1) return stripTrailWs(fileLine) === stripTrailWs(patchLine);
  return stripBothWs(fileLine) === stripBothWs(patchLine);
}

interface Found {
  tier: number;
  positions: number[];
}

// Every start position of `oldLines` in `fileLines`, at the first tier
// that has one, restricted to positions at or after `from`.
function findLines(fileLines: string[], oldLines: string[], strict: boolean, from = 0): Found | null {
  const lastTier = strict ? 0 : 2;
  for (let tier = 0; tier <= lastTier; tier += 1) {
    const positions: number[] = [];
    for (let i = from; i + oldLines.length <= fileLines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < oldLines.length; j += 1) {
        if (!lineMatchesAt(fileLines[i + j]!, oldLines[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// One body item of a hunk or chunk: context, removed, added, backslash.
interface BodyItem {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  rawEmpty?: boolean;
}

// Build the replacement lines for a matched occurrence. Context lines
// keep the file's own text; at tier 2 added lines are re-indented from
// the patch's first old line onto the file's first matched line.
function buildReplacement(items: BodyItem[], fileLines: string[], at: number, oldLines: string[], tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  const fileLead = fileLines.length > 0 && at < fileLines.length ? leadWs(fileLines[at]!) : '';
  const patchLead = oldLines.length > 0 ? leadWs(oldLines[0]!) : '';
  for (const item of items) {
    if (item.kind === 'ctx') {
      out.push(fileLines[at + oi]!);
      oi += 1;
    } else if (item.kind === 'del') {
      oi += 1;
    } else if (item.kind === 'add') {
      let line = item.text;
      if (tier === 2 && line.trim() !== '') {
        if (line.startsWith(patchLead)) line = fileLead + line.slice(patchLead.length);
      }
      out.push(line);
    }
  }
  return out;
}

function plainReplacement(newLines: string[], fileLines: string[], at: number, oldLines: string[], tier: number): string[] {
  const items: BodyItem[] = newLines.map((text) => ({ kind: 'add' as const, text }));
  void fileLines;
  void at;
  void oldLines;
  void tier;
  // SEARCH/REPLACE has no context lines: every new line is an added line.
  const out: string[] = [];
  const fileLead = at < fileLines.length ? leadWs(fileLines[at]!) : '';
  const patchLead = oldLines.length > 0 ? leadWs(oldLines[0]!) : '';
  for (const item of items) {
    let line = item.text;
    if (tier === 2 && line.trim() !== '') {
      if (line.startsWith(patchLead)) line = fileLead + line.slice(patchLead.length);
    }
    out.push(line);
  }
  return out;
}

// Whether a backslash body line follows the last context or added line.
function backslashAfterLast(items: BodyItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const kind = items[i]!.kind;
    if (kind === 'ctx' || kind === 'add') return items[i + 1]?.kind === 'bs';
  }
  return false;
}

// ---- Unified diffs (SPEC section 6) ----

interface Hunk {
  start: number; // the A of @@ -A[,B] +C[,D] @@
  items: BodyItem[];
}

interface Section {
  startLine: number;
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null;
  headNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

function headerPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const newSection = (lineNo: number): Section => {
    const s: Section = {
      startLine: lineNo,
      diffOld: null,
      diffNew: null,
      headOld: null,
      headNew: null,
      renameFrom: null,
      renameTo: null,
      isNew: false,
      isDeleted: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new ParseProblem(`error: parse ${i + 1}`);
      cur = newSection(i + 1);
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null || cur === null) throw new ParseProblem(`error: parse ${i + 1}`);
      const rest = line.slice(m[0].length);
      if (rest !== '' && !rest.startsWith(' ') && !rest.startsWith('\t')) {
        throw new ParseProblem(`error: parse ${i + 1}`);
      }
      const hunk: Hunk = { start: Number(m[1]), items: [] };
      i += 1;
      const body: BodyItem[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        const c = b[0];
        if (b === '') body.push({ kind: 'ctx', text: '', rawEmpty: true });
        else if (c === ' ') body.push({ kind: 'ctx', text: b.slice(1) });
        else if (c === '-') body.push({ kind: 'del', text: b.slice(1) });
        else if (c === '+') body.push({ kind: 'add', text: b.slice(1) });
        else if (c === '\\') body.push({ kind: 'bs', text: b.slice(1) });
        else break;
        i += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (body.length > 0 && body[body.length - 1]!.rawEmpty) body.pop();
      hunk.items = body;
      cur.hunks.push(hunk);
      continue;
    }
    if (line.startsWith('--- ')) {
      const followed = (lines[i + 1] ?? '').startsWith('+++ ');
      const headerOpen = cur !== null && cur.hunks.length === 0 && !(cur.headOld !== null && cur.headNew !== null);
      if (!followed) {
        if (cur !== null && cur.hunks.length === 0) throw new ParseProblem(`error: parse ${i + 2}`);
        i += 1;
        continue;
      }
      if (cur === null || cur.hunks.length > 0 || (cur.headOld !== null && cur.headNew !== null)) {
        cur = newSection(i + 1);
      }
      cur.headOld = headerPath(line.slice(4));
      cur.headNew = headerPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDeleted = true;
    }
    i += 1;
  }
  if (sections.length === 0) throw new ParseProblem('error: parse 1');
  const edits: Edit[] = [];
  for (const s of sections) {
    const edit = unifiedEdit(s);
    if (edit !== null) edits.push(edit);
  }
  if (edits.length === 0) throw new ParseProblem('error: parse 1');
  return edits;
}

function unifiedEdit(s: Section): Edit | null {
  const oldPath = s.headOld ?? s.renameFrom ?? s.diffOld;
  const newPath = s.headNew ?? s.renameTo ?? s.diffNew;
  const creation = s.isNew || oldPath === '/dev/null';
  const deletion = s.isDeleted || newPath === '/dev/null';
  if (creation) {
    const target = newPath;
    if (target === null || target === '/dev/null') return null;
    return (tree) => {
      demandSafe(target);
      if (tree.get(target) !== null) throw new EditProblem('exists', target);
      const added: string[] = [];
      let lastAddBackslash = false;
      for (const h of s.hunks) {
        h.items.forEach((item, idx) => {
          if (item.kind === 'add') {
            added.push(item.text);
            lastAddBackslash = h.items[idx + 1]?.kind === 'bs';
          }
        });
      }
      const text = added.length === 0 ? '' : added.join('\n') + (lastAddBackslash ? '' : '\n');
      tree.now.set(target, text);
    };
  }
  if (deletion) {
    const target = oldPath;
    if (target === null || target === '/dev/null') return null;
    return (tree) => {
      demandSafe(target);
      if (tree.get(target) === null) throw new EditProblem('missing', target);
      tree.now.set(target, null);
    };
  }
  if (oldPath === null || newPath === null) return null;
  const from = oldPath;
  const to = newPath;
  const moving = from !== to;
  return (tree) => {
    demandSafe(from);
    if (moving) demandSafe(to);
    const before = tree.get(from);
    if (before === null) throw new EditProblem('missing', from);
    if (moving && tree.get(to) !== null) throw new EditProblem('exists', to);
    const parts = splitFile(before);
    let shift = 0;
    for (const h of s.hunks) {
      const oldLines = h.items.filter((x) => x.kind === 'ctx' || x.kind === 'del').map((x) => x.text);
      const newCount = h.items.filter((x) => x.kind === 'ctx' || x.kind === 'add').length;
      if (oldLines.length === 0) {
        const at = Math.min(h.start + shift, parts.lines.length);
        const wasEnd = at === parts.lines.length;
        const adds = h.items.filter((x) => x.kind === 'add').map((x) => x.text);
        parts.lines.splice(at, 0, ...adds);
        if (wasEnd && adds.length > 0) parts.finalBreak = !backslashAfterLast(h.items);
        shift += adds.length;
        continue;
      }
      const found = findLines(parts.lines, oldLines, currentStrict);
      if (found === null) throw new EditProblem('no-match', from);
      const goal = h.start - 1 + shift;
      let best = found.positions[0]!;
      for (const pos of found.positions) {
        if (Math.abs(pos - goal) < Math.abs(best - goal)) best = pos;
      }
      const runsToEnd = best + oldLines.length === parts.lines.length;
      const replacement = buildReplacement(h.items, parts.lines, best, oldLines, found.tier);
      parts.lines.splice(best, oldLines.length, ...replacement);
      if (runsToEnd) parts.finalBreak = !backslashAfterLast(h.items);
      shift += newCount - oldLines.length;
    }
    const text = joinFile(parts);
    if (moving) {
      tree.now.set(from, null);
      tree.now.set(to, text);
      tree.moves.push([from, to]);
    } else {
      tree.now.set(to, text);
    }
  };
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let sep = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (sep < 0 && lines[j]!.trimEnd() === '=======') sep = j;
      else if (sep >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (sep < 0 || end < 0) throw new ParseProblem(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j -= 1) {
      const candidate = lines[j]!;
      if (isBlank(candidate)) continue;
      if (candidate.trim().startsWith('```')) continue;
      path = candidate.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseProblem(`error: parse ${searchLine + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchLine + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (blocks.length === 0) throw new ParseProblem('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    demandSafe(b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new EditProblem('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new EditProblem('missing', b.path);
    const parts = splitFile(before);
    const found = findLines(parts.lines, b.oldLines, currentStrict);
    if (found === null) throw new EditProblem('no-match', b.path);
    if (found.positions.length > 1) throw new EditProblem('ambiguous', b.path);
    const at = found.positions[0]!;
    const replacement = plainReplacement(b.newLines, parts.lines, at, b.oldLines, found.tier);
    parts.lines.splice(at, b.oldLines.length, ...replacement);
    tree.now.set(b.path, joinFile(parts));
  });
}

// ---- V4A patches (SPEC section 8) ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

interface V4aSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  headerLine: number;
  addLines: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
}

const V4A_HEADERS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];

function v4aHeaderKind(line: string): 'add' | 'del' | 'upd' | null {
  if (line.startsWith(V4A_HEADERS[0]!)) return 'add';
  if (line.startsWith(V4A_HEADERS[1]!)) return 'del';
  if (line.startsWith(V4A_HEADERS[2]!)) return 'upd';
  return null;
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseProblem('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseProblem(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!isBlank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseProblem(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i]!)) {
      i += 1;
      continue;
    }
    const kind = v4aHeaderKind(lines[i]!);
    if (kind === null) throw new ParseProblem(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    const path = lines[i]!.slice(V4A_HEADERS[kind === 'add' ? 0 : kind === 'del' ? 1 : 2]!.length).trim();
    // Collect this section's raw content lines (with their numbers).
    const content: Array<{ text: string; no: number }> = [];
    i += 1;
    while (i < last && v4aHeaderKind(lines[i]!) === null) {
      content.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    // Blank lines at the end of a section are not part of it, and a
    // blank line is one that is empty or only whitespace.
    while (content.length > 0 && content[content.length - 1]!.text.trim() === '') content.pop();
    const section: V4aSection = { kind, path, headerLine, addLines: [], moveTo: null, chunks: [] };
    if (kind === 'add') {
      for (const c of content) {
        if (c.text.startsWith('+')) section.addLines.push(c.text.slice(1));
        else if (c.text === '') section.addLines.push('');
        else throw new ParseProblem(`error: parse ${c.no}`);
      }
    } else if (kind === 'del') {
      for (const c of content) {
        if (c.text !== '') throw new ParseProblem(`error: parse ${c.no}`);
      }
    } else {
      let start = 0;
      if (content.length > 0 && content[0]!.text.startsWith('*** Move to: ')) {
        section.moveTo = content[0]!.text.slice('*** Move to: '.length).trim();
        start = 1;
      }
      let chunk: V4aChunk | null = null;
      for (let k = start; k < content.length; k += 1) {
        const c = content[k]!;
        if (c.text.startsWith('@@')) {
          chunk = { anchor: c.text.slice(2).trim() || null, eof: false, items: [] };
          section.chunks.push(chunk);
        } else if (c.text === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, items: [] };
            section.chunks.push(chunk);
          }
          chunk.eof = true;
          chunk = null;
        } else if (c.text === '' || c.text[0] === ' ' || c.text[0] === '-' || c.text[0] === '+') {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, items: [] };
            section.chunks.push(chunk);
          }
          if (c.text === '') chunk.items.push({ kind: 'ctx', text: '' });
          else if (c.text[0] === ' ') chunk.items.push({ kind: 'ctx', text: c.text.slice(1) });
          else if (c.text[0] === '-') chunk.items.push({ kind: 'del', text: c.text.slice(1) });
          else chunk.items.push({ kind: 'add', text: c.text.slice(1) });
        } else {
          throw new ParseProblem(`error: parse ${c.no}`);
        }
      }
      if (section.chunks.length === 0 && section.moveTo === null) {
        throw new ParseProblem(`error: parse ${headerLine}`);
      }
    }
    sections.push(section);
  }
  if (sections.length === 0) throw new ParseProblem('error: parse 1');
  return sections.map((s) => v4aEdit(s));
}

function v4aEdit(s: V4aSection): Edit {
  return (tree) => {
    demandSafe(s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new EditProblem('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(s.path) === null) throw new EditProblem('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== null) demandSafe(s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new EditProblem('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new EditProblem('exists', s.moveTo);
    const parts = splitFile(before);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const anchorFound = findLines(parts.lines, [chunk.anchor], currentStrict, cursor);
        if (anchorFound === null) throw new EditProblem('no-match', s.path);
        cursor = anchorFound.positions[0]! + 1;
      }
      const oldLines = chunk.items.filter((x) => x.kind === 'ctx' || x.kind === 'del').map((x) => x.text);
      if (oldLines.length === 0) {
        const adds = chunk.items.filter((x) => x.kind === 'add').map((x) => x.text);
        const at = chunk.eof ? parts.lines.length : Math.min(cursor, parts.lines.length);
        parts.lines.splice(at, 0, ...adds);
        cursor = at + adds.length;
        continue;
      }
      let found = findLines(parts.lines, oldLines, currentStrict, cursor);
      if (found !== null && chunk.eof) {
        const filtered = found.positions.filter((p) => p + oldLines.length === parts.lines.length);
        if (filtered.length === 0) {
          // A later tier may hold an end-of-file occurrence.
          found = null;
          const lastTier = currentStrict ? 0 : 2;
          for (let tier = 0; tier <= lastTier && found === null; tier += 1) {
            const positions: number[] = [];
            for (let p = cursor; p + oldLines.length <= parts.lines.length; p += 1) {
              let ok = true;
              for (let j = 0; j < oldLines.length; j += 1) {
                if (!lineMatchesAt(parts.lines[p + j]!, oldLines[j]!, tier)) {
                  ok = false;
                  break;
                }
              }
              if (ok && p + oldLines.length === parts.lines.length) positions.push(p);
            }
            if (positions.length > 0) found = { tier, positions };
          }
        } else {
          found = { tier: found.tier, positions: filtered };
        }
      }
      if (found === null) throw new EditProblem('no-match', s.path);
      const at = found.positions[0]!;
      const replacement = buildReplacement(chunk.items, parts.lines, at, oldLines, found.tier);
      parts.lines.splice(at, oldLines.length, ...replacement);
      cursor = at + replacement.length;
    }
    const text = joinFile(parts);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, text);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, text);
    }
  };
}

// ---- JSON edits (SPEC section 9) ----

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    demandSafe(p);
    const t = tree.get(p);
    if (t === null) throw new EditProblem('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      demandSafe(p);
      if (tree.get(p) !== null) throw new EditProblem('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const needle = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(needle); k >= 0; k = t.indexOf(needle, k + 1)) count += 1;
      if (count === 0) throw new EditProblem('no-match', p);
      if (count > 1) throw new EditProblem('ambiguous', p);
      const at = t.indexOf(needle);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + needle.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const parts = splitFile(before);
      if (line < 0 || line > parts.lines.length) throw new EditProblem('no-match', p);
      parts.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(parts));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseProblem('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ParseProblem(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(value)) throw new ParseProblem(`error: parse ${first + 1}`);
    for (const item of value) {
      const e = jsonEdit(item);
      if (e === null) throw new ParseProblem(`error: parse ${first + 1}`);
      edits.push(e);
    }
    if (edits.length === 0) throw new ParseProblem('error: parse 1');
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseProblem(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  if (edits.length === 0) throw new ParseProblem('error: parse 1');
  return edits;
}

// ---- Format detection (SPEC section 4) ----

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, idx) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')))) {
    return 'unified';
  }
  return null;
}

// ---- Invocation, output and exit codes (SPEC sections 1, 2, 10) ----

let currentStrict = false;

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let optionsDone = false;
  for (const a of args) {
    if (!optionsDone && a === '--') {
      optionsDone = true;
    } else if (!optionsDone && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !checkOnly) checkOnly = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  currentStrict = strict;
  const patchPath = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = readFileSync(patchPath ?? 0, 'utf8');
  } catch {
    if (patchPath !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
  } catch (e) {
    if (e instanceof ParseProblem) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const failures: EditProblem[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditProblem)) throw e;
      tree.restore(snap, moveCount);
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`],
    };
  }
  // Changed paths, with a successful move shown as one R line.
  interface Row {
    key: string;
    text: string;
    paths: string[];
  }
  const rows: Row[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (consumed.has(oldP) || consumed.has(newP)) continue;
    const wasOld = tree.original(oldP);
    const nowOld = tree.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}`, paths: [oldP, newP] });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, paths: [p] });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!checkOnly) {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const result = run(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
