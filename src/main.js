import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { el, clear, toast, toastError, form, menu } from './ui.js';
import { Repo } from './repo.js';
import { createGraphView } from './graphview.js';
import { createSidebar } from './sidebar.js';
import { createPanel, EMPTY_TREE } from './panel.js';
import { createDiffView } from './diffview.js';
import { createBlameView, createHistoryView, createConflictView } from './views.js';
import { openPalette } from './palette.js';
import { startUpdater } from './updater.js';
import * as A from './actions.js';
import 'highlight.js/styles/tokyo-night-dark.css';

const $ = (id) => document.getElementById(id);
const win = getCurrentWindow();

const app = {
  repos: [],
  repo: null,
  views: [],
  openFile: null,

  select(sha, scroll = false) {
    const r = app.repo;
    if (!r) return;
    r.selected = sha;
    r.selectedStash = null;
    closeViews();
    if (scroll && !graph.scrollTo(sha)) toast('That commit is not in the loaded graph (hidden or too old)', { kind: 'error' });
    graph.render();
    panel.render();
  },

  selectStash(s) {
    app.repo.selected = null;
    app.repo.selectedStash = s;
    closeViews();
    graph.render();
    panel.render();
  },

  toggleHidden(ref) {
    const r = app.repo;
    r.hidden.has(ref.name) ? r.hidden.delete(ref.name) : r.hidden.add(ref.name);
    r.savePrefs();
    r.refresh('refs');
  },

  toggleSolo(ref) {
    const r = app.repo;
    r.solo = r.solo === ref.name ? null : ref.name;
    r.savePrefs();
    r.refresh('refs');
  },

  openRepo,

  openWipDiff(f, area) {
    const r = app.repo;
    const kind = f.untracked ? 'untracked' : area;
    const args = {
      unstaged: ['diff', '--no-ext-diff', '--', f.path],
      staged: ['diff', '--cached', '-M', '--no-ext-diff', '--', ...(f.orig ? [f.orig] : []), f.path],
      untracked: ['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', f.path],
    }[kind];
    app.openFile = { path: f.path, area };
    pushView(diffView(r, f.path, kind, () => r.git(args, { ok: [0, 1] }), `${f.path} · ${kind}`));
  },

  openCommitDiff(sha, base, f) {
    const r = app.repo;
    app.openFile = { path: f.path, sha };
    const paths = f.orig ? [f.orig, f.path] : [f.path];
    pushView(diffView(r, f.path, 'commit', () => r.git(['diff', '-M', '--no-ext-diff', base, sha, '--', ...paths]),
      `${f.path} · ${sha.slice(0, 7)}`));
  },

  openHistory(path) {
    const r = app.repo;
    pushView(createHistoryView({
      repo: r, path, onClose: popView,
      onSelectCommit: (sha) => app.select(sha, true),
      onOpenDiff: (c) => pushView(diffView(r, c.filePath, 'commit',
        () => r.git(['diff', '-M', '--no-ext-diff', c.parents[0] ?? EMPTY_TREE, c.sha, '--', ...(c.oldPath ? [c.oldPath] : []), c.filePath]),
        `${c.filePath} · ${c.sha.slice(0, 7)} ${c.subject}`)),
    }));
  },

  openBlame(path, rev = null) {
    pushView(createBlameView({ repo: app.repo, path, rev, onClose: popView, onSelectCommit: (sha) => app.select(sha, true) }));
  },

  openConflict(path) {
    pushView(createConflictView({ repo: app.repo, path, onClose: popView }));
  },
};

const graph = createGraphView(app);
const sidebar = createSidebar(app);
const panel = createPanel(app);

function diffView(repo, path, kind, load, title) {
  return createDiffView({ repo, path, kind, load, title, onClose: popView, onHistory: app.openHistory, onBlame: (p) => app.openBlame(p) });
}

// ---------- center view stack (graph is always underneath) ----------

function pushView(v) {
  app.views.push(v);
  showTopView();
  panel.render();
}

function popView() {
  app.views.pop();
  if (!app.views.length) app.openFile = null;
  showTopView();
  panel.render();
  if (!app.views.length) graph.focus();
}

function closeViews() {
  if (!app.views.length) return;
  app.views = [];
  app.openFile = null;
  showTopView();
}

function showTopView() {
  const top = app.views[app.views.length - 1];
  $('center').classList.toggle('has-view', !!top);
  clear($('views'), top?.el);
  top?.focus?.();
}

// ---------- tabs ----------

