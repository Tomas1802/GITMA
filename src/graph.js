// Commit-graph lane layout. Input: commits in display order (children before parents),
// each { sha, parents }. Output per row:
//   col   – lane of the commit's node
//   topIn – a line enters the node from above in its own lane
//   ins   – other lanes that end in this node (branches forking off here, seen from above)
//   pass  – lanes passing straight through the row
//   outs  – lanes the node connects to below (one per parent)
//   moves – [from, to] lanes that shift left across this row (a lane converging into this node's lane)
export function layout(commits) {
  const lanes = []; // lanes[j] = sha that lane j is waiting for
  const rows = [];
  let width = 0;
  for (const c of commits) {
    let col = lanes.indexOf(c.sha);
    const topIn = col !== -1;
    if (!topIn) col = freeLane(lanes);
    const ins = [];
    lanes.forEach((s, j) => {
      if (j !== col && s === c.sha) {
        ins.push(j);
        lanes[j] = null;
      }
    });
    lanes[col] = null;
    const pass = [];
    lanes.forEach((s, j) => s && pass.push(j));
    const moves = [];
    const outs = c.parents.map((p, k) => {
      let j = lanes.indexOf(p);
      if (k === 0 && j > col) {
        // Another lane already waits for our first parent further right: pull it into our lane so
        // the mainline stays straight and the side lane converges into it.
        lanes[j] = null;
        pass.splice(pass.indexOf(j), 1);
        moves.push([j, col]);
        j = -1;
      }
      if (j === -1) {
        j = k === 0 ? col : freeLane(lanes);
        lanes[j] = p;
      }
      return j;
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, lanes.length, col + 1);
    rows.push({ col, topIn, ins, pass, outs, moves });
  }
  return { rows, width };
}

function freeLane(lanes) {
  const i = lanes.indexOf(null);
  return i === -1 ? lanes.length : i;
}
