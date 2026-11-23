// mend — one patch tool for every AI edit format.
//
// Reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON editor
// tool calls, applies them to the tree rooted at the working directory, and
// writes every file or none of them. Line matching tolerates drifted
// whitespace and indentation through three tiers (exact, trailing-trimmed,
// fully trimmed with re-indentation). Node 22, standard library only.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------- errors

class ParseFault {
  readonly lineNo: number;
  constructor(lineNo: number) {
    this.lineNo = lineNo;
  }
}

class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------- basics

const isBlank = (s: string): boolean => s.trim() === '';

function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function pathIsSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

interface FileShape {
  br: string;
  lines: string[];
  tail: boolean;
}

function readShape(text: string): FileShape {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], tail: false };
  const tail = text.endsWith(br);
  const lines = text.split(br);
  if (tail) lines.pop();
  return { br, lines, tail };
}

function writeShape(lines: string[], br: string, tail: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (tail ? br : '');
}

// ---------------------------------------------------------------- the tree

interface MovePair {
  from: string;
  to: string;
}

class Tree {
  private cache = new Map<string, string | null>();
  readonly state = new Map<string, string | null>();
  readonly moves: MovePair[] = [];

  before(p: string): string | null {
    if (!this.cache.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.cache.set(p, v);
    }
    return this.cache.get(p)!;
  }

  current(p: string): string | null {
    return this.state.has(p) ? this.state.get(p)! : this.before(p);
  }

  put(p: string, text: string | null): void {
    this.state.set(p, text);
  }
}

type EditFn = (tree: Tree, strict: boolean) => void;

// ------------------------------------------------------- three-tier match

const rTrim = (s: string): string => s.replace(/[ \t]+$/, '');
const fullTrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEqAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rTrim(a) === rTrim(b);
  return fullTrim(a) === fullTrim(b);
}

interface MatchHit {
  tier: number;
  spots: number[];
}

function findMatches(fileLines: string[], oldLines: string[], strict: boolean, from: number): MatchHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const spots: number[] = [];
    for (let i = from; i + oldLines.length <= fileLines.length; i += 1) {
      let ok = true;
      for (let k = 0; k < oldLines.length; k += 1) {
        if (!lineEqAt(fileLines[i + k]!, oldLines[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) spots.push(i);
    }
    if (spots.length > 0) return { tier, spots };
  }
  return null;
}

// Splice one matched block: context items take the file's own matched line;
// at tier 2 the other items are re-indented from the patch's first-line
// indent onto the file's first matched line indent.
interface BlockItem {
  text: string;
  context: boolean;
  oldIndex: number; // for context items: index into oldLines; -1 otherwise
}

function spliceBlock(
  fileLines: string[],
  oldLines: string[],
  items: BlockItem[],
  hit: MatchHit,
  at: number,
): string[] {
  const built: string[] = [];
  const fLead = leadWs(fileLines[at]!);
  const pLead = oldLines.length > 0 ? leadWs(oldLines[0]!) : '';
  for (const it of items) {
    if (it.context) built.push(fileLines[at + it.oldIndex]!);
    else if (hit.tier === 2) {
      const t = it.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(pLead)) built.push(fLead + t.slice(pLead.length));
      else built.push(t);
    } else built.push(it.text);
  }
  return [...fileLines.slice(0, at), ...built, ...fileLines.slice(at + oldLines.length)];
}

// ------------------------------------------------------------ format sniff

function sniffFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const ch = lines[first]!.trimStart().charAt(0);
  if (ch === '[' || ch === '{') return 'json';
  for (const l of lines) if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return 'unified';
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ------------------------------------------------------------- unified diff

interface HunkLine {
  kind: string; // 'ctx' | 'del' | 'add' | 'note'
  text: string;
  fromEmpty: boolean;
}