async function openRepo(path, { activate = true, persist = true } = {}) {
  if (!path) return;
  const norm = (p) => p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  let repo;
  try {
    repo = await Repo.open(path);
  } catch (e) {
    return toastError(e, 'Open repository');
  }
  const existing = app.repos.find((r) => norm(r.root) === norm(repo.root));
  if (existing) return activate && activateRepo(existing);
  app.repos.push(repo);
  repo.onChange((kind) => onRepoChanged(repo, kind));
  repo.watch().catch((e) => toastError(e, 'Live updates unavailable'));
  if (activate) activateRepo(repo);
  renderTabs();
  if (persist) saveTabs();
  await repo.refresh('refs').catch((e) => toastError(e, `Load ${repo.name}`));
}

function activateRepo(repo) {
  app.repo = repo;
  app.views = [];
  app.openFile = null;
  showTopView();
  graph.resetScroll();
  renderAll();
  saveTabs();
  if (repo.selected && repo.selected !== 'WIP') graph.scrollTo(repo.selected, true);
}

function closeRepo(repo) {
  repo.unwatch();
  app.repos = app.repos.filter((r) => r !== repo);
  if (app.repo === repo) {
    app.repo = null;
    if (app.repos.length) activateRepo(app.repos[app.repos.length - 1]);
    else renderAll();
  }
  renderTabs();
  saveTabs();
}

function saveTabs() {
  localStorage.setItem('gitma.tabs', JSON.stringify(app.repos.map((r) => r.root)));
  if (app.repo) localStorage.setItem('gitma.active', app.repo.root);
}

function renderTabs() {
  clear($('tabs'), app.repos.map((r) => el('div.tab' + (r === app.repo ? '.active' : ''), {
    title: r.root,
    onmousedown: (e) => e.button === 1 && (e.preventDefault(), closeRepo(r)),
    onclick: () => r !== app.repo && activateRepo(r),
    oncontextmenu: (e) => menu(e, [
      { label: 'Close tab', run: () => closeRepo(r) },
      { label: 'Close other tabs', run: () => app.repos.filter((x) => x !== r).forEach(closeRepo) },
    ]),
  },
  el('span.glyph', {}, '⎇'),
  el('span.title', {}, r.name),
  r.head.branch && el('span.tab-branch', {}, r.head.branch),
  el('button.close', { title: 'Close (Ctrl+W)', onclick: (e) => (e.stopPropagation(), closeRepo(r)) }, '×'))));
}

async function pickRepo() {
  const dir = await openDialog({ directory: true, title: 'Open a Git repository' });
  if (dir) openRepo(dir);
}

// ---------- rendering ----------

function onRepoChanged(repo, kind) {
  renderTabs();
  if (repo !== app.repo) return;
  renderAll();
  const top = app.views[app.views.length - 1];
  if (top?.reload) top.reload();
  if (search.value) setSearch(search.value, false);
}

function renderAll() {
  const r = app.repo;
  document.body.classList.toggle('no-repo', !r);
  renderTabs();
  renderToolbar();
  renderBanner();
  sidebar.render();
  graph.render();
  panel.render();
  document.title = r ? `${r.name}${r.head.branch ? ' · ' + r.head.branch : ''} — GITMA` : 'GITMA';
}

const search = el('input.search', {
  placeholder: 'Search commits (Ctrl+F)', spellcheck: false,
  oninput: () => setSearch(search.value),
  onkeydown: (e) => {
    if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
    if (e.key === 'Escape') {
      search.value = '';
      setSearch('');
      graph.focus();
    }
  },
});
const searchCount = el('span.search-count');

function setSearch(q, jump = true) {
  const n = graph.setSearch(q);
  searchCount.textContent = q.trim() ? `${n} found` : '';
  if (jump && n) step(1);
}

function step(dir) {
  const r = graph.nextMatch(dir);
  if (r) searchCount.textContent = `${r.at} / ${r.total}`;
}

function tbtn(label, icon, title, run, extra = '') {
  return el('button.tbtn' + extra, { title, onclick: run, disabled: !app.repo }, el('span.ticon', {}, icon), el('span', {}, label));
}

