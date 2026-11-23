// mend applies the four edit formats in SPEC.md (MIT). Parsing completes before file access; edits run against
// an in-memory tree before the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface Move {
  oldPath: string;
  newPath: string;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Move[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

interface LineFile {
  lines: string[];
  br: string;
  final: boolean;
}

function lineFile(text: string): LineFile {
  const lf = text.indexOf('\n');
  const br = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(br);
  const final = text !== '' && text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function fileText(file: LineFile): string {
  return file.lines.length === 0 ? '' : file.lines.join(file.br) + (file.final ? file.br : '');
}

function checkPaths(...paths: string[]): void {
  for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p);
}

interface Match {
  tier: number;
  positions: number[];
}

function normalizedLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+|[ \t]+$/g, '');
}

/** Tier selection happens over all eligible positions, including overlapping ones. */
function matchLines(lines: string[], old: string[], strict: boolean, cursor = 0, eof = false): Match | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const wanted = old.map((l) => normalizedLine(l, tier));
    const actual = lines.map((l) => normalizedLine(l, tier));
    const positions: number[] = [];
    for (let at = cursor; at <= lines.length - old.length; at += 1) {
      if (eof && at + old.length !== lines.length) continue;
      if (wanted.every((l, i) => l === actual[at + i])) positions.push(at);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

interface BodyLine {
  kind: 'context' | 'old' | 'new';
  text: string;
  noBreak: boolean;
}

function bodyLine(line: string): BodyLine {
  return {
    kind: line === '' || line[0] === ' ' ? 'context' : line[0] === '-' ? 'old' : 'new',
    text: line === '' ? '' : line.slice(1),
    noBreak: false,
  };
}

function oldLines(body: BodyLine[]): string[] {
  return body.filter((l) => l.kind !== 'new').map((l) => l.text);
}

/** Context keeps the matched file text; only added lines can be re-indented. */
function replacementLines(body: BodyLine[], old: string[], lines: string[], at: number, tier: number): string[] {
  const patchIndent = (old[0] ?? '').match(/^[ \t]*/)![0];
  const fileIndent = (lines[at] ?? '').match(/^[ \t]*/)![0];
  const out: string[] = [];
  let oldIndex = 0;
  for (const line of body) {
    if (line.kind === 'context') out.push(lines[at + oldIndex]!);
    if (line.kind !== 'new') {
      oldIndex += 1;
      continue;
    }
    const text = line.text;
    out.push(tier === 2 && !blank(text) && text.startsWith(patchIndent) ? fileIndent + text.slice(patchIndent.length) : text);
  }
  return out;
}

interface UnifiedHunk {
  start: number;
  body: BodyLine[];
}

interface UnifiedSection {
  oldPath?: string;
  newPath?: string;
  gitOld?: string;
  gitNew?: string;
  renameOld?: string;
  renameNew?: string;
  pair: boolean;
  create: boolean;
  delete: boolean;
  hunks: UnifiedHunk[];
}

function unifiedPath(line: string): string {
  const path = line.slice(4).split('\t')[0]!.trim();
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

function unifiedBody(raw: string[]): BodyLine[] {
  // Backslash markers do not keep otherwise trailing empty patch lines in the body.
  let last = raw.length - 1;
  while (last >= 0 && (raw[last] === '' || raw[last]!.startsWith('\\'))) last -= 1;
  const body: BodyLine[] = [];
  raw.forEach((line, i) => {
    if (line === '' && i > last) return;
    if (line.startsWith('\\')) {
      if (body.length > 0) body[body.length - 1]!.noBreak = true;
    } else body.push(bodyLine(line));
  });
  return body;
}

function lastOutputNoBreak(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i]!.kind !== 'old') return body[i]!.noBreak;
  }
  return false;
}