interface Hunk {
  aStart: number;
  body: HunkLine[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null;
  headNew: string | null;
  hasHeadPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  creates: boolean;
  deletes: boolean;
  inHeader: boolean;
  hunks: Hunk[];
}

function cleanHeadPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function newSection(): Section {
  return {
    diffOld: null,
    diffNew: null,
    headOld: null,
    headNew: null,
    hasHeadPair: false,
    renameFrom: null,
    renameTo: null,
    creates: false,
    deletes: false,
    inHeader: true,
    hunks: [],
  };
}

function parseUnified(lines: string[]): EditFn[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // A --- / +++ pair.
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.inHeader && !cur.hasHeadPair) {
        cur.headOld = cleanHeadPath(line.slice(4));
        cur.headNew = cleanHeadPath(lines[i + 1]!.slice(4));
        cur.hasHeadPair = true;
      } else {
        cur = newSection();
        cur.headOld = cleanHeadPath(line.slice(4));
        cur.headNew = cleanHeadPath(lines[i + 1]!.slice(4));
        cur.hasHeadPair = true;
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.inHeader) throw new ParseFault(i + 2);
      i += 1;
      continue;
    }
    if (line.startsWith('diff --git ') || line === 'diff --git') {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseFault(i + 1);
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hm === null) throw new ParseFault(i + 1);
      const hunk: Hunk = { aStart: parseInt(hm[1]!, 10), body: [] };
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ') || bl === 'diff --git') break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        const c0 = bl.charAt(0);
        if (bl === '') hunk.body.push({ kind: 'ctx', text: '', fromEmpty: true });
        else if (c0 === ' ') hunk.body.push({ kind: 'ctx', text: bl.slice(1), fromEmpty: false });
        else if (c0 === '-') hunk.body.push({ kind: 'del', text: bl.slice(1), fromEmpty: false });
        else if (c0 === '+') hunk.body.push({ kind: 'add', text: bl.slice(1), fromEmpty: false });
        else if (c0 === '\\') hunk.body.push({ kind: 'note', text: bl, fromEmpty: false });
        else break;
        i += 1;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.fromEmpty) hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      cur.inHeader = false;
      continue;
    }
    // Header lines of the current section.
    if (cur !== null && cur.inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.creates = true;
      else if (line.startsWith('deleted file mode')) cur.deletes = true;
    }
    i += 1;
  }
  if (sections.length === 0) throw new ParseFault(1);
  return sections.map((s) => unifiedEdit(s));
}

// Does a note line follow the hunk's last context or added line?
function noteAfterLastWritten(hunk: Hunk): boolean {
  for (let k = hunk.body.length - 1; k >= 0; k -= 1) {
    const b = hunk.body[k]!;
    if (b.kind === 'ctx' || b.kind === 'add') {
      const next = hunk.body[k + 1];
      return next !== undefined && next.kind === 'note';
    }
  }
  return false;
}

function unifiedEdit(sec: Section): EditFn {
  return (tree, strict) => {
    const oldPath = sec.headOld ?? sec.renameFrom ?? sec.diffOld;
    const newPath = sec.headNew ?? sec.renameTo ?? sec.diffNew;
    const isCreate = sec.creates || oldPath === '/dev/null';
    const isDelete = sec.deletes || newPath === '/dev/null';

    if (isCreate) {
      const p = newPath;
      if (p === null || p === '/dev/null') throw new ParseFault(1);
      if (!pathIsSafe(p)) throw new EditFault('unsafe', p);
      if (tree.current(p) !== null) throw new EditFault('exists', p);
      const outLines: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'add') outLines.push(b.text);
      let tail = true;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const h = sec.hunks[hi]!;
        if (!h.body.some((b) => b.kind === 'add')) continue;
        if (noteAfterLastWritten(h)) tail = false;
        break;
      }
      tree.put(p, writeShape(outLines, '\n', tail));
      return;
    }
    if (isDelete) {
      const p = oldPath;
      if (p === null) throw new ParseFault(1);
      if (!pathIsSafe(p)) throw new EditFault('unsafe', p);
      if (tree.current(p) === null) throw new EditFault('missing', p);
      tree.put(p, null);
      return;
    }
    if (oldPath === null || newPath === null) throw new ParseFault(1);
    if (!pathIsSafe(oldPath)) throw new EditFault('unsafe', oldPath);
    if (!pathIsSafe(newPath)) throw new EditFault('unsafe', newPath);
    const before = tree.current(oldPath);
    if (before === null) throw new EditFault('missing', oldPath);
    const isMove = oldPath !== newPath;
    if (isMove && tree.current(newPath) !== null) throw new EditFault('exists', newPath);

    const shape = readShape(before);
    let fileLines = [...shape.lines];
    let tail = shape.tail;
    let delta = 0;
    for (const hunk of sec.hunks) {
      const oldLines: string[] = [];
      const items: BlockItem[] = [];
      let oi = 0;
      for (const b of hunk.body) {
        if (b.kind === 'ctx') {
          oldLines.push(b.text);
          items.push({ text: b.text, context: true, oldIndex: oi });
          oi += 1;
        } else if (b.kind === 'del') {
          oldLines.push(b.text);
          oi += 1;
        } else if (b.kind === 'add') {
          items.push({ text: b.text, context: false, oldIndex: -1 });
        }
      }
      const nCount = items.length;
      if (oldLines.length === 0) {
        let at = hunk.aStart + delta;
        if (at < 0) at = 0;
        if (at > fileLines.length) at = fileLines.length;
        const atEnd = at === fileLines.length;
        const adds = items.map((it) => it.text);
        fileLines = [...fileLines.slice(0, at), ...adds, ...fileLines.slice(at)];
        if (atEnd) tail = !noteAfterLastWritten(hunk);
      } else {
        const hit = findMatches(fileLines, oldLines, strict, 0);
        if (hit === null) throw new EditFault('no-match', oldPath);
        const target = hunk.aStart - 1 + delta;
        let best = hit.spots[0]!;
        for (const s of hit.spots) {
          if (Math.abs(s - target) < Math.abs(best - target)) best = s;
        }
        const runsToEnd = best + oldLines.length === fileLines.length;
        fileLines = spliceBlock(fileLines, oldLines, items, hit, best);
        if (runsToEnd) tail = !noteAfterLastWritten(hunk);
      }
      delta += nCount - oldLines.length;
    }
    const result = writeShape(fileLines, shape.br, tail);
    if (isMove) {
      tree.put(newPath, result);
      tree.put(oldPath, null);
      tree.moves.push({ from: oldPath, to: newPath });
    } else {
      tree.put(oldPath, result);
    }
  };
}

