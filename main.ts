import { readFileSync, readdirSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

class Exit2 extends Error {
  constructor(msg) {
    super(msg);
    this.msg = msg;
  }
}

class ParseError extends Error {
  constructor(line) {
    super('parse ' + line);
    this.line = line;
  }
}

class Fail {
  constructor(code, path) {
    this.code = code;
    this.path = path;
  }
}

function out(lines) {
  if (lines.length === 0) return;
  process.stdout.write(lines.map((l) => l + '\n').join(''));
}

function parseArgs(argv) {
  let format = 'auto';
  let check = false;
  let strict = false;
  let patch = null;
  let positional = 0;
  let ended = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const names = ['unified', 'search-replace', 'v4a', 'json', 'auto'];
  for (const arg of argv) {
    if (!ended && arg === '--') {
      ended = true;
      continue;
    }
    if (!ended && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (arg === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seenFormat) return null;
        const v = arg.slice('--format='.length);
        if (!names.includes(v)) return null;
        seenFormat = true;
        format = v;
      } else {
        return null;
      }
    } else {
      positional += 1;
      if (positional > 1) return null;
      patch = arg;
    }
  }
  return { format, check, strict, patch };
}

function patchLines(text) {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function splitNewLines(s) {
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function parseFile(text) {
  const firstLf = text.indexOf('\n');
  const eol = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text !== '' && text.endsWith(eol);
  let parts = text.split(eol);
  if (finalBreak) parts.pop();
  return { lines: parts, eol, finalBreak, rawOverride: null };
}

function serialize(st) {
  if (st.lines.length === 0) return '';
  let s = st.lines.join(st.eol);
  if (st.finalBreak) s += st.eol;
  return s;
}

function content(st) {
  return st.rawOverride === null ? serialize(st) : st.rawOverride;
}

function leadingWS(s) {
  const m = s.match(/^[ \t]*/);
  return m === null ? '' : m[0];
}

function markerEq(line, marker) {
  return line.replace(/\s+$/, '') === marker;
}

function blank(line) {
  return line.trim() === '';
}

function isSafePath(p) {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

function detect(lines) {
  let b = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!blank(lines[i])) {
      b = i;
      break;
    }
  }
  if (b >= 0) {
    const t = lines[b].trim();
    if (t === '*** Begin Patch') return 'v4a';
    const first = lines[b].trimStart()[0];
    if (first === '[' || first === '{') return 'json';
  }
  for (const l of lines) {
    if (markerEq(l, '<<<<<<< SEARCH')) return 'search-replace';
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

function tierNorm(line, tier) {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function findOccurrences(fileLines, oldLines, strict, from, eofOnly) {
  const start = from === undefined ? 0 : from;
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier += 1) {
    const norm = (s) => tierNorm(s, tier);
    const needle = oldLines.map(norm);
    const positions = [];
    const last = fileLines.length - oldLines.length;
    for (let i = start; i <= last; i += 1) {
      if (eofOnly && i + oldLines.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < oldLines.length; j += 1) {
        if (norm(fileLines[i + j]) !== needle[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { positions, tier };
  }
  return null;
}

function findAnchor(fileLines, cursor, anchor, strict) {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier += 1) {
    const norm = (s) => tierNorm(s, tier);
    const target = norm(anchor);
    for (let i = cursor; i < fileLines.length; i += 1) {
      if (norm(fileLines[i]) === target) return i;
    }
  }
  return null;
}

function buildON(body) {
  const O = [];
  const N = [];
  for (const b of body) {
    if (b.kind === 'context') {
      const idx = O.length;
      O.push(b.text);
      N.push({ text: b.text, ctx: idx });
    } else if (b.kind === 'old') {
      O.push(b.text);
    } else if (b.kind === 'new') {
      N.push({ text: b.text, ctx: null });
    }
  }
  return { O, N };
}

function materialize(N, fileLines, pos, tier, O) {
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = leadingWS(fileLines[pos]);
    P = leadingWS(O[0]);
  }
  return N.map((e) => {
    if (e.ctx !== null) return fileLines[pos + e.ctx];
    let t = e.text;
    if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    return t;
  });
}

// Tree holds two representations: a parsed line view (lines/eol/finalBreak) for hunk edits and rawOverride for byte-exact file_text.
class Tree {
  constructor() {
    this.files = new Map();
    this.moves = [];
  }
}

function readTree(dir, tree) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      readTree(full, tree);
    } else if (ent.isFile()) {
      const rel = dir === '.' ? ent.name : relative('.', full).split(sep).join('/');
      tree.files.set(rel, parseFile(readFileSync(full, 'utf8')));
    }
  }
}

function writeTree(tree, initial) {
  for (const p of initial.keys()) {
    if (!tree.files.has(p)) {
      try {
        unlinkSync(join(...p.split('/')));
      } catch (e) {}
    }
  }
  for (const [p, st] of tree.files) {
    const parts = p.split('/');
    let dir = '.';
    for (let i = 0; i < parts.length - 1; i += 1) {
      dir = join(dir, parts[i]);
      if (!existsSync(dir)) mkdirSync(dir);
    }
    writeFileSync(join(...parts), content(st));
  }
}

function parseDiffPath(s) {
  let p = s.split('\t')[0].trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

function collectHunkBody(lines, start) {
  const raw = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (i + 1 < lines.length && l.startsWith('--- ') && lines[i + 1].startsWith('+++ ')) break;
    if (l.startsWith('diff --git ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      raw.push(l);
      i += 1;
    } else {
      break;
    }
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const body = raw.map((l) => {
    if (l === '') return { kind: 'context', text: '' };
    if (l.startsWith('\\')) return { kind: 'backslash', text: l.slice(1) };
    if (l.startsWith(' ')) return { kind: 'context', text: l.slice(1) };
    if (l.startsWith('-')) return { kind: 'old', text: l.slice(1) };
    return { kind: 'new', text: l.slice(1) };
  });
  return { body, end: i };
}

function parseUnified(lines) {
  const sections = [];
  let cur = null;
  const finalize = () => {
    if (cur !== null) {
      sections.push(cur);
      cur = null;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m === null) throw new ParseError(i + 1);
      finalize();
      cur = {
        gitOld: m[1],
        gitNew: m[2],
        oldPath: undefined,
        newPath: undefined,
        renameFrom: undefined,
        renameTo: undefined,
        newFile: false,
        deletedFile: false,
        hunks: [],
        headerLine: i + 1,
      };
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const op = parseDiffPath(line.slice(4));
      const np = parseDiffPath(lines[i + 1].slice(4));
      if (cur !== null && cur.hunks.length === 0) {
        cur.oldPath = op;
        cur.newPath = np;
      } else {
        finalize();
        cur = {
          gitOld: undefined,
          gitNew: undefined,
          oldPath: op,
          newPath: np,
          renameFrom: undefined,
          renameTo: undefined,
          newFile: false,
          deletedFile: false,
          hunks: [],
          headerLine: i + 1,
        };
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseError(i + 1);
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m === null) throw new ParseError(i + 1);
      const collected = collectHunkBody(lines, i + 1);
      cur.hunks.push({ A: parseInt(m[1], 10), body: collected.body });
      i = collected.end;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new ParseError(i + 2);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  finalize();
  return sections.map(sectionToEdit);
}

function sectionToEdit(s) {
  const oldPath = s.oldPath !== undefined ? s.oldPath : s.renameFrom !== undefined ? s.renameFrom : s.gitOld;
  const newPath = s.newPath !== undefined ? s.newPath : s.renameTo !== undefined ? s.renameTo : s.gitNew;
  if (oldPath === null || s.newFile) {
    return { type: 'unified', oldPath: null, newPath: newPath === undefined ? null : newPath, creation: true, deletion: false, rename: false, hunks: s.hunks, line: s.headerLine };
  }
  if (newPath === null || s.deletedFile) {
    return { type: 'unified', oldPath: oldPath === undefined ? null : oldPath, newPath: null, creation: false, deletion: true, rename: false, hunks: [], line: s.headerLine };
  }
  const op = oldPath === undefined ? '' : oldPath;
  const np = newPath === undefined ? '' : newPath;
  return { type: 'unified', oldPath: op, newPath: np, creation: false, deletion: false, rename: op !== np, hunks: s.hunks, line: s.headerLine };
}

function noNewlineAtEnd(body) {
  let last = -1;
  for (let j = 0; j < body.length; j += 1) {
    if (body[j].kind === 'context' || body[j].kind === 'new') last = j;
  }
  return last >= 0 && last + 1 < body.length && body[last + 1].kind === 'backslash';
}

function applyHunk(fileLines, hunk, built, d, strict, oldFinalBreak) {
  const O = built.O;
  let pos;
  let tier;
  if (O.length === 0) {
    pos = Math.min(hunk.A + d, fileLines.length);
    tier = 0;
  } else {
    const found = findOccurrences(fileLines, O, strict);
    if (found === null) return { ok: false, code: 'no-match' };
    tier = found.tier;
    const target = hunk.A - 1 + d;
    pos = found.positions[0];
    let best = Math.abs(pos - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
  }
  const repl = materialize(built.N, fileLines, pos, tier, O);
  const lines = fileLines.slice(0, pos).concat(repl, fileLines.slice(pos + O.length));
  const atEnd = O.length === 0 ? pos === fileLines.length : pos + O.length === fileLines.length;
  const finalBreak = atEnd ? !noNewlineAtEnd(hunk.body) : oldFinalBreak;
  return { ok: true, lines, finalBreak };
}

function applyUnified(tree, edit, strict) {
  if (edit.creation) {
    if (edit.newPath === null || !isSafePath(edit.newPath)) return new Fail('unsafe', edit.newPath === null ? '' : edit.newPath);
    if (tree.files.has(edit.newPath)) return new Fail('exists', edit.newPath);
    const lines = [];
    let lastNoNewline = false;
    for (const h of edit.hunks) {
      for (let j = 0; j < h.body.length; j += 1) {
        const b = h.body[j];
        if (b.kind === 'new') {
          lines.push(b.text);
          lastNoNewline = j + 1 < h.body.length && h.body[j + 1].kind === 'backslash';
        }
      }
    }
    tree.files.set(edit.newPath, { lines, eol: '\n', finalBreak: lines.length > 0 ? !lastNoNewline : false, rawOverride: null });
    return null;
  }
  if (edit.oldPath === null || !isSafePath(edit.oldPath)) return new Fail('unsafe', edit.oldPath === null ? '' : edit.oldPath);
  if (edit.deletion) {
    if (!tree.files.has(edit.oldPath)) return new Fail('missing', edit.oldPath);
    tree.files.delete(edit.oldPath);
    return null;
  }
  if (edit.rename && (edit.newPath === null || !isSafePath(edit.newPath))) return new Fail('unsafe', edit.newPath === null ? '' : edit.newPath);
  const st = tree.files.get(edit.oldPath);
  if (st === undefined) return new Fail('missing', edit.oldPath);
  if (edit.rename && tree.files.has(edit.newPath)) return new Fail('exists', edit.newPath);
  let lines = st.lines.slice();
  let finalBreak = st.finalBreak;
  let d = 0;
  for (const h of edit.hunks) {
    const built = buildON(h.body);
    const r = applyHunk(lines, h, built, d, strict, finalBreak);
    if (!r.ok) return new Fail(r.code, edit.oldPath);
    lines = r.lines;
    finalBreak = r.finalBreak;
    // d carries the accumulated N-O drift so later hunks' A values address the current line array, not the original one.
    d += built.N.length - built.O.length;
  }
  if (edit.rename) {
    tree.files.delete(edit.oldPath);
    tree.files.set(edit.newPath, { lines, eol: st.eol, finalBreak, rawOverride: null });
    tree.moves.push({ old: edit.oldPath, new: edit.newPath });
  } else {
    tree.files.set(edit.oldPath, { lines, eol: st.eol, finalBreak, rawOverride: null });
  }
  return null;
}

function parseSearchReplace(lines) {
  const edits = [];
  let prevPath = null;
  let regionStart = 0;
  let i = 0;
  while (i < lines.length) {
    if (markerEq(lines[i], '<<<<<<< SEARCH')) {
      const searchLine = i + 1;
      let p = null;
      for (let j = i - 1; j >= regionStart; j -= 1) {
        const t = lines[j].trim();
        if (t === '' || t.startsWith('```')) continue;
        p = t;
        break;
      }
      if (p === null) {
        if (prevPath === null) throw new ParseError(searchLine);
        p = prevPath;
      }
      let eqIdx = -1;
      let repIdx = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (eqIdx === -1) {
          if (markerEq(lines[j], '=======')) eqIdx = j;
        } else if (markerEq(lines[j], '>>>>>>> REPLACE')) {
          repIdx = j;
          break;
        }
      }
      if (eqIdx === -1 || repIdx === -1) throw new ParseError(searchLine);
      edits.push({
        type: 'sr',
        path: p,
        oldLines: lines.slice(i + 1, eqIdx),
        newLines: lines.slice(eqIdx + 1, repIdx),
        line: searchLine,
      });
      prevPath = p;
      regionStart = repIdx + 1;
      i = repIdx + 1;
      continue;
    }
    i += 1;
  }
  return edits;
}

function applySR(tree, edit, strict) {
  if (!isSafePath(edit.path)) return new Fail('unsafe', edit.path);
  if (edit.oldLines.length === 0) {
    if (tree.files.has(edit.path)) return new Fail('exists', edit.path);
    tree.files.set(edit.path, { lines: edit.newLines.slice(), eol: '\n', finalBreak: edit.newLines.length > 0, rawOverride: null });
    return null;
  }
  const st = tree.files.get(edit.path);
  if (st === undefined) return new Fail('missing', edit.path);
  const found = findOccurrences(st.lines, edit.oldLines, strict);
  if (found === null) return new Fail('no-match', edit.path);
  if (found.positions.length > 1) return new Fail('ambiguous', edit.path);
  const pos = found.positions[0];
  const N = edit.newLines.map((t) => ({ text: t, ctx: null }));
  const repl = materialize(N, st.lines, pos, found.tier, edit.oldLines);
  const lines = st.lines.slice(0, pos).concat(repl, st.lines.slice(pos + edit.oldLines.length));
  tree.files.set(edit.path, { lines, eol: st.eol, finalBreak: st.finalBreak, rawOverride: null });
  return null;
}

function isSectionStart(l) {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function parseV4A(lines) {
  let b = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!blank(lines[i])) {
      b = i;
      break;
    }
  }
  if (b < 0 || lines[b].trim() !== '*** Begin Patch') throw new ParseError(b < 0 ? 1 : b + 1);
  let e = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i])) {
      e = i;
      break;
    }
  }
  if (e === b || lines[e].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);

  const edits = [];
  let i = b + 1;
  while (i < e) {
    const line = lines[i];
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      const headerLine = i + 1;
      i += 1;
      const entries = [];
      while (i < e && !isSectionStart(lines[i])) {
        entries.push({ text: lines[i], line: i + 1 });
        i += 1;
      }
      while (entries.length > 0 && blank(entries[entries.length - 1].text)) entries.pop();
      const fileLines = [];
      for (const en of entries) {
        if (en.text === '') fileLines.push('');
        else if (en.text.startsWith('+')) fileLines.push(en.text.slice(1));
        else throw new ParseError(en.line);
      }
      edits.push({ type: 'v4a-add', path, lines: fileLines, line: headerLine });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      const headerLine = i + 1;
      i += 1;
      const entries = [];
      while (i < e && !isSectionStart(lines[i])) {
        entries.push({ text: lines[i], line: i + 1 });
        i += 1;
      }
      while (entries.length > 0 && blank(entries[entries.length - 1].text)) entries.pop();
      if (entries.length > 0) throw new ParseError(entries[0].line);
      edits.push({ type: 'v4a-del', path, line: headerLine });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const headerLine = i + 1;
      i += 1;
      const entries = [];
      while (i < e && !isSectionStart(lines[i])) {
        entries.push({ text: lines[i], line: i + 1 });
        i += 1;
      }
      while (entries.length > 0 && blank(entries[entries.length - 1].text)) entries.pop();
      let newPath = null;
      let p = 0;
      if (entries.length > 0 && entries[0].text.startsWith('*** Move to: ')) {
        newPath = entries[0].text.slice(13).trim();
        p = 1;
      }
      const chunks = [];
      let first = true;
      while (p < entries.length) {
        const ent = entries[p];
        if (blank(ent.text)) {
          p += 1;
          continue;
        }
        let anchor = null;
        if (ent.text.startsWith('@@')) {
          const t = ent.text.slice(2).trim();
          anchor = t === '' ? null : t;
          p += 1;
        } else if (first) {
          anchor = null;
        } else {
          throw new ParseError(ent.line);
        }
        const body = [];
        let eof = false;
        while (p < entries.length) {
          const en = entries[p];
          if (en.text.trim() === '*** End of File') {
            eof = true;
            p += 1;
            break;
          }
          if (en.text.startsWith('@@') || isSectionStart(en.text)) break;
          if (en.text === '') body.push({ kind: 'context', text: '' });
          else if (en.text.startsWith(' ')) body.push({ kind: 'context', text: en.text.slice(1) });
          else if (en.text.startsWith('-')) body.push({ kind: 'old', text: en.text.slice(1) });
          else if (en.text.startsWith('+')) body.push({ kind: 'new', text: en.text.slice(1) });
          else throw new ParseError(en.line);
          p += 1;
        }
        chunks.push({ anchor, endOfFile: eof, body });
        first = false;
      }
      if (chunks.length === 0 && newPath === null) throw new ParseError(headerLine);
      edits.push({ type: 'v4a-update', path, newPath, chunks, line: headerLine });
      continue;
    }
    throw new ParseError(i + 1);
  }
  return edits;
}

