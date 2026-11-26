import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout } from './graph.js';

const c = (sha, ...parents) => ({ sha, parents });

test('linear history stays in lane 0', () => {
  const { rows, width } = layout([c('c', 'b'), c('b', 'a'), c('a')]);
  assert.equal(width, 1);
  assert.deepEqual(rows.map((r) => r.col), [0, 0, 0]);
  assert.deepEqual(rows[0], { col: 0, topIn: false, ins: [], pass: [], outs: [0], moves: [] });
  assert.deepEqual(rows[2].outs, []);
});

test('branch and merge use a second lane', () => {
  // m merges f into main; f and b both come from a
  const { rows, width } = layout([c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a')]);
  assert.equal(width, 2);
  assert.deepEqual(rows[0].outs, [0, 1]); // merge: own lane + new lane for f
  assert.equal(rows[1].col, 1); // f sits in lane 1
  assert.deepEqual(rows[1].pass, [0]); // main passes by
  assert.equal(rows[2].col, 0); // b in lane 0
  assert.deepEqual(rows[2].pass, []); // lane 1 (waiting for a) converges into b's lane
  assert.deepEqual(rows[2].moves, [[1, 0]]);
  assert.equal(rows[3].col, 0); // mainline stays in lane 0
});

test('two branch tips sharing a parent', () => {
  const { rows } = layout([c('x', 'a'), c('y', 'a'), c('a')]);
  assert.deepEqual([rows[0].col, rows[1].col], [0, 1]);
  assert.equal(rows[1].topIn, false);
  assert.deepEqual(rows[1].outs, [0]); // y joins lane 0, which already waits for a
  assert.equal(rows[2].col, 0);
});

test('parents beyond the loaded window keep their lane open', () => {
  const { rows } = layout([c('b', 'a')]);
  assert.deepEqual(rows[0].outs, [0]);
});