// ---------------------------------------------------------- SEARCH/REPLACE

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): EditFn[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let boundary = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new ParseFault(searchLine);
    let path: string | null = null;
    for (let j = i - 1; j >= boundary; j -= 1) {
      const cand = lines[j]!;
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFault(searchLine);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    boundary = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new ParseFault(1);
  return blocks.map((b) => (tree, strict) => {
    if (!pathIsSafe(b.path)) throw new EditFault('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.current(b.path) !== null) throw new EditFault('exists', b.path);
      tree.put(b.path, writeShape([...b.newLines], '\n', true));
      return;
    }
    const before = tree.current(b.path);
    if (before === null) throw new EditFault('missing', b.path);
    const shape = readShape(before);
    const hit = findMatches(shape.lines, b.oldLines, strict, 0);
    if (hit === null) throw new EditFault('no-match', b.path);
    if (hit.spots.length > 1) throw new EditFault('ambiguous', b.path);
    const items: BlockItem[] = b.newLines.map((t) => ({ text: t, context: false, oldIndex: -1 }));
    const out = spliceBlock(shape.lines, b.oldLines, items, hit, hit.spots[0]!);
    tree.put(b.path, writeShape(out, shape.br, shape.tail));
  });
}

// --------------------------------------------------------------------- V4A

interface VChunkLine {
  kind: string; // 'ctx' | 'del' | 'add'
  text: string;
}

interface VChunk {
  anchor: string | null;
  body: VChunkLine[];
  eof: boolean;
}

interface VRawLine {
  text: string;
  lineNo: number;
}

interface VSection {
  kind: string; // 'add' | 'delete' | 'update'
  path: string;
  lineNo: number;
  raw: VRawLine[];
}

function parseV4A(lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const sections: VSection[] = [];
  let cur: VSection | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    let kind: string | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    }
    if (kind !== null) {
      cur = { kind, path, lineNo: i + 1, raw: [] };
      sections.push(cur);
      continue;
    }
    if (cur === null) {
      if (isBlank(line)) continue;
      throw new ParseFault(i + 1);
    }
    cur.raw.push({ text: line, lineNo: i + 1 });
  }
  if (sections.length === 0) throw new ParseFault(1);
  return sections.map((s) => v4aEdit(s));
}