function unifiedEdit(section: UnifiedSection, strict: boolean): Edit {
  const oldPath = section.oldPath ?? section.renameOld ?? section.gitOld ?? '';
  const newPath = section.newPath ?? section.renameNew ?? section.gitNew ?? '';
  const create = oldPath === '/dev/null' || section.create;
  const remove = !create && (newPath === '/dev/null' || section.delete);
  return (tree) => {
    checkPaths(...[oldPath, newPath].filter((p) => p !== '/dev/null'));
    if (create) {
      checkPaths(newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const lines: string[] = [];
      let final = true;
      for (const hunk of section.hunks) {
        for (const line of hunk.body) {
          if (line.kind !== 'new') continue;
          lines.push(line.text);
          final = !line.noBreak;
        }
      }
      tree.now.set(newPath, fileText({ lines, br: '\n', final }));
      return;
    }
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (remove) {
      tree.now.set(oldPath, null);
      return;
    }
    const move = oldPath !== newPath;
    if (move && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const file = lineFile(before);
    let d = 0;
    for (const hunk of section.hunks) {
      const old = oldLines(hunk.body);
      let at: number;
      let tier = 0;
      if (old.length === 0) at = Math.max(0, Math.min(file.lines.length, hunk.start + d));
      else {
        const match = matchLines(file.lines, old, strict);
        if (match === null) throw new Fail('no-match', oldPath);
        tier = match.tier;
        const target = Math.max(0, Math.min(file.lines.length, hunk.start - 1 + d));
        at = match.positions[0]!;
        for (const pos of match.positions) {
          if (Math.abs(pos - target) < Math.abs(at - target)) at = pos;
        }
      }
      const end = at + old.length === file.lines.length;
      const out = replacementLines(hunk.body, old, file.lines, at, tier);
      file.lines.splice(at, old.length, ...out);
      if (end) file.final = !lastOutputNoBreak(hunk.body);
      d += out.length - old.length;
    }
    tree.now.set(newPath, fileText(file));
    if (move) {
      tree.now.set(oldPath, null);
      tree.moves.push({ oldPath, newPath });
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | null = null;
  const pairAt = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  const startSection = (): UnifiedSection => {
    const next: UnifiedSection = { pair: false, create: false, delete: false, hunks: [] };
    sections.push(next);
    section = next;
    return next;
  };
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const tokens = line.split(' ');
      if (tokens.length !== 4 || tokens[0] !== 'diff' || tokens[1] !== '--git' || !tokens[2]!.startsWith('a/') || !tokens[3]!.startsWith('b/')) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const next = startSection();
      next.gitOld = tokens[2]!.slice(2);
      next.gitNew = tokens[3]!.slice(2);
      i += 1;
      continue;
    }
    if (pairAt(i)) {
      if (section === null || section.hunks.length > 0 || section.pair) startSection();
      section!.oldPath = unifiedPath(line);
      section!.newPath = unifiedPath(lines[i + 1]!);
      section!.pair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@.*$/.exec(line);
      if (header === null || section === null) throw new Exit2(`error: parse ${i + 1}`);
      const raw: string[] = [];
      i += 1;
      while (i < lines.length) {
        const body = lines[i]!;
        if (body.startsWith('diff --git ') || pairAt(i)) break;
        if (body !== '' && ![' ', '-', '+', '\\'].includes(body[0]!)) break;
        raw.push(body);
        i += 1;
      }
      section.hunks.push({ start: Number(header[1]), body: unifiedBody(raw) });
      continue;
    }
    if (section !== null && section.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (!section.pair && line.startsWith('rename from ')) section.renameOld = line.slice(12).trim();
      if (!section.pair && line.startsWith('rename to ')) section.renameNew = line.slice(10).trim();
      if (line.startsWith('new file mode')) section.create = true;
      if (line.startsWith('deleted file mode')) section.delete = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousEnd = -1;
  let previousPath: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > previousEnd; j -= 1) {
      const candidate = lines[j]!.trim();
      if (candidate === '' || candidate.startsWith('```')) continue;
      path = candidate;
      break;
    }
    path ??= previousPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let split = i + 1;
    while (split < lines.length && lines[split]!.trimEnd() !== '=======') split += 1;
    let end = split + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end += 1;
    if (split === lines.length || end >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    const old = lines.slice(i + 1, split);
    const added = lines.slice(split + 1, end);
    const body: BodyLine[] = added.map((text) => ({ kind: 'new', text, noBreak: false }));
    const p = path;
    edits.push((tree) => {
      checkPaths(p);
      const before = tree.get(p);
      if (old.length === 0) {
        if (before !== null) throw new Fail('exists', p);
        tree.now.set(p, fileText({ lines: added, br: '\n', final: true }));
        return;
      }
      if (before === null) throw new Fail('missing', p);
      const file = lineFile(before);
      const match = matchLines(file.lines, old, strict);
      if (match === null) throw new Fail('no-match', p);
      if (match.positions.length !== 1) throw new Fail('ambiguous', p);
      const at = match.positions[0]!;
      file.lines.splice(at, old.length, ...replacementLines(body, old, file.lines, at, match.tier));
      tree.now.set(p, fileText(file));
    });
    previousEnd = end;
    previousPath = p;
    i = end;
  }
  return edits;
}

interface V4AChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aUpdate(path: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    checkPaths(path, ...(moveTo === null ? [] : [moveTo]));
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const file = lineFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const anchor = matchLines(file.lines, [chunk.anchor], strict, cursor);
        if (anchor === null) throw new Fail('no-match', path);
        cursor = anchor.positions[0]! + 1;
      }
      const old = oldLines(chunk.body);
      let at = chunk.eof ? file.lines.length : cursor;
      let tier = 0;
      if (old.length > 0) {
        const match = matchLines(file.lines, old, strict, cursor, chunk.eof);
        if (match === null) throw new Fail('no-match', path);
        at = match.positions[0]!;
        tier = match.tier;
      }
      const out = replacementLines(chunk.body, old, file.lines, at, tier);
      file.lines.splice(at, old.length, ...out);
      cursor = at + out.length;
    }
    tree.now.set(moveTo ?? path, fileText(file));
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.moves.push({ oldPath: path, newPath: moveTo });
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const prefixes = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];
  const sectionPrefix = (line: string): string | undefined => prefixes.find((p) => line.startsWith(p));
  const edits: Edit[] = [];
  for (let i = first + 1; i < last;) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const header = i;
    const prefix = sectionPrefix(lines[i]!);
    if (prefix === undefined) throw new Exit2(`error: parse ${i + 1}`);
    const path = lines[i]!.slice(prefix.length).trim();
    let end = i + 1;
    while (end < last && sectionPrefix(lines[end]!) === undefined) end += 1;
    let bodyEnd = end;
    while (bodyEnd > i + 1 && blank(lines[bodyEnd - 1]!)) bodyEnd -= 1;
    i += 1;
    if (prefix === '*** Add File: ') {
      const added: string[] = [];
      for (; i < bodyEnd; i += 1) {
        const line = lines[i]!;
        if (line !== '' && !line.startsWith('+')) throw new Exit2(`error: parse ${i + 1}`);
        added.push(line === '' ? '' : line.slice(1));
      }
      edits.push((tree) => {
        checkPaths(path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileText({ lines: added, br: '\n', final: true }));
      });
    } else if (prefix === '*** Delete File: ') {
      if (i < bodyEnd) throw new Exit2(`error: parse ${i + 1}`);
      edits.push((tree) => {
        checkPaths(path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      if (i < bodyEnd && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice(13).trim();
        i += 1;
      }
      const chunks: V4AChunk[] = [];
      let chunk: V4AChunk | null = null;
      for (; i < bodyEnd; i += 1) {
        const line = lines[i]!;
        if (line.startsWith('@@')) {
          chunk = { anchor: line.slice(2).trim() || null, body: [], eof: false };
          chunks.push(chunk);
        } else if (line === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
          chunk.eof = true;
          chunk = null;
        } else if (line === '' || [' ', '-', '+'].includes(line[0]!)) {
          if (chunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            chunk = { anchor: null, body: [], eof: false };
            chunks.push(chunk);
          }
          chunk.body.push(bodyLine(line));
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${header + 1}`);
      edits.push(v4aUpdate(path, moveTo, chunks, strict));
    }
    i = end;
  }
  return edits;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { path: string; line: string; oldPath?: string }[] = [];
  const renamed = new Set<string>();
  for (const { oldPath, newPath } of tree.moves) {
    if (tree.original(oldPath) === null || tree.get(oldPath) !== null || tree.original(newPath) !== null || tree.get(newPath) === null) continue;
    rows.push({ path: newPath, oldPath, line: `R ${oldPath} -> ${newPath}` });
    renamed.add(oldPath);
    renamed.add(newPath);
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now || renamed.has(p)) continue;
    rows.push({ path: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  for (const row of rows) {
    if (check) continue;
    const now = tree.get(row.path);
    if (now === null) rmSync(row.path, { force: true });
    else {
      mkdirSync(dirname(row.path), { recursive: true });
      writeFileSync(row.path, now);
    }
    if (row.oldPath !== undefined) rmSync(row.oldPath, { force: true });
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
