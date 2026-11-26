// Every git operation the UI can trigger. Each goes through `act`, which shows progress, reports
// errors, refreshes, and records an undo step when the operation can be reversed.
import { confirm, form, prompt, toast, toastError } from './ui.js';
import { invoke } from '@tauri-apps/api/core';

let busyListeners = new Set();
export const onBusy = (fn) => busyListeners.add(fn);

/**
 * @param {import('./repo.js').Repo} repo
 * @param {string} label shown in progress / undo
 * @param {() => Promise<void|(() => Promise<void>)>} fn may return an undo function
 */
export async function act(repo, label, fn, { quiet = false } = {}) {
  repo.busy++;
  busyListeners.forEach((f) => f(repo, label));
  try {
    const undo = await fn();
    if (typeof undo === 'function') {
      const after = (await repo.git(['rev-parse', '-q', '--verify', 'HEAD'], { ok: [0, 1] })).trim();
      repo.undoStack.push({ label, undo, after });
    }
    if (repo.undoStack.length > 50) repo.undoStack.shift();
    if (!quiet) toast(label);
    return true;
  } catch (e) {
    toastError(e, label);
    return false;
  } finally {
    repo.busy--;
    busyListeners.forEach((f) => f(repo, null));
    await repo.refresh('refs').catch(() => {});
  }
}

const headSha = async (repo) => (await repo.git(['rev-parse', 'HEAD'])).trim();

/** Undo for anything that only moved the current branch: put it back, keeping local edits. */
async function branchMover(repo, fn) {
  const before = await headSha(repo);
  const branch = repo.head.branch;
  await fn();
  return async () => {
    if (repo.head.branch !== branch) throw new Error(`Checkout ${branch ?? 'the previous commit'} first`);
    await repo.git(['reset', '--keep', before]);
  };
}

export async function undo(repo) {
  const step = repo.undoStack.pop();
  if (!step) return toast('Nothing to undo');
  const now = (await repo.git(['rev-parse', '-q', '--verify', 'HEAD'], { ok: [0, 1] })).trim();
  if (now !== step.after) {
    repo.undoStack = [];
    return toast(`Can't undo ${step.label}: the repository changed since (another tool or a terminal moved HEAD)`, { kind: 'error' });
  }
  await act(repo, `Undo ${step.label}`, async () => {
    await step.undo();
  });
}

// ---------- remote ----------

export const fetchAll = (repo, quiet = false) =>
  act(repo, 'Fetch', () => repo.git(['fetch', '--all', '--prune', '--tags']).then(() => {}), { quiet });

export async function pull(repo) {
  if (!repo.head.branch) return toast('Not on a branch', { kind: 'error' });
  await act(repo, `Pull ${repo.head.branch}`, () => branchMover(repo, async () => {
    try {
      await repo.git(['pull', '--no-edit']);
    } catch (e) {
      if (!/divergent branches/i.test(e.message)) throw e;
      const r = await form('Branches have diverged', [{ name: 'how', label: 'How do you want to integrate the remote commits?', type: 'select', options: ['Merge', 'Rebase'], value: 'Merge' }], { ok: 'Pull' });
      if (!r) throw new Error('Pull cancelled: local and remote have diverged');
      await repo.git(['pull', '--no-edit', r.how === 'Rebase' ? '--rebase' : '--no-rebase']);
    }
  }));
}

export async function push(repo, branch = repo.head.branch) {
  if (!branch) return toast('Not on a branch', { kind: 'error' });
  const ref = repo.local(branch);
  let args;
  if (ref?.upstream) {
    const [remote, ...rest] = ref.upstream.split('/');
    args = ['push', remote, `${branch}:${rest.join('/')}`];
  } else {
    const remote = await pickRemote(repo, `Push ${branch} to`);
    if (!remote) return;
    args = ['push', '-u', remote, branch];
  }
  await act(repo, `Push ${branch}`, async () => {
    try {
      await repo.git(args);
    } catch (e) {
      if (!/rejected|non-fast-forward|fetch first/i.test(e.message)) throw e;
      const ok = await confirm('Push rejected',
        `The remote has commits you don't have. Force push ${branch} (with lease)? This overwrites the remote branch.`,
        { ok: 'Force push', danger: true });
      if (!ok) throw new Error('Push rejected: pull first, or force push');
      await repo.git([...args.slice(0, 1), '--force-with-lease', ...args.slice(1)]);
    }
  });
}

async function pickRemote(repo, title) {
  if (repo.remotes.length === 0) {
    toast('This repository has no remotes', { kind: 'error' });
    return null;
  }
  if (repo.remotes.length === 1) return repo.remotes[0];
  const r = await form(title, [{ name: 'remote', label: 'Remote', type: 'select', options: repo.remotes, value: 'origin' }]);
  return r?.remote ?? null;
}