function renderToolbar() {
  const r = app.repo;
  const cur = r?.refs.find((x) => x.head);
  const last = r?.undoStack[r.undoStack.length - 1];
  clear($('tb-actions'),
    tbtn('Branches', '☰', 'Show / hide the sidebar (Ctrl+\\)', toggleSidebar, document.body.classList.contains('side-collapsed') ? '' : '.on'),
    el('span.tsep'),
    tbtn('Undo', '↶', last ? `Undo ${last.label} (Ctrl+Z)` : 'Nothing to undo', () => A.undo(r)),
    el('span.tsep'),
    tbtn('Fetch', '⟳', 'Fetch all remotes', () => A.fetchAll(r)),
    tbtn('Pull' + (cur?.behind ? ` ${cur.behind}` : ''), '↓', 'Pull current branch (Ctrl+Shift+L)', () => A.pull(r)),
    tbtn('Push' + (cur?.ahead ? ` ${cur.ahead}` : ''), '↑', 'Push current branch (Ctrl+Shift+K)', () => A.push(r)),
    el('span.tsep'),
    tbtn('Branch', '⎇', 'New branch (Ctrl+B)', () => A.createBranch(r)),
    tbtn('Stash', '⊕', 'Stash changes (Ctrl+Shift+S)', () => A.stash(r)),
    tbtn('Pop', '⊖', 'Pop latest stash', () => r.stashes[0] ? A.stashApply(r, r.stashes[0], true) : toast('No stashes')),
    el('span.spacer'),
    r?.busy > 0 && el('span.busy', {}, el('span.spinner'), 'Working…'));
}

function renderBanner() {
  const r = app.repo;
  const b = $('banner');
  if (!r?.state) return (b.hidden = true);
  b.hidden = false;
  const conflicts = r.status.conflicts.length;
  clear(b,
    el('span', {}, `${r.state[0].toUpperCase() + r.state.slice(1)} in progress`,
      conflicts ? ` · ${conflicts} conflicted file${conflicts > 1 ? 's' : ''} — resolve them in the panel on the right` : ' · no conflicts left'),
    el('span.spacer'),
    el('button.btn.small.primary', { disabled: conflicts > 0, onclick: () => A.sequencer(r, 'continue') }, 'Continue'),
    r.state !== 'merge' && el('button.btn.small', { onclick: () => A.sequencer(r, 'skip') }, 'Skip commit'),
    el('button.btn.small.danger', { onclick: () => A.sequencer(r, 'abort') }, 'Abort'));
}

A.onBusy((repo) => repo === app.repo && renderToolbar());

// ---------- commands & shortcuts ----------

function commands() {
  const r = app.repo;
  const base = [
    { label: 'Open repository…', hint: 'Ctrl+O', run: pickRepo },
    { label: `Set auto-fetch interval (now ${fetchMinutes()} min)`, run: setFetchInterval },
  ];
  if (!r) return base;
  return [
    ...base,
    { label: 'Close tab', hint: 'Ctrl+W', run: () => closeRepo(r) },
    { label: 'Refresh', hint: 'F5', run: () => r.refresh('refs') },
    { label: 'Undo last action', hint: 'Ctrl+Z', run: () => A.undo(r) },
    { label: 'Fetch all', run: () => A.fetchAll(r) },
    { label: 'Pull', hint: 'Ctrl+Shift+L', run: () => A.pull(r) },
    { label: 'Push', hint: 'Ctrl+Shift+K', run: () => A.push(r) },
    { label: 'New branch…', hint: 'Ctrl+B', run: () => A.createBranch(r) },
    { label: 'Stash changes…', hint: 'Ctrl+Shift+S', run: () => A.stash(r) },
    { label: 'Pop latest stash', run: () => r.stashes[0] && A.stashApply(r, r.stashes[0], true) },
    { label: 'Stage all', run: () => A.stageAll(r) },
    { label: 'Unstage all', run: () => A.unstageAll(r) },
    { label: 'Discard all changes…', run: () => A.discardAll(r) },
    { label: 'Go to working directory (WIP)', hint: 'Ctrl+Shift+M', run: focusCommit },
    { label: 'Go to HEAD', run: () => app.select(r.head.sha, true) },
    { label: 'Search commits', hint: 'Ctrl+F', run: () => search.focus() },
    { label: 'Filter branches', run: () => sidebar.focusFilter() },
    { label: 'Toggle sidebar', hint: 'Ctrl+\\', run: toggleSidebar },
    { label: 'Show all branches (clear hidden & solo)', run: () => { r.hidden.clear(); r.solo = null; r.savePrefs(); r.refresh('refs'); } },
    r.state && { label: `Continue ${r.state}`, run: () => A.sequencer(r, 'continue') },
    r.state && { label: `Abort ${r.state}`, run: () => A.sequencer(r, 'abort') },
    ...r.refs.filter((x) => x.type === 'local' && !x.head).map((x) => ({ label: `Checkout ${x.short}`, run: () => A.checkout(r, x.short) })),
    ...r.refs.filter((x) => x.type !== 'tag' && !x.head).map((x) => ({ label: `Merge ${x.short} into ${r.head.branch ?? 'HEAD'}`, run: () => A.merge(r, x.short) })),
    ...app.repos.filter((x) => x !== r).map((x) => ({ label: `Switch to tab ${x.name}`, run: () => activateRepo(x) })),
  ];
}

