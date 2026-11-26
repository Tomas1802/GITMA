// Interactive rebase editor: reorder, reword, squash, fixup or drop the commits after `base`.
import { el, clear, modal, toast, toastError } from './ui.js';
import { shortSha } from './parse.js';
import { interactiveRebase } from './actions.js';

const ACTIONS = ['pick', 'reword', 'squash', 'fixup', 'drop'];

export async function openRebase(repo, base) {
  if (repo.status.files.length) return toast('Commit or stash your changes before rebasing', { kind: 'error' });
  let steps;
  try {
    const out = await repo.git(['log', '--reverse', '--format=%H%x1f%P%x1f%B%x1e', `${base}..HEAD`]);
    steps = out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
      const [sha, parents, message] = r.split('\x1f');
      return { sha, merge: parents.split(' ').length > 1, message: message.trim(), original: message.trim(), action: 'pick' };
    });
  } catch (e) {
    return toastError(e, 'Interactive rebase');
  }
  if (!steps.length) return toast('No commits after this one on the current branch', { kind: 'error' });
  const merges = steps.filter((s) => s.merge);
  steps = steps.filter((s) => !s.merge);

  const result = await modal(`Interactive rebase · ${steps.length} commits onto ${shortSha(base)}`, (close) => {
    const list = el('div.rb-list');
    const error = el('div.rb-error');
    const render = () => clear(list, steps.map((s, i) => el('div.rb-row.' + s.action, {},
      el('div.rb-move', {},
        el('button.mini', { disabled: i === 0, title: 'Move up (older)', onclick: () => swap(i, i - 1) }, '▲'),
        el('button.mini', { disabled: i === steps.length - 1, title: 'Move down (newer)', onclick: () => swap(i, i + 1) }, '▼')),
      el('select', { onchange: (e) => ((s.action = e.target.value), render()) },
        ACTIONS.map((a) => el('option', { value: a, selected: a === s.action }, a))),
      el('span.rb-sha', {}, shortSha(s.sha)),
      s.action === 'reword'
        ? el('textarea.rb-msg', { rows: Math.min(6, s.message.split('\n').length + 1), value: s.message, oninput: (e) => (s.message = e.target.value) })
        : el('span.rb-subject', {}, s.original.split('\n')[0]))));
    const swap = (a, b) => {
      [steps[a], steps[b]] = [steps[b], steps[a]];
      render();
    };
    const start = () => {
      const first = steps.find((s) => s.action !== 'drop');
      if (first && (first.action === 'squash' || first.action === 'fixup'))
        return (error.textContent = 'The first kept commit cannot be squash/fixup: there is nothing before it to combine into.');
      if (steps.some((s) => s.action === 'reword' && !s.message.trim())) return (error.textContent = 'Reworded messages cannot be empty.');
      close(steps);
    };
    render();
    return el('div', {},
      el('p.msg', {}, 'Oldest commit at the top. Squash and fixup combine a commit into the one above it.'),
      merges.length > 0 && el('p.msg.warn', {}, `${merges.length} merge commit(s) in this range will be flattened (dropped as merges).`),
      list, error,
      el('div.modal-btns', {},
        el('button.btn', { onclick: () => close(null) }, 'Cancel'),
        el('button.btn.primary', { onclick: start }, 'Start rebase')));
  }, { wide: true });

  if (result) await interactiveRebase(repo, base, result);
}