/** Fast-forward a local branch that isn't checked out, from its upstream. */
export async function fastForward(repo, ref) {
  if (!ref.upstream) return toast(`${ref.short} has no upstream`, { kind: 'error' });
  const [remote, ...rest] = ref.upstream.split('/');
  await act(repo, `Fast-forward ${ref.short}`, () => repo.git(['fetch', remote, `${rest.join('/')}:${ref.short}`]).then(() => {}));
}

// ---------- branches ----------

export async function checkout(repo, target) {
  const back = repo.head.branch ? [repo.head.branch] : ['--detach', repo.head.sha];
  const label = /^[0-9a-f]{40}$/.test(target) ? target.slice(0, 7) : target;
  await act(repo, `Checkout ${label}`, async () => {
    await repo.git(['switch', ...(/^[0-9a-f]{40}$/.test(target) ? ['--detach'] : []), target]);
    return () => repo.git(['switch', ...back]);
  });
}

/** Double-click on a ref: local → switch, remote → switch to (or create) the tracking branch. */
export async function checkoutRef(repo, ref) {
  if (ref.type === 'local') return checkout(repo, ref.short);
  if (ref.type === 'tag') return checkout(repo, ref.sha);
  const name = ref.short.slice(ref.remote.length + 1);
  if (repo.local(name)) return checkout(repo, name);
  await act(repo, `Checkout ${name}`, async () => {
    await repo.git(['switch', '-c', name, '--track', ref.short]);
    return () => repo.git(['switch', '-']).then(() => repo.git(['branch', '-D', name]));
  });
}

export async function createBranch(repo, at = null) {
  const name = await prompt('New branch', at ? `Branch name (from ${at.slice(0, 7)})` : 'Branch name');
  if (!name) return;
  await act(repo, `Create branch ${name}`, async () => {
    await repo.git(['switch', '-c', name, ...(at ? [at] : [])]);
    return async () => {
      await repo.git(['switch', '-']);
      await repo.git(['branch', '-D', name]);
    };
  });
}

export async function renameBranch(repo, ref) {
  const name = await prompt('Rename branch', 'New name', ref.short, 'Rename');
  if (!name || name === ref.short) return;
  await act(repo, `Rename ${ref.short} → ${name}`, async () => {
    await repo.git(['branch', '-m', ref.short, name]);
    return () => repo.git(['branch', '-m', name, ref.short]);
  });
}

export async function deleteBranch(repo, ref) {
  if (ref.type === 'remote') {
    const name = ref.short.slice(ref.remote.length + 1);
    if (!(await confirm('Delete remote branch', `Delete ${name} on ${ref.remote}? Other people lose it too.`, { ok: 'Delete', danger: true }))) return;
    return act(repo, `Delete ${ref.short}`, () => repo.git(['push', ref.remote, '--delete', name]).then(() => {}));
  }
  if (!(await confirm('Delete branch', `Delete local branch ${ref.short}?`, { ok: 'Delete', danger: true }))) return;
  await act(repo, `Delete ${ref.short}`, async () => {
    try {
      await repo.git(['branch', '-d', ref.short]);
    } catch (e) {
      if (!/not fully merged/.test(e.message)) throw e;
      if (!(await confirm('Branch not merged', `${ref.short} has commits not merged anywhere. Delete anyway?`, { ok: 'Delete', danger: true })))
        throw new Error('Cancelled');
      await repo.git(['branch', '-D', ref.short]);
    }
    return () => repo.git(['branch', ref.short, ref.sha]);
  });
}

export async function setUpstream(repo, ref) {
  const remotes = repo.refs.filter((r) => r.type === 'remote').map((r) => r.short);
  if (!remotes.length) return toast('No remote branches', { kind: 'error' });
  const r = await form(`Upstream for ${ref.short}`, [{ name: 'up', label: 'Remote branch', type: 'select', options: remotes, value: ref.upstream ?? `origin/${ref.short}` }]);
  if (r) await act(repo, `Track ${r.up}`, () => repo.git(['branch', `--set-upstream-to=${r.up}`, ref.short]).then(() => {}));
}

// ---------- merge / rebase ----------

export async function merge(repo, from) {
  await act(repo, `Merge ${from} into ${repo.head.branch ?? 'HEAD'}`, () =>
    branchMover(repo, () => repo.git(['merge', '--no-edit', from])));
}