function applyV4A(tree, edit, strict) {
  if (!isSafePath(edit.path)) return new Fail('unsafe', edit.path);
  if (edit.type === 'v4a-add') {
    if (tree.files.has(edit.path)) return new Fail('exists', edit.path);
    tree.files.set(edit.path, { lines: edit.lines.slice(), eol: '\n', finalBreak: edit.lines.length > 0, rawOverride: null });
    return null;
  }
  if (edit.type === 'v4a-del') {
    if (!tree.files.has(edit.path)) return new Fail('missing', edit.path);
    tree.files.delete(edit.path);
    return null;
  }
  if (edit.newPath !== null && !isSafePath(edit.newPath)) return new Fail('unsafe', edit.newPath);
  const st = tree.files.get(edit.path);
  if (st === undefined) return new Fail('missing', edit.path);
  if (edit.newPath !== null && tree.files.has(edit.newPath)) return new Fail('exists', edit.newPath);
  let lines = st.lines.slice();
  let cursor = 0;
  for (const ch of edit.chunks) {
    if (ch.anchor !== null) {
      const ai = findAnchor(lines, cursor, ch.anchor, strict);
      if (ai === null) return new Fail('no-match', edit.path);
      cursor = ai + 1;
    }
    const built = buildON(ch.body);
    const O = built.O;
    let pos;
    let tier;
    if (O.length === 0) {
      pos = ch.endOfFile ? lines.length : Math.min(cursor, lines.length);
      tier = 0;
    } else {
      const found = findOccurrences(lines, O, strict, cursor, ch.endOfFile);
      if (found === null) return new Fail('no-match', edit.path);
      pos = found.positions[0];
      tier = found.tier;
    }
    const repl = materialize(built.N, lines, pos, tier, O);
    lines = lines.slice(0, pos).concat(repl, lines.slice(pos + O.length));
    // Cursor resumes just past the newly written lines so later chunks search only after this chunk's output.
    cursor = pos + repl.length;
  }
  if (edit.newPath !== null) {
    tree.files.delete(edit.path);
    tree.files.set(edit.newPath, { lines, eol: st.eol, finalBreak: st.finalBreak, rawOverride: null });
    tree.moves.push({ old: edit.path, new: edit.newPath });
  } else {
    tree.files.set(edit.path, { lines, eol: st.eol, finalBreak: st.finalBreak, rawOverride: null });
  }
  return null;
}

