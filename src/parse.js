// Parsers for git's machine-readable output. Pure functions, no I/O.

export const US = '\x1f'; // field separator
export const RS = '\x1e'; // record separator

export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%s'].join('%x1f') + '%x1e';

export function parseLog(text) {
  return text
    .split(RS)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [sha, parents, author, email, time, subject] = r.split(US);
      return {
        sha,
        parents: parents ? parents.split(' ') : [],
        author,
        email,
        time: Number(time),
        subject,
      };
    });
}

export const REF_FORMAT = [
  '%(refname)', '%(objectname)', '%(*objectname)', '%(upstream:short)',
  '%(upstream:track,nobracket)', '%(HEAD)', '%(symref)',
].join('%1f');

export function parseRefs(text) {
  const refs = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [name, oid, peeled, upstream, track, head, symref] = line.split(US);
    if (symref) continue; // refs/remotes/origin/HEAD
    const type = name.startsWith('refs/heads/') ? 'local' : name.startsWith('refs/remotes/') ? 'remote' : 'tag';
    const short = name.replace(/^refs\/(heads|remotes|tags)\//, '');
    refs.push({
      name,
      short,
      type,
      sha: peeled || oid,
      remote: type === 'remote' ? short.split('/')[0] : null,
      upstream: upstream || null,
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
      gone: track === 'gone',
      head: head === '*',
    });
  }
  return refs;
}

// `git status --porcelain=v2 -z --untracked-files=all`
export function parseStatus(text) {
  const tokens = text.split('\0');
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    const kind = t[0];
    if (kind === '?') {
      files.push({ path: t.slice(2), x: '?', y: '?', untracked: true });
    } else if (kind === '1') {
      const f = t.split(' ');
      files.push({ path: f.slice(8).join(' '), x: f[1][0], y: f[1][1] });
    } else if (kind === '2') {
      const f = t.split(' ');
      files.push({ path: f.slice(9).join(' '), orig: tokens[++i], x: f[1][0], y: f[1][1] });
    } else if (kind === 'u') {
      const f = t.split(' ');
      files.push({ path: f.slice(10).join(' '), x: f[1][0], y: f[1][1], conflict: true });
    }
  }
  return {
    files,
    staged: files.filter((f) => !f.untracked && !f.conflict && f.x !== '.'),
    unstaged: files.filter((f) => f.untracked || (!f.conflict && f.y !== '.')),
    conflicts: files.filter((f) => f.conflict),
  };
}

// Unified diff → [{ header[], oldPath, newPath, binary, hunks: [{ header, lines: [{t, raw, text, old, new}] }] }]
export function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    if (raw.startsWith('diff --git ') || raw.startsWith('diff --cc ')) {
      file = { header: [raw], oldPath: null, newPath: null, binary: false, hunks: [] };
      files.push(file);
      hunk = null;
      const m = /^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/.exec(raw);
      if (m) [file.oldPath, file.newPath] = [m[1], m[2]];
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('@@')) {
      const m = /^@@+ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
      oldNo = Number(m?.[1] ?? 0);
      newNo = Number(m?.[2] ?? 0);
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      file.header.push(raw);
      if (raw.startsWith('--- ')) file.oldPath = stripPrefix(raw.slice(4), 'a/') ?? file.oldPath;
      else if (raw.startsWith('+++ ')) file.newPath = stripPrefix(raw.slice(4), 'b/') ?? file.newPath;
      else if (raw.startsWith('Binary files')) file.binary = true;
      continue;
    }
    const t = raw[0] ?? ' ';
    const line = { t, raw, text: raw.slice(1), old: null, new: null };
    if (t === ' ') [line.old, line.new] = [oldNo++, newNo++];
    else if (t === '-') line.old = oldNo++;
    else if (t === '+') line.new = newNo++;
    hunk.lines.push(line);
  }
  return files;
}

function stripPrefix(p, prefix) {
  if (p === '/dev/null') return null;
  const s = p.replace(/^"|"$/g, '');
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

// `git blame --porcelain` → [{ sha, author, time, summary, line, text }]
export function parseBlame(text) {
  const info = new Map();
  const out = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(raw);
    if (head) {
      if (!info.has(head[1])) info.set(head[1], { sha: head[1] });
      cur = { meta: info.get(head[1]), line: Number(head[2]) };
    } else if (!cur) {
      continue;
    } else if (raw.startsWith('\t')) {
      out.push({ ...cur.meta, line: cur.line, text: raw.slice(1) });
      cur = null;
    } else if (raw.startsWith('author ')) cur.meta.author = raw.slice(7);
    else if (raw.startsWith('author-time ')) cur.meta.time = Number(raw.slice(12));
    else if (raw.startsWith('summary ')) cur.meta.summary = raw.slice(8);
  }
  return out;
}

// Conflict markers → [{ text } | { ours, theirs, oursLabel, theirsLabel }]
export function parseConflicts(text) {
  const segs = [];
  let buf = [];
  let c = null;
  let part = null;
  const lines = text.split(/(?<=\n)/);
  for (const l of lines) {
    if (!c && l.startsWith('<<<<<<<')) {
      if (buf.length) segs.push({ text: buf.join('') });
      buf = [];
      c = { ours: '', theirs: '', oursLabel: l.slice(8).trim(), theirsLabel: '' };
      part = 'ours';
    } else if (c && l.startsWith('|||||||')) part = 'base';
    else if (c && l.startsWith('=======') && part !== 'theirs') part = 'theirs';
    else if (c && l.startsWith('>>>>>>>')) {
      c.theirsLabel = l.slice(8).trim();
      segs.push(c);
      c = null;
    } else if (c) {
      if (part !== 'base') c[part] += l;
    } else buf.push(l);
  }
  if (c) buf.unshift('<<<<<<< ' + c.oursLabel + '\n', c.ours, '=======\n', c.theirs); // unterminated: keep as text
  if (buf.length) segs.push({ text: buf.join('') });
  return segs;
}

export const shortSha = (sha) => sha.slice(0, 7);

export function relTime(unix) {
  const s = Date.now() / 1000 - unix;
  if (s < 60) return 'just now';
  const units = [[60, 'min'], [3600, 'h'], [86400, 'd'], [2592000, 'mo'], [31536000, 'y']];
  let label = 'min';
  let div = 60;
  for (const [d, l] of units) if (s >= d) [div, label] = [d, l];
  return `${Math.floor(s / div)}${label === 'min' ? ' min' : label} ago`;
}