/** Rebase `branch` (default: current) onto `onto`. */
export async function rebase(repo, onto, branch = null) {
  const label = `Rebase ${branch ?? repo.head.branch ?? 'HEAD'} onto ${onto}`;
  await act(repo, label, async () => {
    if (branch && branch !== repo.head.branch) {
      const before = (await repo.git(['rev-parse', branch])).trim();
      await repo.git(['rebase', onto, branch]);
      return () => repo.git(['reset', '--keep', before]);
    }
    return branchMover(repo, () => repo.git(['rebase', onto]));
  });
}

export const cherryPick = (repo, c) =>
  act(repo, `Cherry-pick ${c.sha.slice(0, 7)}`, () =>
    branchMover(repo, () => repo.git(['cherry-pick', ...(c.parents.length > 1 ? ['-m', '1'] : []), c.sha])));

export const revert = (repo, c) =>
  act(repo, `Revert ${c.sha.slice(0, 7)}`, () =>
    branchMover(repo, () => repo.git(['revert', '--no-edit', ...(c.parents.length > 1 ? ['-m', '1'] : []), c.sha])));

export async function reset(repo, sha, mode) {
  if (mode === 'hard' && !(await confirm('Hard reset', `Reset ${repo.head.branch ?? 'HEAD'} to ${sha.slice(0, 7)} and DISCARD all uncommitted changes?`, { ok: 'Reset hard', danger: true })))
    return;
  await act(repo, `Reset ${mode} to ${sha.slice(0, 7)}`, async () => {
    const before = await headSha(repo);
    await repo.git(['reset', `--${mode}`, sha]);
    return () => repo.git(['reset', `--${mode}`, before]);
  });
}

/** Continue / abort / skip the operation in progress (merge, rebase, cherry-pick, revert). */
export function sequencer(repo, verb) {
  const op = repo.state;
  const args = op === 'merge' && verb === 'continue' ? ['commit', '--no-edit'] : [op, `--${verb}`];
  return act(repo, `${verb[0].toUpperCase() + verb.slice(1)} ${op}`, () => repo.git(args).then(() => {}));
}

// ---------- stash ----------

export async function stash(repo) {
  const r = await form('Stash changes', [
    { name: 'msg', label: 'Message (optional)' },
    { name: 'untracked', label: 'Include untracked files', type: 'checkbox', value: true },
  ], { ok: 'Stash' });
  if (!r) return;
  await act(repo, 'Stash', async () => {
    const top = () => repo.git(['rev-parse', '-q', '--verify', 'refs/stash'], { ok: [0, 1] });
    const before = await top();
    await repo.git(['stash', 'push', ...(r.untracked ? ['-u'] : []), ...(r.msg ? ['-m', r.msg] : [])]);
    if ((await top()) !== before) return () => repo.git(['stash', 'pop']);
  });
}

export const stashApply = (repo, s, pop) =>
  act(repo, `${pop ? 'Pop' : 'Apply'} ${s.ref}`, () => repo.git(['stash', pop ? 'pop' : 'apply', s.ref]).then(() => {}));

export async function stashDrop(repo, s) {
  if (!(await confirm('Drop stash', `Drop ${s.ref} "${s.subject}"?`, { ok: 'Drop', danger: true }))) return;
  await act(repo, `Drop ${s.ref}`, async () => {
    await repo.git(['stash', 'drop', s.ref]);
    return () => repo.git(['stash', 'store', '-m', s.subject, s.sha]);
  });
}

// ---------- tags ----------

export async function createTag(repo, sha) {
  const r = await form(`Tag ${sha.slice(0, 7)}`, [
    { name: 'name', label: 'Tag name' },
    { name: 'msg', label: 'Message (optional: makes an annotated tag)' },
  ], { ok: 'Create tag' });
  if (!r?.name.trim()) return;
  const name = r.name.trim();
  await act(repo, `Tag ${name}`, async () => {
    await repo.git(['tag', ...(r.msg ? ['-a', '-m', r.msg] : []), name, sha]);
    return () => repo.git(['tag', '-d', name]);
  });
}

export async function pushTag(repo, ref) {
  const remote = await pickRemote(repo, `Push tag ${ref.short} to`);
  if (remote) await act(repo, `Push tag ${ref.short}`, () => repo.git(['push', remote, `refs/tags/${ref.short}`]).then(() => {}));
}

export async function deleteTag(repo, ref) {
  const r = await form('Delete tag', [{ name: 'remote', label: 'Also delete from remotes', type: 'checkbox' }],
    { ok: 'Delete', danger: true, message: `Delete tag ${ref.short}?` });
  if (!r) return;
  await act(repo, `Delete tag ${ref.short}`, async () => {
    await repo.git(['tag', '-d', ref.short]);
    if (r.remote) for (const rem of repo.remotes) await repo.git(['push', rem, `:refs/tags/${ref.short}`]);
    if (!r.remote) return () => repo.git(['tag', ref.short, ref.sha]);
  });
}

