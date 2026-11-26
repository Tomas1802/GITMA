// Diff viewer: inline or split, syntax highlighted, with hunk and line staging for WIP diffs.
import hljs from 'highlight.js/lib/common';
import { el, clear, toastError } from './ui.js';
import { parseDiff } from './parse.js';
import { buildPatch } from './patch.js';
import * as A from './actions.js';

const MAX_LINES = 20000;
const MAX_HIGHLIGHT = 6000;
const EXTRA_LANGS = { razor: 'xml', cshtml: 'xml', vue: 'xml', svelte: 'xml', csproj: 'xml', props: 'xml', targets: 'xml', xaml: 'xml', yml: 'yaml', h: 'cpp', hpp: 'cpp', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', tsx: 'typescript', ps1: 'powershell', psm1: 'powershell' };

export const getMode = () => localStorage.getItem('gitma.diffMode') ?? 'inline';

/**
 * spec: { repo, path, kind: 'commit'|'unstaged'|'staged'|'untracked', title, load: () => Promise<string>, onClose }
 */
export function createDiffView(spec) {
  const { repo, kind } = spec;
  const body = el('div.diff-body');
  const toolbar = el('div.view-bar');
  const root = el('div.view.diff-view', { tabIndex: -1 }, toolbar, body);
  let file = null;
  let lastText = null;
  let selection = new Map(); // hunk index → Set of line indexes
  let mode = getMode();

  const language = () => {
    const ext = spec.path.split('.').pop().toLowerCase();
    const name = EXTRA_LANGS[ext] ?? ext;
    return hljs.getLanguage(name) ? name : null;
  };

  async function load() {
    try {
      const text = await spec.load();
      if (text === lastText) return;
      lastText = text;
      [file] = parseDiff(text);
      selection = new Map();
      render();
    } catch (e) {
      clear(body, el('div.empty', {}, 'Could not load diff'));
      toastError(e, 'Diff');
    }
  }

  function bar() {
    const wip = kind !== 'commit';
    clear(toolbar,
      el('button.btn.small', { onclick: spec.onClose, title: 'Back (Esc)' }, '← Back'),
      el('span.view-title', { title: spec.path }, spec.title ?? spec.path),
      el('span.spacer'),
      el('div.seg', {},
        el('button' + (mode === 'inline' ? '.on' : ''), { onclick: () => setMode('inline') }, 'Inline'),
        el('button' + (mode === 'split' ? '.on' : ''), { onclick: () => setMode('split') }, 'Split')),
      wip && (kind === 'unstaged' || kind === 'untracked') && el('button.btn.small', { onclick: () => A.stage(repo, [spec.path]) }, 'Stage file'),
      wip && kind === 'staged' && el('button.btn.small', { onclick: () => A.unstage(repo, [spec.path]) }, 'Unstage file'),
      wip && kind !== 'staged' && el('button.btn.small.danger', { onclick: () => A.discard(repo, [{ path: spec.path, untracked: kind === 'untracked' }]) }, 'Discard file'),
      el('button.btn.small', { onclick: () => spec.onHistory?.(spec.path) }, 'History'),
      kind !== 'untracked' && el('button.btn.small', { onclick: () => spec.onBlame?.(spec.path) }, 'Blame'));
  }

  function setMode(m) {
    mode = m;
    localStorage.setItem('gitma.diffMode', m);
    render();
  }

  function render() {
    bar();
    if (!file) return clear(body, el('div.empty', {}, 'No changes'));
    if (file.binary) return clear(body, el('div.empty', {}, 'Binary file changed'));
    if (!file.hunks.length) return clear(body, el('div.empty', {}, file.header.find((h) => /mode|rename|similarity/.test(h)) ?? 'No content changes'));
    const total = file.hunks.reduce((n, h) => n + h.lines.length, 0);
    const lang = total <= MAX_HIGHLIGHT ? language() : null;
    let budget = MAX_LINES;
    const hunks = [];
    for (const [hi, h] of file.hunks.entries()) {
      if (budget <= 0) break;
      hunks.push(hunkEl(h, hi, lang, budget));
      budget -= h.lines.length;
    }
    clear(body, hunks, budget <= 0 && el('div.empty', {}, `Diff truncated at ${MAX_LINES} lines`));
  }

  function hunkEl(h, hi, lang, budget) {
    const sel = selection.get(hi) ?? new Set();
    const lines = h.lines.slice(0, budget);
    const n = sel.size;
    const canStage = kind === 'unstaged' || kind === 'staged';
    const btns = canStage && [
      kind === 'unstaged' && el('button.btn.tiny', { onclick: () => apply(hi, null, false, false) }, 'Stage hunk'),
      kind === 'unstaged' && n > 0 && el('button.btn.tiny.primary', { onclick: () => apply(hi, sel, false, false) }, `Stage ${n} line${n > 1 ? 's' : ''}`),
      kind === 'staged' && el('button.btn.tiny', { onclick: () => apply(hi, null, true, false) }, 'Unstage hunk'),
      kind === 'staged' && n > 0 && el('button.btn.tiny.primary', { onclick: () => apply(hi, sel, true, false) }, `Unstage ${n} line${n > 1 ? 's' : ''}`),
      kind === 'unstaged' && el('button.btn.tiny.danger', { onclick: () => apply(hi, n ? sel : null, true, true) }, n ? `Discard ${n} line${n > 1 ? 's' : ''}` : 'Discard hunk'),
    ];
    return el('div.hunk', {},
      el('div.hunk-head', {}, el('span', {}, h.header), el('span.spacer'), btns),
      mode === 'split' ? splitRows(h, lines, hi, sel, lang) : lines.map((l, li) => inlineRow(l, li, hi, sel, lang)));
  }

  const code = (text, lang) => {
    const c = el('span.code');
    if (lang) c.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; // hljs escapes its input
    else c.textContent = text;
    return c;
  };

  const lineCls = (t) => (t === '+' ? '.add' : t === '-' ? '.del' : t === '\\' ? '.meta' : '');

  function inlineRow(l, li, hi, sel, lang) {
    const selectable = kind !== 'commit' && kind !== 'untracked' && (l.t === '+' || l.t === '-');
    return el('div.dl' + lineCls(l.t) + (sel.has(li) ? '.sel' : '') + (selectable ? '.pick' : ''), {
      onmousedown: selectable ? (e) => toggle(e, hi, li) : null,
    },
    el('span.ln', {}, l.old ?? ''), el('span.ln', {}, l.new ?? ''),
    el('span.sign', {}, l.t === '\\' ? '' : l.t), l.t === '\\' ? el('span.code', {}, l.raw) : code(l.text, lang));
  }

  function splitRows(h, lines, hi, sel, lang) {
    const rows = [];
    const side = (l, li) => {
      if (!l) return el('div.side.empty');
      const selectable = kind !== 'commit' && kind !== 'untracked' && l.t !== ' ';
      return el('div.side' + lineCls(l.t) + (sel.has(li) ? '.sel' : '') + (selectable ? '.pick' : ''), {
        onmousedown: selectable ? (e) => toggle(e, hi, li) : null,
      }, el('span.ln', {}, (l.t === '+' ? l.new : l.old) ?? ''), code(l.text, lang));
    };
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (l.t === ' ') {
        rows.push(el('div.srow', {}, side(l, i), side({ ...l, t: ' ', old: l.new }, i)));
        i++;
      } else if (l.t === '\\') {
        i++;
      } else {
        const dels = [];
        const adds = [];
        while (i < lines.length && lines[i].t === '-') dels.push(i++);
        while (i < lines.length && (lines[i].t === '+' || lines[i].t === '\\')) lines[i].t === '+' ? adds.push(i++) : i++;
        for (let k = 0; k < Math.max(dels.length, adds.length); k++)
          rows.push(el('div.srow', {}, side(lines[dels[k]], dels[k]), side(lines[adds[k]], adds[k])));
      }
    }
    return rows;
  }

  let anchor = null;
  function toggle(e, hi, li) {
    e.preventDefault();
    const sel = selection.get(hi) ?? new Set();
    const lines = file.hunks[hi].lines;
    if (e.shiftKey && anchor?.hi === hi) {
      const [a, b] = [Math.min(anchor.li, li), Math.max(anchor.li, li)];
      for (let k = a; k <= b; k++) if (lines[k].t === '+' || lines[k].t === '-') sel.add(k);
    } else sel.has(li) ? sel.delete(li) : sel.add(li);
    anchor = { hi, li };
    selection.set(hi, sel);
    const scroll = body.scrollTop;
    render();
    body.scrollTop = scroll;
  }

  async function apply(hi, sel, reverse, worktree) {
    const patch = buildPatch(file, file.hunks[hi], sel, reverse);
    if (!patch) return;
    const scroll = body.scrollTop;
    if (await A.applyPatch(repo, patch, { reverse, worktree })) {
      lastText = null;
      await load();
      body.scrollTop = scroll;
    }
  }

  load();
  return {
    el: root,
    reload: kind === 'commit' ? null : load,
    focus: () => root.focus(),
  };
}