function jsonEdit(o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
  if (typeof o.path !== 'string') return null;
  const path = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { type: 'json-create', path, fileText: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { type: 'json-replace', path, oldStr: o.old_str, newStr: o.new_str === undefined ? '' : o.new_str };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { type: 'json-insert', path, insertLine: o.insert_line, newStr: o.new_str };
  }
  return null;
}

function jsonEdits(text, lines) {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    let startLine = 1;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trimStart().startsWith('[')) {
        startLine = i + 1;
        break;
      }
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new ParseError(startLine);
    }
    if (!Array.isArray(data)) throw new ParseError(startLine);
    const edits = [];
    for (const o of data) {
      const e = jsonEdit(o);
      if (e === null) throw new ParseError(startLine);
      edits.push(e);
    }
    return edits;
  }
  const edits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (blank(lines[i])) continue;
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch (err) {
      throw new ParseError(i + 1);
    }
    const e = jsonEdit(o);
    if (e === null) throw new ParseError(i + 1);
    edits.push(e);
  }
  return edits;
}

function countOccurrences(text, sub) {
  let count = 0;
  let from = 0;
  for (;;) {
    const i = text.indexOf(sub, from);
    if (i < 0) break;
    count += 1;
    from = i + 1;
  }
  return count;
}