// ---------- working tree ----------

export const stage = (repo, paths) =>
  act(repo, 'Stage', () => repo.git(['add', '-A', '--', ...paths]).then(() => {}), { quiet: true });

export const unstage = (repo, paths) =>
  act(repo, 'Unstage', () => repo.git(repo.head.sha ? ['reset', '-q', 'HEAD', '--', ...paths] : ['rm', '--cached', '-q', '--', ...paths]).then(() => {}), { quiet: true });

export const stageAll = (repo) => act(repo, 'Stage all', () => repo.git(['add', '-A']).then(() => {}), { quiet: true });
export const unstageAll = (repo) => act(repo, 'Unstage all', () => repo.git(repo.head.sha ? ['reset', '-q'] : ['rm', '-r', '--cached', '-q', '.']).then(() => {}), { quiet: true });

export async function discard(repo, files) {
  const names = files.map((f) => f.path);
  const what = names.length === 1 ? names[0] : `${names.length} files`;
  if (!(await confirm('Discard changes', `Discard all changes to ${what}? This cannot be undone.`, { ok: 'Discard', danger: true }))) return;
  await act(repo, `Discard ${what}`, async () => {
    // Unstaged discard restores from the index, so staged edits of the same file survive.
    const untracked = files.filter((f) => f.untracked).map((f) => f.path);
    const conflicted = files.filter((f) => f.conflict).map((f) => f.path);
    const tracked = files.filter((f) => !f.untracked && !f.conflict).map((f) => f.path);
    if (tracked.length) await repo.git(['restore', '--worktree', '--', ...tracked]);
    if (conflicted.length) await repo.git(['restore', '--staged', '--worktree', '--source=HEAD', '--', ...conflicted]);
    if (untracked.length) await repo.git(['clean', '-f', '-q', '--', ...untracked]);
  });
}

export async function discardAll(repo) {
  if (!(await confirm('Discard all changes', 'Discard ALL uncommitted changes, including untracked files? This cannot be undone.', { ok: 'Discard all', danger: true }))) return;
  await act(repo, 'Discard all changes', async () => {
    if (repo.head.sha) await repo.git(['reset', '--hard', '-q']);
    await repo.git(['clean', '-fd', '-q']);
  });
}

/** Applies a patch built by buildPatch to the index (or the worktree when `worktree`). */
export const applyPatch = (repo, patch, { reverse = false, worktree = false } = {}) =>
  act(repo, reverse ? (worktree ? 'Discard lines' : 'Unstage lines') : 'Stage lines', () =>
    repo.git(['apply', ...(worktree ? [] : ['--cached']), '--recount', '--whitespace=nowarn', ...(reverse ? ['--reverse'] : []), '-'],
      { stdin: patch }).then(() => {}), { quiet: true });

export async function commit(repo, message, amend) {
  if (!message.trim()) return toast('Write a commit message', { kind: 'error' }) ?? false;
  if (!amend && repo.status.staged.length === 0) return toast('Nothing staged', { kind: 'error' }) ?? false;
  return act(repo, amend ? 'Amend commit' : 'Commit', async () => {
    const before = repo.head.sha;
    await repo.git(['commit', ...(amend ? ['--amend'] : []), '--cleanup=whitespace', '-F', '-'], { stdin: message });
    if (before) return () => repo.git(['reset', '--soft', before]);
  });
}

// ---------- interactive rebase ----------

const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * steps: [{ sha, action: pick|reword|squash|fixup|drop, message }] oldest first.
 * The todo is handed to git through GIT_SEQUENCE_EDITOR; rewords amend right after their pick.
 */
export async function interactiveRebase(repo, base, steps) {
  const stamp = Date.now();
  const lines = [];
  for (const [i, s] of steps.entries()) {
    if (s.action === 'reword') {
      const file = await invoke('write_temp', { name: `msg-${stamp}-${i}.txt`, content: s.message });
      lines.push(`pick ${s.sha}`, `exec git commit --amend --only --allow-empty --cleanup=whitespace -F ${shQuote(file)}`);
    } else lines.push(`${s.action} ${s.sha}`);
  }
  const todo = await invoke('write_temp', { name: `todo-${stamp}.txt`, content: lines.join('\n') + '\n' });
  await act(repo, 'Interactive rebase', () =>
    branchMover(repo, () => repo.git(['rebase', '-i', base], { env: { GIT_SEQUENCE_EDITOR: `cp ${shQuote(todo)}` } })));
}