const showPalette = () => openPalette(commands);

function toggleSidebar() {
  const collapsed = document.body.classList.toggle('side-collapsed');
  localStorage.setItem('gitma.sideCollapsed', collapsed ? '1' : '');
  renderToolbar();
}
document.body.classList.toggle('side-collapsed', !!localStorage.getItem('gitma.sideCollapsed'));

function focusCommit() {
  const r = app.repo;
  if (!r?.hasWip) return toast('No changes to commit');
  app.select('WIP', true);
  panel.focusMessage();
}

addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select');
  const k = e.key.toLowerCase();
  const r = app.repo;
  const ctrl = e.ctrlKey && !e.altKey;
  if (document.querySelector('.modal-back')) return;
  if (ctrl && k === 'p') showPalette();
  else if (ctrl && !e.shiftKey && k === 'o') pickRepo();
  else if (ctrl && k === 'tab' && app.repos.length > 1) {
    const i = app.repos.indexOf(r);
    activateRepo(app.repos[(i + (e.shiftKey ? -1 : 1) + app.repos.length) % app.repos.length]);
  } else if (!r) return;
  else if (ctrl && !e.shiftKey && k === 'w') closeRepo(r);
  else if (ctrl && k === '\\') toggleSidebar();
  else if (ctrl && !e.shiftKey && k === 'f') (search.focus(), search.select());
  else if (k === 'f5' || (ctrl && !e.shiftKey && k === 'r')) r.refresh('refs');
  else if (ctrl && !e.shiftKey && k === 'z' && !typing) A.undo(r);
  else if (ctrl && !e.shiftKey && k === 'b') A.createBranch(r);
  else if (ctrl && e.shiftKey && k === 'l') A.pull(r);
  else if (ctrl && e.shiftKey && k === 'k') A.push(r);
  else if (ctrl && e.shiftKey && k === 's') A.stash(r);
  else if (ctrl && e.shiftKey && k === 'm') focusCommit();
  else if (k === 'escape' && app.views.length && !typing) popView();
  else return;
  e.preventDefault();
});

// ---------- auto-fetch ----------

const fetchMinutes = () => Number(localStorage.getItem('gitma.fetchMinutes') ?? 5);
let fetchTimer = null;

function scheduleFetch() {
  clearInterval(fetchTimer);
  const m = fetchMinutes();
  if (m > 0) fetchTimer = setInterval(() => {
    // Quiet: offline or auth failures shouldn't spam toasts; a manual Fetch shows errors.
    for (const r of app.repos) if (r.remotes.length && !r.busy) r.git(['fetch', '--all', '--prune', '--quiet']).catch(() => {});
  }, m * 60000);
}

async function setFetchInterval() {
  const v = await form('Auto-fetch', [{ name: 'm', label: 'Minutes between background fetches (0 = off)', value: String(fetchMinutes()) }]);
  const m = Number(v?.m);
  if (v && Number.isFinite(m) && m >= 0) {
    localStorage.setItem('gitma.fetchMinutes', String(m));
    scheduleFetch();
    toast(m ? `Auto-fetch every ${m} min` : 'Auto-fetch off');
  }
}

// ---------- boot ----------

$('toolbar').append(el('div#tb-actions'), el('div.search-box', {}, search, searchCount),
  el('button.tbtn', { title: 'Command palette (Ctrl+P)', onclick: showPalette }, el('span.ticon', {}, '⌘'), el('span', {}, 'Commands')));
$('sidebar-host').replaceWith(sidebar.el);
$('center').prepend(graph.el);
$('panel-host').replaceWith(panel.el);
$('open-repo').addEventListener('click', pickRepo);
$('empty-open').addEventListener('click', pickRepo);
$('win-min').addEventListener('click', () => win.minimize());
$('win-max').addEventListener('click', () => win.toggleMaximize());
$('win-close').addEventListener('click', () => win.close());
$('titlebar').addEventListener('dblclick', (e) => e.target.closest('[data-tauri-drag-region]') === e.currentTarget && win.toggleMaximize());
startUpdater($('update'));
scheduleFetch();
renderAll();

listen('repo-changed', ({ payload }) => app.repos.find((r) => r.id === payload.id)?.refresh(payload.kind));
listen('open-repo', ({ payload }) => openRepo(payload));

(async () => {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem('gitma.tabs') ?? '[]');
  } catch {}
  const active = localStorage.getItem('gitma.active');
  const initial = await invoke('initial_path');
  for (const p of saved) await openRepo(p, { activate: p === active && !initial, persist: false });
  if (initial) await openRepo(initial);
  if (!app.repo && app.repos.length) activateRepo(app.repos[0]);
  saveTabs();
})();
