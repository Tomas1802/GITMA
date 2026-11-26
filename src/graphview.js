// Virtualized commit graph: only visible rows exist in the DOM; lanes are drawn on one canvas.
import { el, clear } from './ui.js';
import { relTime, shortSha } from './parse.js';
import { commitMenu, refMenu, dropMenu } from './menus.js';
import { checkout, checkoutRef } from './actions.js';

const H = 28; // row height
const LW = 18; // lane width
const MAX_LANES = 40;
const REFS_W = 210;
const OVERSCAN = 8;
export const COLORS = ['#7aa2f7', '#bb9af7', '#9ece6a', '#e0af68', '#f7768e', '#7dcfff', '#ff9e64', '#73daca', '#c0caf5', '#2ac3de'];
export const laneColor = (j) => COLORS[j % COLORS.length];

export function createGraphView(app) {
  const canvas = el('canvas.graph-canvas');
  const rowsEl = el('div.graph-rows');
  const scroll = el('div.graph-scroll', { tabIndex: 0 }, rowsEl);
  const header = el('div.graph-header', {},
    el('div.c-refs', {}, 'Branch / Tag'), el('div.c-graph#graph-head', {}, 'Graph'),
    el('div.c-msg', {}, 'Commit message'), el('div.c-author', {}, 'Author'),
    el('div.c-date', {}, 'Date'), el('div.c-sha', {}, 'SHA'));
  const root = el('div.graph', {}, header, el('div.graph-body', {}, scroll, canvas));
  let search = { q: '', matches: [], at: -1 };
  let drag = null;

  const repo = () => app.repo;
  const graphPx = () => (Math.min(repo()?.graphWidth ?? 1, MAX_LANES) + 1) * LW;

  function render() {
    const r = repo();
    if (!r) return;
    root.style.setProperty('--graph-w', graphPx() + 'px');
    rowsEl.style.height = r.list.length * H + 'px';
    const top = scroll.scrollTop;
    const first = Math.max(0, Math.floor(top / H) - OVERSCAN);
    const last = Math.min(r.list.length, Math.ceil((top + scroll.clientHeight) / H) + OVERSCAN);
    const nodes = [];
    for (let i = first; i < last; i++) nodes.push(rowEl(r, i));
    clear(rowsEl, nodes);
    draw();
    if (last >= r.list.length - 50) r.loadMore();
  }

  function rowEl(r, i) {
    const c = r.list[i];
    const color = laneColor(r.rows[i].col);
    const refs = c.wip ? [] : r.refsBySha.get(c.sha) ?? [];
    const isMatch = search.q && search.matches.includes(i);
    const row = el('div.row' + (c.sha === r.selected ? '.selected' : '') + (c.sha === r.head.sha ? '.head' : '') +
      (search.q && !isMatch ? '.dim' : '') + (c.wip ? '.wip' : ''), {
      style: { top: i * H + 'px', '--lane': color },
      onclick: () => app.select(c.sha),
      ondblclick: () => !c.wip && dblClickCommit(r, c),
      oncontextmenu: (e) => commitMenu(e, app, c),
      ondragover: (e) => drag && refs.some((x) => x.type !== 'tag') && e.preventDefault(),
      ondrop: (e) => {
        const to = refs.find((x) => x.head) ?? refs.find((x) => x.type === 'local') ?? refs.find((x) => x.type === 'remote');
        if (drag && to) dropMenu(e, app, drag, to);
      },
    },
    el('div.c-refs', {}, pills(r, refs)),
    el('div.c-graph'),
    c.wip
      ? el('div.c-msg', {}, el('span.wip-label', {}, '// WIP'), ` ${r.status.files.length} changed file${r.status.files.length === 1 ? '' : 's'}`,
          r.state && el('span.state-tag', {}, r.state.toUpperCase() + ' IN PROGRESS'))
      : el('div.c-msg', { title: c.subject }, c.subject),
    el('div.c-author', { title: c.email }, c.wip ? '' : c.author),
    el('div.c-date', { title: c.wip ? '' : new Date(c.time * 1000).toLocaleString() }, c.wip ? '' : relTime(c.time)),
    el('div.c-sha', {}, c.wip ? '' : shortSha(c.sha)));
    return row;
  }

  function dblClickCommit(r, c) {
    const local = (r.refsBySha.get(c.sha) ?? []).find((x) => x.type === 'local' && !x.head);
    if (local) checkout(r, local.short);
    else if (c.sha !== r.head.sha) checkout(r, c.sha);
  }

  /** Local + matching remote at the same commit collapse into one pill, like GitKraken. */
  function pills(r, refs) {
    const out = [];
    const used = new Set();
    const sorted = [...refs].sort((a, b) => (b.head - a.head) || order(a) - order(b));
    for (const ref of sorted) {
      if (used.has(ref.name)) continue;
      used.add(ref.name);
      let remotes = [];
      if (ref.type === 'local') {
        remotes = refs.filter((x) => x.type === 'remote' && x.short.slice(x.remote.length + 1) === ref.short);
        remotes.forEach((x) => used.add(x.name));
      }
      out.push(pill(r, ref, remotes));
    }
    if (out.length > 1) {
      const more = out.slice(1);
      return [out[0], el('span.pill.more', { title: more.map((p) => p.dataset.name).join('\n') }, `+${more.length}`)];
    }
    return out;
  }

  const order = (x) => ({ local: 0, remote: 1, tag: 2 })[x.type];

  function pill(r, ref, remotes) {
    const icon = ref.type === 'tag' ? '◆ ' : ref.head ? '✓ ' : '';
    return el('span.pill.' + ref.type + (ref.head ? '.current' : ''), {
      draggable: ref.type !== 'tag',
      dataset: { name: ref.short },
      title: `${ref.short}${remotes.length ? '\n' + remotes.map((x) => x.short).join('\n') : ''}\nDrag onto another branch to merge or rebase`,
      ondblclick: (e) => {
        e.stopPropagation();
        if (!ref.head) checkoutRef(r, ref);
      },
      oncontextmenu: (e) => refMenu(e, app, ref),
      ondragstart: (e) => {
        drag = ref;
        e.dataTransfer.setData('text/plain', ref.short);
        e.dataTransfer.effectAllowed = 'move';
      },
      ondragend: () => (drag = null),
      ondragover: (e) => drag && ref.type !== 'tag' && e.preventDefault(),
      ondrop: (e) => {
        e.stopPropagation();
        if (drag) dropMenu(e, app, drag, ref);
        drag = null;
      },
    }, icon + ref.short, remotes.length > 0 && el('span.cloud', { title: remotes.map((x) => x.short).join(', ') }, '☁'));
  }

  // ---------- canvas ----------

  function draw() {
    const r = repo();
    const dpr = devicePixelRatio || 1;
    const w = graphPx();
    const h = scroll.clientHeight;
    canvas.style.left = REFS_W + 'px';
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!r) return;
    const top = scroll.scrollTop;
    const first = Math.max(0, Math.floor(top / H));
    const last = Math.min(r.list.length, Math.ceil((top + h) / H) + 1);
    const x = (j) => LW / 2 + 4 + Math.min(j, MAX_LANES) * LW;
    ctx.lineWidth = 2;
    for (let i = first; i < last; i++) {
      const row = r.rows[i];
      const y0 = i * H - top;
      const mid = y0 + H / 2;
      const y1 = y0 + H;
      for (const j of row.pass) line(ctx, x(j), y0, x(j), y1, laneColor(j));
      if (row.topIn) line(ctx, x(row.col), y0, x(row.col), mid, laneColor(row.col), r.list[i - 1]?.wip);
      for (const j of row.ins) curve(ctx, x(j), y0, x(row.col), mid, laneColor(j));
      row.outs.forEach((j, k) => curve(ctx, x(row.col), mid, x(j), y1, laneColor(k === 0 ? row.col : j), r.list[i].wip));
      for (const [a, b] of row.moves) curve(ctx, x(a), y0, x(b), y1, laneColor(a));
    }
    for (let i = first; i < last; i++) node(ctx, r, i, x(r.rows[i].col), i * H - top + H / 2);
  }

  function line(ctx, x1, y1, x2, y2, color, dashed = false) {
    ctx.strokeStyle = color;
    ctx.setLineDash(dashed ? [3, 3] : []);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function curve(ctx, x1, y1, x2, y2, color, dashed = false) {
    if (x1 === x2) return line(ctx, x1, y1, x2, y2, color, dashed);
    ctx.strokeStyle = color;
    ctx.setLineDash(dashed ? [3, 3] : []);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    const ym = (y1 + y2) / 2;
    ctx.bezierCurveTo(x1, ym, x2, ym, x2, y2);
    ctx.stroke();
  }

  function node(ctx, r, i, cx, cy) {
    const c = r.list[i];
    const color = laneColor(r.rows[i].col);
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim() || '#1a1b26';
    ctx.setLineDash(c.wip ? [2, 2] : []);
    if (c.wip) {
      ctx.fillStyle = bg;
      ctx.strokeStyle = color;
      circle(ctx, cx, cy, 8, true, true);
      return;
    }
    if (c.parents.length > 1) {
      ctx.fillStyle = color;
      circle(ctx, cx, cy, 4.5, true, false);
      return;
    }
    ctx.fillStyle = color;
    circle(ctx, cx, cy, 8.5, true, false);
    if (c.sha === r.selected || c.sha === r.head.sha) {
      ctx.strokeStyle = c.sha === r.selected ? '#ffffff' : color;
      ctx.lineWidth = 2;
      circle(ctx, cx, cy, 11, false, true);
    }
    ctx.fillStyle = bg;
    ctx.font = '600 9px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials(c.author), cx, cy + 0.5);
  }

  function circle(ctx, cx, cy, rad, fill, stroke) {
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    if (fill) ctx.fill();
    if (stroke) ctx.stroke();
  }

  const initials = (name = '') =>
    name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';

  // ---------- navigation & search ----------

  function scrollTo(sha, center = true) {
    const r = repo();
    const i = r?.rowOf(sha) ?? -1;
    if (i < 0) return false;
    const top = i * H;
    if (center) scroll.scrollTop = top - scroll.clientHeight / 2 + H / 2;
    else if (top < scroll.scrollTop) scroll.scrollTop = top;
    else if (top + H > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = top + H - scroll.clientHeight;
    render();
    return true;
  }

  function move(delta) {
    const r = repo();
    if (!r?.list.length) return;
    const i = Math.max(0, Math.min(r.list.length - 1, r.rowOf(r.selected) + delta));
    app.select(r.list[i].sha);
    scrollTo(r.list[i].sha, false);
  }

  function setSearch(q) {
    const r = repo();
    q = q.trim().toLowerCase();
    search = { q, matches: [], at: -1 };
    if (q && r) {
      r.list.forEach((c, i) => {
        if (!c.wip && (c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.sha.startsWith(q)))
          search.matches.push(i);
      });
    }
    render();
    return search.matches.length;
  }

  function nextMatch(dir = 1) {
    if (!search.matches.length) return null;
    search.at = (search.at + dir + search.matches.length) % search.matches.length;
    const c = repo().list[search.matches[search.at]];
    app.select(c.sha);
    scrollTo(c.sha);
    return { at: search.at + 1, total: search.matches.length };
  }

  scroll.addEventListener('scroll', () => requestAnimationFrame(render));
  scroll.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'j') move(1);
    else if (e.key === 'ArrowUp' || e.key === 'k') move(-1);
    else if (e.key === 'PageDown') move(Math.floor(scroll.clientHeight / H));
    else if (e.key === 'PageUp') move(-Math.floor(scroll.clientHeight / H));
    else if (e.key === 'Home') move(-Infinity);
    else if (e.key === 'End') move(Infinity);
    else return;
    e.preventDefault();
  });
  new ResizeObserver(() => render()).observe(scroll);

  return {
    el: root,
    render,
    scrollTo,
    setSearch,
    nextMatch,
    focus: () => scroll.focus(),
    resetScroll: () => (scroll.scrollTop = 0),
  };
}