function applyJson(tree, edit) {
  if (!isSafePath(edit.path)) return new Fail('unsafe', edit.path);
  if (edit.type === 'json-create') {
    if (tree.files.has(edit.path)) return new Fail('exists', edit.path);
    const st = parseFile(edit.fileText);
    st.rawOverride = edit.fileText;
    tree.files.set(edit.path, st);
    return null;
  }
  const st = tree.files.get(edit.path);
  if (st === undefined) return new Fail('missing', edit.path);
  if (edit.type === 'json-replace') {
    const crlf = st.eol === '\r\n';
    let text = content(st);
    let oldStr = edit.oldStr;
    let newStr = edit.newStr;
    if (crlf) {
      text = text.replace(/\r\n/g, '\n');
      oldStr = oldStr.replace(/\r\n/g, '\n');
      newStr = newStr.replace(/\r\n/g, '\n');
    }
    const count = countOccurrences(text, oldStr);
    if (count === 0) return new Fail('no-match', edit.path);
    if (count > 1) return new Fail('ambiguous', edit.path);
    const idx = text.indexOf(oldStr);
    let result = text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
    if (crlf) result = result.replace(/\n/g, '\r\n');
    const ns = parseFile(result);
    ns.rawOverride = result;
    tree.files.set(edit.path, ns);
    return null;
  }
  if (edit.insertLine < 0 || edit.insertLine > st.lines.length) return new Fail('no-match', edit.path);
  const nl = splitNewLines(edit.newStr);
  const ls = st.lines.slice();
  ls.splice(edit.insertLine, 0, ...nl);
  tree.files.set(edit.path, { lines: ls, eol: st.eol, finalBreak: st.finalBreak, rawOverride: null });
  return null;
}