function v4aEdit(sec: VSection): EditFn {
  // Drop the section's trailing blank lines: they are not part of it.
  const raw = [...sec.raw];
  while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();

  if (sec.kind === 'add') {
    const content: string[] = [];
    for (const rl of raw) {
      if (rl.text.startsWith('+')) content.push(rl.text.slice(1));
      else if (rl.text === '') content.push('');
      else throw new ParseFault(rl.lineNo);
    }
    return (tree) => {
      if (!pathIsSafe(sec.path)) throw new EditFault('unsafe', sec.path);
      if (tree.current(sec.path) !== null) throw new EditFault('exists', sec.path);
      tree.put(sec.path, writeShape(content, '\n', true));
    };
  }
  if (sec.kind === 'delete') {
    for (const rl of raw) {
      if (!isBlank(rl.text)) throw new ParseFault(rl.lineNo);
    }
    return (tree) => {
      if (!pathIsSafe(sec.path)) throw new EditFault('unsafe', sec.path);
      if (tree.current(sec.path) === null) throw new EditFault('missing', sec.path);
      tree.put(sec.path, null);
    };
  }
  // Update File.
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  } else if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
    throw new ParseFault(raw[0]!.lineNo);
  }
  const chunks: VChunk[] = [];
  let chunk: VChunk | null = null;
  let needHeader = false;
  for (let k = idx; k < raw.length; k += 1) {
    const rl = raw[k]!;
    const t = rl.text;
    if (t.startsWith('@@')) {
      chunk = { anchor: t.slice(2).trim() === '' ? null : t.slice(2).trim(), body: [], eof: false };
      chunks.push(chunk);
      needHeader = false;
    } else if (t === '*** End of File') {
      if (chunk !== null) {
        chunk.eof = true;
        chunk = null;
      } else if (chunks.length === 0 && !needHeader) {
        chunks.push({ anchor: null, body: [], eof: true });
      } else {
        throw new ParseFault(rl.lineNo);
      }
      needHeader = true;
    } else if (t.startsWith('*** Move to:')) {
      throw new ParseFault(rl.lineNo);
    } else if (t === '' || t.charAt(0) === ' ' || t.charAt(0) === '-' || t.charAt(0) === '+') {
      if (chunk === null) {
        if (chunks.length === 0 && !needHeader) {
          chunk = { anchor: null, body: [], eof: false };
          chunks.push(chunk);
        } else {
          throw new ParseFault(rl.lineNo);
        }
      }
      const kind = t === '' || t.charAt(0) === ' ' ? 'ctx' : t.charAt(0) === '-' ? 'del' : 'add';
      chunk.body.push({ kind, text: t === '' ? '' : t.slice(1) });
    } else {
      throw new ParseFault(rl.lineNo);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new ParseFault(sec.lineNo);
  const target = moveTo;
  return (tree, strict) => {
    if (!pathIsSafe(sec.path)) throw new EditFault('unsafe', sec.path);
    if (target !== null && !pathIsSafe(target)) throw new EditFault('unsafe', target);
    const before = tree.current(sec.path);
    if (before === null) throw new EditFault('missing', sec.path);
    if (target !== null && tree.current(target) !== null) throw new EditFault('exists', target);
    const shape = readShape(before);
    let fileLines = [...shape.lines];
    let cursor = 0;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const tier of tiers) {
          for (let p = cursor; p < fileLines.length; p += 1) {
            if (lineEqAt(fileLines[p]!, ch.anchor, tier)) {
              found = p;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new EditFault('no-match', sec.path);
        cursor = found + 1;
      }
      const oldLines: string[] = [];
      const items: BlockItem[] = [];
      let oi = 0;
      for (const b of ch.body) {
        if (b.kind === 'ctx') {
          oldLines.push(b.text);
          items.push({ text: b.text, context: true, oldIndex: oi });
          oi += 1;
        } else if (b.kind === 'del') {
          oldLines.push(b.text);
          oi += 1;
        } else {
          items.push({ text: b.text, context: false, oldIndex: -1 });
        }
      }
      if (oldLines.length === 0) {
        const at = ch.eof ? fileLines.length : Math.min(cursor, fileLines.length);
        const adds = items.map((it) => it.text);
        fileLines = [...fileLines.slice(0, at), ...adds, ...fileLines.slice(at)];
        cursor = at + adds.length;
        continue;
      }
      let hit: MatchHit | null = null;
      for (const tier of tiers) {
        const spots: number[] = [];
        for (let p = cursor; p + oldLines.length <= fileLines.length; p += 1) {
          if (ch.eof && p + oldLines.length !== fileLines.length) continue;
          let ok = true;
          for (let q = 0; q < oldLines.length; q += 1) {
            if (!lineEqAt(fileLines[p + q]!, oldLines[q]!, tier)) {
              ok = false;
              break;
            }
          }
          if (ok) spots.push(p);
        }
        if (spots.length > 0) {
          hit = { tier, spots };
          break;
        }
      }
      if (hit === null) throw new EditFault('no-match', sec.path);
      const at = hit.spots[0]!;
      fileLines = spliceBlock(fileLines, oldLines, items, hit, at);
      cursor = at + items.length;
    }
    const result = writeShape(fileLines, shape.br, shape.tail);
    if (target !== null) {
      tree.put(target, result);
      tree.put(sec.path, null);
      tree.moves.push({ from: sec.path, to: target });
    } else {
      tree.put(sec.path, result);
    }
  };
}

// -------------------------------------------------------------------- JSON

function oneJsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  const needFile = (tree: Tree): string => {
    if (!pathIsSafe(p)) throw new EditFault('unsafe', p);
    const t = tree.current(p);
    if (t === null) throw new EditFault('missing', p);
    return t;
  };

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!pathIsSafe(p)) throw new EditFault('unsafe', p);
      if (tree.current(p) !== null) throw new EditFault('exists', p);
      tree.put(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = typeof o.new_str === 'string' ? o.new_str : '';
    return (tree) => {
      const before = needFile(tree);
      const probe = before.indexOf('\n');
      const crlf = probe > 0 && before[probe - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const body = toLf(before);
      const needle = toLf(oldStr);
      let count = 0;
      for (let k = body.indexOf(needle); k >= 0; k = body.indexOf(needle, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = body.indexOf(needle);
      const merged = body.slice(0, at) + toLf(newStr) + body.slice(at + needle.length);
      tree.put(p, crlf ? merged.split('\n').join('\r\n') : merged);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const atLine = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = needFile(tree);
      const shape = readShape(before);
      if (atLine < 0 || atLine > shape.lines.length) throw new EditFault('no-match', p);
      const lines = [...shape.lines];
      lines.splice(atLine, 0, ...add);
      tree.put(p, writeShape(lines, shape.br, shape.tail));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trimStart().startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(value)) throw new ParseFault(first + 1);
    const edits: EditFn[] = [];
    for (const item of value) {
      const e = oneJsonEdit(item);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
    return edits;
  }
  const edits: EditFn[] = [];
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = oneJsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(idx + 1);
    edits.push(e);
  });
  return edits;
}

// ------------------------------------------------------------------ driver

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let afterDashDash = false;
  for (const a of args) {
    if (!afterDashDash && a === '--') {
      afterDashDash = true;
    } else if (!afterDashDash && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !checkOnly) checkOnly = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const patchArg = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? sniffFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: EditFn[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4A(lines);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.lineNo}`] };
    throw e;
  }

  const tree = new Tree();
  const failures: EditFault[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.state);
    const moveCount = tree.moves.length;
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.state.clear();
      for (const [k, v] of snapshot) tree.state.set(k, v);
      tree.moves.length = moveCount;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`],
    };
  }

  interface Row {
    key: string;
    line: string;
    path: string;
  }
  const byPath = new Map<string, Row>();
  for (const p of tree.state.keys()) {
    const was = tree.before(p);
    const now = tree.state.get(p)!;
    if (was === now) continue;
    const tag = was === null ? 'A' : now === null ? 'D' : 'M';
    byPath.set(p, { key: p, line: `${tag} ${p}`, path: p });
  }
  for (const mv of tree.moves) {
    const oldWas = tree.before(mv.from);
    const oldNow = tree.state.has(mv.from) ? tree.state.get(mv.from)! : oldWas;
    const newWas = tree.before(mv.to);
    const newNow = tree.state.has(mv.to) ? tree.state.get(mv.to)! : newWas;
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      if (byPath.has(mv.from) && byPath.has(mv.to)) {
        byPath.delete(mv.from);
        byPath.set(mv.to, { key: mv.to, line: `R ${mv.from} -> ${mv.to}`, path: mv.to });
      }
    }
  }
  const rows = [...byPath.values()].sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));

  if (!checkOnly) {
    for (const p of tree.state.keys()) {
      const was = tree.before(p);
      const now = tree.state.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
