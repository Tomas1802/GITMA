// Command palette (Ctrl+P / Ctrl+Shift+P): fuzzy-filter every command and run it.
import { el, clear } from './ui.js';

/** @param {() => {label: string, hint?: string, run: () => void}[]} getCommands */
export function openPalette(getCommands) {
  document.getElementById('palette')?.remove();
  const commands = getCommands().filter(Boolean);
  const input = el('input.pal-input', { placeholder: 'Type a command…', spellcheck: false });
  const list = el('div.pal-list');
  const back = el('div.modal-back#palette', { onmousedown: (e) => e.target === back && close() },
    el('div.palette', {}, input, list));
  let shown = [];
  let at = 0;

  const close = () => back.remove();
  const score = (label, q) => {
    // Subsequence match; consecutive and word-start hits rank higher.
    let s = 0;
    let i = 0;
    const l = label.toLowerCase();
    for (const ch of q) {
      const j = l.indexOf(ch, i);
      if (j < 0) return -1;
      s += j === i ? 3 : j === 0 || l[j - 1] === ' ' ? 2 : 1;
      i = j + 1;
    }
    return s;
  };

  function render() {
    const q = input.value.trim().toLowerCase();
    shown = commands
      .map((c) => ({ c, s: q ? score(c.label, q) : 0 }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
    at = Math.min(at, Math.max(0, shown.length - 1));
    clear(list, shown.map((c, i) => el('div.pal-item' + (i === at ? '.on' : ''), {
      onmousemove: () => i !== at && ((at = i), render()),
      onclick: () => run(c),
    }, el('span', {}, c.label), c.hint && el('span.hint', {}, c.hint))));
    list.children[at]?.scrollIntoView({ block: 'nearest' });
  }

  function run(c) {
    close();
    c.run();
  }

  input.addEventListener('input', () => ((at = 0), render()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') at = Math.min(shown.length - 1, at + 1);
    else if (e.key === 'ArrowUp') at = Math.max(0, at - 1);
    else if (e.key === 'Enter') return shown[at] && run(shown[at]);
    else if (e.key === 'Escape') return close();
    else return;
    e.preventDefault();
    render();
  });
  document.body.append(back);
  render();
  input.focus();
}
