// Context menus for commits and refs, shared by the graph and the sidebar.
import * as A from './actions.js';
import { copy, menu } from './ui.js';
import { openRebase } from './rebase.js';

/** @param {{repo: import('./repo.js').Repo}} app */
export function commitMenu(e, app, c) {
  const { repo } = app;
  if (c.wip) {
    return menu(e, [
      { label: 'Stash changes', run: () => A.stash(repo) },
      { label: 'Stage all', run: () => A.stageAll(repo) },
      { label: 'Discard all changes', danger: true, run: () => A.discardAll(repo) },
    ]);
  }
  const branches = (repo.refsBySha.get(c.sha) ?? []).filter((r) => r.type === 'local' && !r.head);
  const cur = repo.head.branch ?? 'HEAD';
  const isHead = c.sha === repo.head.sha;
  menu(e, [
    ...branches.map((b) => ({ label: `Checkout ${b.short}`, run: () => A.checkout(repo, b.short) })),
    !isHead && { label: 'Checkout this commit (detached)', run: () => A.checkout(repo, c.sha) },
    { label: 'Create branch here…', hint: 'Ctrl+B', run: () => A.createBranch(repo, c.sha) },
    { label: 'Create tag here…', run: () => A.createTag(repo, c.sha) },
    '-',
    !isHead && { label: `Cherry-pick onto ${cur}`, run: () => A.cherryPick(repo, c) },
    { label: 'Revert this commit', run: () => A.revert(repo, c) },
    !isHead && { label: `Rebase ${cur} onto this commit`, run: () => A.rebase(repo, c.sha) },
    !isHead && { label: `Interactive rebase ${cur} from here…`, run: () => openRebase(repo, c.sha) },
    '-',
    !isHead && { label: `Reset ${cur} here — soft (keep changes staged)`, run: () => A.reset(repo, c.sha, 'soft') },
    !isHead && { label: `Reset ${cur} here — mixed (keep changes unstaged)`, run: () => A.reset(repo, c.sha, 'mixed') },
    { label: `Reset ${cur} here — hard (discard changes)`, danger: true, run: () => A.reset(repo, c.sha, 'hard') },
    '-',
    { label: 'Copy SHA', run: () => copy(c.sha) },
    { label: 'Copy message', run: () => copy(c.subject) },
  ]);
}

export function refMenu(e, app, ref) {
  const { repo } = app;
  const cur = repo.head.branch ?? 'HEAD';
  const hidden = repo.hidden.has(ref.name);
  const view = [
    '-',
    !ref.head && { label: hidden ? 'Show in graph' : 'Hide from graph', run: () => app.toggleHidden(ref) },
    { label: repo.solo === ref.name ? 'Show all branches' : 'Solo (show only this branch)', run: () => app.toggleSolo(ref) },
  ];
  if (ref.type === 'tag') {
    return menu(e, [
      { label: `Checkout ${ref.short} (detached)`, run: () => A.checkout(repo, ref.sha) },
      { label: 'Push tag', run: () => A.pushTag(repo, ref) },
      { label: 'Delete tag…', danger: true, run: () => A.deleteTag(repo, ref) },
      '-',
      { label: 'Copy name', run: () => copy(ref.short) },
      ...view,
    ]);
  }
  const local = ref.type === 'local';
  menu(e, [
    !ref.head && { label: `Checkout ${ref.short}`, run: () => A.checkoutRef(repo, ref) },
    ref.head && { label: 'Pull', run: () => A.pull(repo) },
    local && !ref.head && ref.upstream && { label: `Fast-forward from ${ref.upstream}`, run: () => A.fastForward(repo, ref) },
    local && { label: 'Push', run: () => A.push(repo, ref.short) },
    '-',
    !ref.head && { label: `Merge ${ref.short} into ${cur}`, run: () => A.merge(repo, ref.short) },
    !ref.head && { label: `Rebase ${cur} onto ${ref.short}`, run: () => A.rebase(repo, ref.short) },
    local && !ref.head && repo.head.branch && { label: `Rebase ${ref.short} onto ${cur}`, run: () => A.rebase(repo, cur, ref.short) },
    '-',
    { label: 'Create branch here…', run: () => A.createBranch(repo, ref.sha) },
    { label: 'Create tag here…', run: () => A.createTag(repo, ref.sha) },
    local && { label: 'Set upstream…', run: () => A.setUpstream(repo, ref) },
    local && { label: 'Rename…', run: () => A.renameBranch(repo, ref) },
    !ref.head && { label: 'Delete…', danger: true, run: () => A.deleteBranch(repo, ref) },
    '-',
    { label: 'Copy name', run: () => copy(ref.short) },
    ...view,
  ]);
}

/** Dropping ref `from` onto ref `to` (GitKraken-style drag & drop). */
export function dropMenu(e, app, from, to) {
  const { repo } = app;
  if (from.name === to.name) return;
  const items = [
    to.head && { label: `Merge ${from.short} into ${to.short}`, run: () => A.merge(repo, from.short) },
    from.head && { label: `Rebase ${from.short} onto ${to.short}`, run: () => A.rebase(repo, to.short) },
    !from.head && from.type === 'local' && { label: `Rebase ${from.short} onto ${to.short}`, run: () => A.rebase(repo, to.short, from.short) },
  ].filter(Boolean);
  menu(e, items.length ? items : [{ label: `Checkout ${to.short} first to merge into it`, disabled: true }]);
}
