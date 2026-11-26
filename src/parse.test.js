import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLog, parseRefs, parseStatus, parseDiff, parseBlame, parseConflicts } from './parse.js';
import { buildPatch } from './patch.js';

test('parseLog', () => {
  const t = 'aaa\x1fbbb ccc\x1fAna\x1fa@x\x1f100\x1fmerge it\x1e\nbbb\x1f\x1fBo\x1fb@x\x1f50\x1finit\x1e\n';
  const [m, root] = parseLog(t);
  assert.deepEqual(m.parents, ['bbb', 'ccc']);
  assert.equal(m.subject, 'merge it');
  assert.deepEqual(root.parents, []);
});

test('parseRefs', () => {
  const t = [
    'refs/heads/main\x1fa1\x1f\x1forigin/main\x1fahead 2, behind 1\x1f*\x1f',
    'refs/remotes/origin/HEAD\x1fa1\x1f\x1f\x1f\x1f \x1frefs/remotes/origin/main',
    'refs/remotes/origin/main\x1fb2\x1f\x1f\x1f\x1f \x1f',
    'refs/tags/v1\x1ftagobj\x1fc3\x1f\x1f\x1f \x1f',
  ].join('\n');
  const refs = parseRefs(t);
  assert.equal(refs.length, 3);
  assert.deepEqual([refs[0].ahead, refs[0].behind, refs[0].head], [2, 1, true]);
  assert.equal(refs[1].remote, 'origin');
  assert.equal(refs[2].sha, 'c3'); // annotated tag peeled
});

test('parseStatus', () => {
  const t = [
    '1 M. N... 100644 100644 100644 h1 h2 staged file.txt',
    '1 .M N... 100644 100644 100644 h1 h2 work.txt',
    '2 R. N... 100644 100644 100644 h1 h2 R100 new.txt', 'old.txt',
    'u UU N... 100644 100644 100644 100644 h1 h2 h3 c.txt',
    '? new dir/x.txt', '',
  ].join('\0');
  const s = parseStatus(t);
  assert.deepEqual(s.staged.map((f) => f.path), ['staged file.txt', 'new.txt']);
  assert.equal(s.staged[1].orig, 'old.txt');
  assert.deepEqual(s.unstaged.map((f) => f.path), ['work.txt', 'new dir/x.txt']);
  assert.deepEqual(s.conflicts.map((f) => f.path), ['c.txt']);
});

const DIFF = `diff --git a/f.txt b/f.txt
index 1..2 100644
--- a/f.txt
+++ b/f.txt
@@ -1,4 +1,4 @@
 a
-b
-c
+B
+C
 d
`;

test('parseDiff line numbers', () => {
  const [f] = parseDiff(DIFF);
  assert.equal(f.newPath, 'f.txt');
  assert.equal(f.header.length, 4);
  const l = f.hunks[0].lines;
  assert.deepEqual(l.map((x) => [x.t, x.old, x.new]), [
    [' ', 1, 1], ['-', 2, null], ['-', 3, null], ['+', null, 2], ['+', null, 3], [' ', 4, 4],
  ]);
});

test('buildPatch stages only selected lines', () => {
  const [f] = parseDiff(DIFF);
  // select "-b" (1) and "+B" (3)
  const p = buildPatch(f, f.hunks[0], new Set([1, 3]));
  assert.equal(p.split('\n').slice(5).join('\n'), ' a\n-b\n c\n+B\n d\n');
});

test('buildPatch reverse keeps unselected additions as context', () => {
  const [f] = parseDiff(DIFF);
  const p = buildPatch(f, f.hunks[0], new Set([1, 3]), true);
  assert.equal(p.split('\n').slice(5).join('\n'), ' a\n-b\n+B\n C\n d\n');
});

test('buildPatch returns null when nothing selected', () => {
  const [f] = parseDiff(DIFF);
  assert.equal(buildPatch(f, f.hunks[0], new Set([0])), null);
});

test('parseBlame', () => {
  const sha = 'a'.repeat(40);
  const t = `${sha} 1 1 2\nauthor Ana\nauthor-time 100\nsummary init\nfilename f\n\tline one\n${sha} 2 2\n\tline two\n`;
  const b = parseBlame(t);
  assert.equal(b.length, 2);
  assert.deepEqual([b[1].author, b[1].line, b[1].text], ['Ana', 2, 'line two']);
});

test('parseConflicts', () => {
  const t = 'top\n<<<<<<< HEAD\nours\n||||||| base\norig\n=======\ntheirs\n>>>>>>> feat\nend\n';
  const s = parseConflicts(t);
  assert.equal(s.length, 3);
  assert.deepEqual(s[1], { ours: 'ours\n', theirs: 'theirs\n', oursLabel: 'HEAD', theirsLabel: 'feat' });
  assert.equal(s[2].text, 'end\n');
});
