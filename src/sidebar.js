// Left panel: local / remote branches, tags, stashes, worktrees — with hide, solo, ahead/behind.
import { el, clear, menu } from './ui.js';
import { refMenu } from './menus.js';
import * as A from './actions.js';

export function createSidebar(app) {
  const filter = el('input.side-filter', { placeholder: 'Filter branches…', spellcheck: false, oninput: () => render() });
  const list = el('div.side-list');
  const root = el('aside.sidebar', {}, filter, list);
  const collapsed = new Set(JSON.parse(localStorage.getItem('gitma.collapsed') ?? '[]'));

  function section(key, title, count, items, actions) {
    const open = !collapsed.has(key);
    return el('div.side-section', {},
      el('div.side-title', {
        onclick: () => {
          open ? collapsed.add(key) : collapsed.delete(key);
          localStorage.setItem('gitma.collapsed', JSON.stringify([...collapsed]));
          render();
        },
      }, el('span.chev', {}, open ? '▾' : '▸'), title, el('span.count', {}, count), actions),
      open && items);
  }

  function refItem(r, ref, label = ref.short) {
    const hidden = r.hidden.has(ref.name);
    const solo = r.solo === ref.name;
    const based = r.base && r.base.name !== ref.name ? r.basedOn.get(ref.name) : null;
    const basedText = based && (based.ahead > 0
      ? `${r.base.short} +${based.ahead}${based.behind ? ` −${based.behind}` : ''}`
      : based.behind > 0 ? `in ${r.base.short}` : '');
    const basedTitle = based && (based.ahead > 0
      ? `Splits from ${r.base.short}: ${based.ahead} commit(s) not in ${r.base.short}${based.behind ? `, ${based.behind} behind it` : ''}`
      : `Fully contained in ${r.base.short}`);
    const focused = r.focus?.ref.name === ref.name;
    return el('div.side-item' + (ref.head ? '.current' : '') + (hidden ? '.hidden' : '') + (focused ? '.focused' : ''), {
      title: (ref.upstream ? `${ref.short} → ${ref.upstream}` : ref.short) + (basedTitle ? `\n${basedTitle}` : '') +
        (ref.type !== 'tag' ? '\nClick: highlight this branch (Esc clears)' : ''),
      onclick: () => (ref.type === 'tag' ? app.select(ref.sha, true) : app.selectRef(ref)),
      ondblclick: () => !ref.head && A.checkoutRef(r, ref),
      oncontextmenu: (e) => refMenu(e, app, ref),
    },
    el('span.item-icon', {}, ref.head ? '✓' : ref.type === 'tag' ? '◆' : '⎇'),
    el('span.item-name', {}, label),
    basedText && el('span.based', {}, basedText),
    ref.ahead > 0 && el('span.badge.ahead', { title: `${ref.ahead} to push` }, `↑${ref.ahead}`),
    ref.behind > 0 && el('span.badge.behind', { title: `${ref.behind} to pull` }, `↓${ref.behind}`),
    ref.gone && el('span.badge.gone', { title: 'Upstream branch was deleted' }, 'gone'),
    el('button.solo' + (solo ? '.on' : ''), {
      title: solo ? 'Show all branches' : 'Solo: show only this branch',
      onclick: (e) => {
        e.stopPropagation();
        app.toggleSolo(ref);
      },
    }, '◎'),
    !ref.head && el('button.eye' + (hidden ? '.off' : ''), {
      title: hidden ? 'Show in graph' : 'Hide from graph',
      onclick: (e) => {
        e.stopPropagation();
        app.toggleHidden(ref);
      },
    }, hidden ? '◌' : '●'));
  }

  function render() {
    const r = app.repo;
    if (!r) return clear(list);
    const q = filter.value.trim().toLowerCase();
    const match = (s) => !q || s.toLowerCase().includes(q);
    const locals = r.refs.filter((x) => x.type === 'local' && match(x.short));
    const remotes = r.refs.filter((x) => x.type === 'remote' && match(x.short));
    const tags = r.refs.filter((x) => x.type === 'tag' && match(x.short));
    const stashes = r.stashes.filter((s) => match(s.subject));

    const byRemote = r.remotes.map((name) => {
      const items = remotes.filter((x) => x.remote === name);
      return el('div.side-group', {},
        el('div.side-subtitle', {}, '☁ ' + name),
        items.map((x) => refItem(r, x, x.short.slice(name.length + 1))));
    });

    clear(list,
      section('local', 'Local', locals.length, locals.map((x) => refItem(r, x)),
        el('button.mini', { title: 'New branch (Ctrl+B)', onclick: (e) => (e.stopPropagation(), A.createBranch(r)) }, '+')),
      section('remote', 'Remote', remotes.length, byRemote),
      section('tags', 'Tags', tags.length, tags.map((x) => refItem(r, x))),
      section('stashes', 'Stashes', stashes.length, stashes.map((s) =>
        el('div.side-item', {
          title: s.subject,
          onclick: () => app.selectStash(s),
          ondblclick: () => A.stashApply(r, s, false),
          oncontextmenu: (e) => menu(e, [
            { label: 'Apply', run: () => A.stashApply(r, s, false) },
            { label: 'Pop', run: () => A.stashApply(r, s, true) },
            { label: 'Drop…', danger: true, run: () => A.stashDrop(r, s) },
          ]),
        }, el('span.item-icon', {}, '≡'), el('span.item-name', {}, s.subject)))),
      section('worktrees', 'Worktrees', r.worktrees.length, r.worktrees.map((w) =>
        el('div.side-item', {
          title: `${w.path}\nDouble-click to open in a new tab`,
          ondblclick: () => app.openRepo(w.path),
        }, el('span.item-icon', {}, '⧉'), el('span.item-name', {}, w.branch),
        el('span.item-path', {}, w.path.split('/').pop())))),
      r.solo && el('button.btn.solo-banner', { onclick: () => app.toggleSolo({ name: r.solo }) }, 'Solo mode · show all branches'),
    );
  }

  return { el: root, render, focusFilter: () => filter.focus() };
}
