// Right panel: staging area + commit box for WIP, or details + changed files for a commit/stash.
import { el, clear, copy, menu, toastError } from './ui.js';
import { relTime, shortSha } from './parse.js';
import * as A from './actions.js';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const STATUS_NAME = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', U: 'conflict', '?': 'untracked' };

export function createPanel(app) {
  const root = el('aside.panel');
  let token = 0; // drops stale async renders
  let shownKey = null; // commit details already on screen

  function render() {
    const r = app.repo;
    const key = r && `${r.id}:${r.selectedStash?.sha ?? r.selected}:${app.openFile?.path ?? ''}`;
    if (key === shownKey && r?.selected !== 'WIP') return;
    token++;
    shownKey = null;
    if (!r) return clear(root);
    if (r.selectedStash) return details(r, r.selectedStash.sha, `${r.selectedStash.sha}^1`, r.selectedStash.ref, key);
    if (r.selected === 'WIP' && r.hasWip) return staging(r);
    if (r.selected) return details(r, r.selected, null, null, key);
    clear(root);
  }

  // ---------- staging ----------

  function fileRow(r, f, area) {
    const paths = f.orig ? [f.path, f.orig] : [f.path];
    const letter = f.untracked ? '?' : f.conflict ? 'U' : area === 'staged' ? f.x : f.y;
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
    const name = f.path.slice(dir.length);
    const isOpen = app.openFile?.path === f.path && app.openFile?.area === area;
    return el('div.file' + (isOpen ? '.open' : ''), {
      title: `${f.path}${f.orig ? ` (from ${f.orig})` : ''} — ${STATUS_NAME[letter] ?? letter}`,
      onclick: () => (area === 'conflict' ? app.openConflict(f.path) : app.openWipDiff(f, area)),
      oncontextmenu: (e) => menu(e, [
        area === 'unstaged' && { label: 'Stage', run: () => A.stage(r, paths) },
        area === 'staged' && { label: 'Unstage', run: () => A.unstage(r, paths) },
        area === 'conflict' && { label: 'Resolve…', run: () => app.openConflict(f.path) },
        area === 'conflict' && { label: 'Mark resolved', run: () => A.stage(r, paths) },
        area !== 'staged' && { label: 'Discard changes…', danger: true, run: () => A.discard(r, [f]) },
        '-',
        !f.untracked && { label: 'File history', run: () => app.openHistory(f.path) },
        !f.untracked && { label: 'Blame', run: () => app.openBlame(f.path) },
        { label: 'Copy path', run: () => copy(f.path) },
      ]),
    },
    el('span.st.st-' + (letter === '?' ? 'A' : letter), {}, letter === '?' ? '+' : letter),
    el('span.fname', {}, el('span.fdir', {}, dir), name),
    el('span.file-btns', {},
      area !== 'staged' && el('button.fbtn.danger', { title: 'Discard', onclick: (e) => (e.stopPropagation(), A.discard(r, [f])) }, '↺'),
      area === 'unstaged' && el('button.fbtn', { title: 'Stage', onclick: (e) => (e.stopPropagation(), A.stage(r, paths)) }, '+'),
      area === 'conflict' && el('button.fbtn', { title: 'Mark resolved', onclick: (e) => (e.stopPropagation(), A.stage(r, paths)) }, '✓'),
      area === 'staged' && el('button.fbtn', { title: 'Unstage', onclick: (e) => (e.stopPropagation(), A.unstage(r, paths)) }, '−')));
  }

  // The commit box is built once per repo and kept while WIP is shown, so live refreshes (an agent
  // editing files) never steal focus or the cursor from the message being typed.
  let wip = null;

  function staging(r) {
    if (wip?.repo !== r) wip = buildStaging(r);
    if (!root.contains(wip.box)) clear(root, wip.head, wip.files, wip.box);
    wip.update();
  }

  function buildStaging(r) {
    r.draft ??= { summary: '', body: '', amend: false };
    const summary = el('input.summary', {
      placeholder: 'Summary', value: r.draft.summary, spellcheck: true,
      oninput: () => {
        r.draft.summary = summary.value;
        updateCounter();
      },
    });
    const counter = el('span.counter');
    const updateCounter = () => {
      counter.textContent = String(72 - summary.value.length);
      counter.classList.toggle('over', summary.value.length > 72);
    };
    const body = el('textarea.body', { placeholder: 'Description', rows: 5, value: r.draft.body, oninput: () => (r.draft.body = body.value) });
    const amend = el('input', {
      type: 'checkbox', checked: r.draft.amend,
      onchange: async () => {
        r.draft.amend = amend.checked;
        if (amend.checked && !summary.value && r.head.sha) {
          const msg = await r.git(['log', '-1', '--format=%B']);
          const [first, ...rest] = msg.trim().split('\n');
          summary.value = r.draft.summary = first;
          body.value = r.draft.body = rest.join('\n').trim();
          updateCounter();
        }
        update();
      },
    });
    const commitBtn = el('button.btn.primary.wide', { onclick: () => doCommit(false), title: 'Ctrl+Enter' });
    const allBtn = el('button.btn.wide', { onclick: () => doCommit(true), title: 'Ctrl+Shift+Enter' }, 'Stage all & commit');
    const doCommit = async (all = false) => {
      if (all && !(await A.stageAll(r))) return;
      const msg = summary.value.trim() + (body.value.trim() ? '\n\n' + body.value.trim() : '');
      if (await A.commit(r, msg, amend.checked)) {
        summary.value = body.value = '';
        amend.checked = false;
        r.draft = { summary: '', body: '', amend: false };
        updateCounter();
      }
    };
    const box = el('div.commit-box', {
      onkeydown: (e) => {
        if (e.key === 'Enter' && e.ctrlKey) {
          e.preventDefault();
          doCommit(e.shiftKey);
        }
      },
    }, el('div.summary-row', {}, summary, counter), body, el('label.check', {}, amend, 'Amend previous commit'), commitBtn, allBtn);
    const head = el('div.panel-head', {}, el('h3', {}, 'Working directory'),
      el('button.btn.small.danger', { onclick: () => A.discardAll(r), title: 'Discard all changes' }, 'Discard all'));
    const files = el('div.wip-files');
    updateCounter();

    function update() {
      const s = r.status;
      commitBtn.textContent = amend.checked ? 'Amend previous commit' : `Commit ${s.staged.length} file${s.staged.length === 1 ? '' : 's'}`;
      allBtn.hidden = s.unstaged.length === 0;
      clear(files,
        s.conflicts.length > 0 && el('div.files-section', {},
          el('div.files-title.conflict', {}, `Conflicts (${s.conflicts.length})`),
          s.conflicts.map((f) => fileRow(r, f, 'conflict'))),
        el('div.files-section.grow', {},
          el('div.files-title', {}, `Unstaged (${s.unstaged.length})`,
            s.unstaged.length > 0 && el('button.btn.small', { onclick: () => A.stageAll(r) }, 'Stage all')),
          el('div.files', {}, s.unstaged.map((f) => fileRow(r, f, 'unstaged')))),
        el('div.files-section.grow', {},
          el('div.files-title', {}, `Staged (${s.staged.length})`,
            s.staged.length > 0 && el('button.btn.small', { onclick: () => A.unstageAll(r) }, 'Unstage all')),
          el('div.files', {}, s.staged.map((f) => fileRow(r, f, 'staged')))));
    }
    return { repo: r, head, files, box, update, focus: () => summary.focus() };
  }

  // ---------- commit details ----------

  async function details(r, sha, baseOverride = null, label = null, key = null) {
    const my = token;
    shownKey = key;
    clear(root, el('div.loading', {}, 'Loading…'));
    try {
      const [meta, parentsRaw] = await Promise.all([
        r.git(['show', '-s', '--format=%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%B', sha]),
        r.git(['rev-list', '--parents', '-n1', sha]),
      ]);
      const parents = parentsRaw.trim().split(' ').slice(1);
      const base = baseOverride ?? parents[0] ?? EMPTY_TREE;
      const files = parseNameStatus(await r.git(['diff-tree', '-r', '-M', '-z', '--name-status', '--no-commit-id', base, sha]));
      if (my !== token) return;
      const [an, ae, at, cn, , message] = meta.split('\x1f');
      const [subject, ...rest] = message.trim().split('\n');
      clear(root,
        el('div.panel-head', {}, el('h3', {}, label ?? 'Commit'),
          el('button.sha-btn', { title: 'Copy SHA', onclick: () => copy(sha) }, shortSha(sha))),
        el('div.commit-subject', {}, subject),
        rest.join('\n').trim() && el('pre.commit-body', {}, rest.join('\n').trim()),
        el('div.meta', {},
          el('div', {}, el('b', {}, an), el('span.muted', {}, ` <${ae}>`)),
          el('div.muted', { title: new Date(at * 1000).toLocaleString() }, `authored ${relTime(Number(at))} · ${new Date(at * 1000).toLocaleString()}`),
          cn !== an && el('div.muted', {}, `committed by ${cn}`),
          parents.length > 0 && el('div.parents', {}, parents.length > 1 ? 'parents ' : 'parent ',
            parents.map((p) => el('button.link', { onclick: () => app.select(p, true) }, shortSha(p))))),
        el('div.files-section.grow', {},
          el('div.files-title', {}, `${files.length} file${files.length === 1 ? '' : 's'} changed${parents.length > 1 && !baseOverride ? ' (vs first parent)' : ''}`),
          el('div.files', {}, files.map((f) => {
            const isOpen = app.openFile?.path === f.path && app.openFile?.sha === sha;
            return el('div.file' + (isOpen ? '.open' : ''), {
              title: f.orig ? `${f.orig} → ${f.path}` : f.path,
              onclick: () => app.openCommitDiff(sha, base, f),
              oncontextmenu: (e) => menu(e, [
                { label: 'File history', run: () => app.openHistory(f.path) },
                f.status !== 'D' && { label: 'Blame at this commit', run: () => app.openBlame(f.path, sha) },
                { label: 'Copy path', run: () => copy(f.path) },
              ]),
            }, el('span.st.st-' + f.status, {}, f.status), el('span.fname', {}, f.path));
          }))));
    } catch (e) {
      shownKey = null;
      if (my === token) clear(root, el('div.loading', {}, 'Could not load commit'));
      toastError(e, 'Load commit');
    }
  }

  return { el: root, render, focusMessage: () => wip?.focus() };
}

/** `diff-tree -z --name-status` → [{ status, path, orig }] */
export function parseNameStatus(text) {
  const t = text.split('\0');
  const out = [];
  for (let i = 0; i < t.length - 1; ) {
    const code = t[i++];
    if (!code) continue;
    const status = code[0];
    if (status === 'R' || status === 'C') out.push({ status, orig: t[i++], path: t[i++] });
    else out.push({ status, path: t[i++] });
  }
  return out;
}