function applyEdit(tree, edit, strict) {
  if (edit.type === 'unified') return applyUnified(tree, edit, strict);
  if (edit.type === 'sr') return applySR(tree, edit, strict);
  if (edit.type === 'v4a-add' || edit.type === 'v4a-del' || edit.type === 'v4a-update') return applyV4A(tree, edit, strict);
  return applyJson(tree, edit);
}

function pathKey(line) {
  if (line.startsWith('R ')) {
    const i = line.indexOf(' -> ');
    return line.slice(i + 4);
  }
  return line.slice(2);
}

function run() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args === null) throw new Exit2('error: usage');
    let patchText;
    try {
      patchText = args.patch === null || args.patch === '-' ? readFileSync(0, 'utf8') : readFileSync(args.patch, 'utf8');
    } catch (err) {
      throw new Exit2('error: no-patch');
    }
    const lines = patchLines(patchText);
    let fmt = args.format;
    if (fmt === 'auto') {
      const d = detect(lines);
      if (d === null) throw new Exit2('error: format');
      fmt = d;
    }
    let edits;
    try {
      if (fmt === 'unified') edits = parseUnified(lines);
      else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
      else if (fmt === 'v4a') edits = parseV4A(lines);
      else edits = jsonEdits(patchText, lines);
    } catch (err) {
      if (err instanceof ParseError) throw new Exit2('error: parse ' + err.line);
      throw err;
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');

    const tree = new Tree();
    readTree('.', tree);
    const initial = new Map();
    for (const [p, st] of tree.files) initial.set(p, content(st));

    const failures = [];
    for (const edit of edits) {
      const f = applyEdit(tree, edit, args.strict);
      if (f !== null) failures.push(f);
    }
    if (failures.length > 0) {
      const result = failures.map((f) => 'error: ' + f.code + ' ' + f.path);
      result.push('failed: ' + failures.length + ' of ' + edits.length + ' edits');
      out(result);
      process.exitCode = 1;
      return;
    }

    const final = new Map();
    for (const [p, st] of tree.files) final.set(p, content(st));
    const result = [];
    const movedOld = new Set();
    const movedNew = new Set();
    for (const m of tree.moves) {
      if (movedNew.has(m.new)) continue;
      if (initial.has(m.old) && !final.has(m.old) && !initial.has(m.new) && final.has(m.new)) {
        result.push('R ' + m.old + ' -> ' + m.new);
        movedOld.add(m.old);
        movedNew.add(m.new);
      }
    }
    for (const p of new Set([...initial.keys(), ...final.keys()])) {
      const a = initial.has(p) ? initial.get(p) : undefined;
      const b = final.has(p) ? final.get(p) : undefined;
      if (a === undefined && b !== undefined && !movedNew.has(p)) result.push('A ' + p);
      else if (a !== undefined && b === undefined && !movedOld.has(p)) result.push('D ' + p);
      else if (a !== undefined && b !== undefined && a !== b) result.push('M ' + p);
    }
    result.sort((x, y) => Buffer.compare(Buffer.from(pathKey(x), 'utf8'), Buffer.from(pathKey(y), 'utf8')));
    const n = result.length;
    result.push(n === 1 ? 'ok: 1 file' : 'ok: ' + n + ' files');
    out(result);
    if (!args.check) writeTree(tree, initial);
  } catch (err) {
    if (err instanceof Exit2) {
      out([err.msg]);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

if (process.env.MAKEFUN_ENV_URL) {
  import('./runner.ts').then((m) => m.runTrial(process.env.MAKEFUN_ENV_URL));
} else {
  run();
}
