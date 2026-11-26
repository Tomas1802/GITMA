// Center views besides the graph and diffs: blame, file history, merge-conflict editor.
import { el, clear, toast, toastError, confirm } from './ui.js';
import { LOG_FORMAT, parseBlame, parseConflicts, parseLog, relTime, shortSha } from './parse.js';
import { laneColor } from './graphview.js';
import * as A from './actions.js';
import { invoke } from '@tauri-apps/api/core';

function frame(title, onClose, ...extra) {
  const body = el('div.view-body');
  const root = el('div.view', { tabIndex: -1 },
    el('div.view-bar', {},
      el('button.btn.small', { onclick: onClose, title: 'Back (Esc)' }, '← Back'),
      el('span.view-title', { title }, title), el('span.spacer'), ...extra),
    body);
  return { root, body };
}

// ---------- blame ----------

export function createBlameView({ repo, path, rev = null, onClose, onSelectCommit }) {
  const { root, body } = frame(`Blame · ${path}${rev ? ` @ ${shortSha(rev)}` : ''}`, onClose);
  (async () => {
    try {
      const lines = parseBlame(await repo.git(['blame', '--porcelain', ...(rev ? [rev] : []), '--', path]));
      const colorOf = new Map();
      const rows = lines.map((l, i) => {
        if (!colorOf.has(l.sha)) colorOf.set(l.sha, laneColor(colorOf.size));
        const start = i === 0 || lines[i - 1].sha !== l.sha;
        const uncommitted = /^0+$/.test(l.sha);
        return el('div.bl' + (start ? '.start' : ''), { style: { '--lane': colorOf.get(l.sha) } },
          el('span.bl-info', {
            title: uncommitted ? 'Not committed yet' : `${l.summary}\n${l.author} · ${new Date(l.time * 1000).toLocaleString()}`,
            onclick: () => !uncommitted && onSelectCommit(l.sha),
          }, start ? [el('span.bl-sha', {}, uncommitted ? 'WIP' : shortSha(l.sha)), el('span.bl-author', {}, l.author ?? ''),
            el('span.bl-date', {}, l.time ? relTime(l.time) : '')] : ''),
          el('span.ln', {}, l.line), el('span.code', {}, l.text));
      });
      clear(body, el('div.blame', {}, rows));
    } catch (e) {
      clear(body, el('div.empty', {}, 'Could not blame this file'));
      toastError(e, 'Blame');
    }
  })();
  return { el: root, focus: () => root.focus() };
}

// ---------- file history ----------

export function createHistoryView({ repo, path, onClose, onOpenDiff, onSelectCommit }) {
  const { root, body } = frame(`History · ${path}`, onClose);
  (async () => {
    try {
      // --name-status gives each commit's path for this file, which changes across renames.
      const out = await repo.git(['log', '--follow', '-n', '1000', '--name-status', `--format=${LOG_FORMAT}`, '--', path]);
      // Each commit's name-status lines come right after its record, i.e. at the start of the next chunk.
      const parts = out.split('\x1e');
      const commits = [];
      for (let i = 0; i < parts.length - 1; i++) {
        const rec = parts[i].split('\n').filter((l) => l.includes('\x1f')).pop();
        const [c] = parseLog(rec + '\x1e');
        if (!c) continue;
        const f = parts[i + 1].split('\n').find((l) => /^[A-Z]\d*\t/.test(l))?.split('\t');
        commits.push({ ...c, status: f?.[0][0] ?? 'M', filePath: f ? f[f.length - 1] : path, oldPath: f?.length === 3 ? f[1] : null });
      }
      clear(body, el('div.history', {}, commits.length ? commits.map((c) =>
        el('div.hrow', {
          onclick: () => onOpenDiff(c),
          ondblclick: () => onSelectCommit(c.sha),
          title: 'Click: show this change · Double-click: go to commit',
        },
        el('span.st.st-' + (c.status ?? 'M'), {}, c.status ?? 'M'),
        el('span.h-msg', {}, c.subject),
        c.oldPath && el('span.muted', {}, ` (renamed from ${c.oldPath})`),
        el('span.h-author', {}, c.author),
        el('span.h-date', { title: new Date(c.time * 1000).toLocaleString() }, relTime(c.time)),
        el('span.h-sha', {}, shortSha(c.sha)))) : el('div.empty', {}, 'No history')));
    } catch (e) {
      clear(body, el('div.empty', {}, 'Could not load history'));
      toastError(e, 'History');
    }
  })();
  return { el: root, focus: () => root.focus() };
}

// ---------- conflict editor ----------

export function createConflictView({ repo, path, onClose }) {
  const state = { segs: [], choice: [] };
  const saveBtn = el('button.btn.small.primary', { onclick: () => save(true) }, 'Save & mark resolved');
  const { root, body } = frame(`Resolve conflict · ${path}`, onClose,
    el('button.btn.small', { onclick: () => whole('ours') }, 'Use current (ours) for whole file'),
    el('button.btn.small', { onclick: () => whole('theirs') }, 'Use incoming (theirs) for whole file'),
    saveBtn);

  async function load() {
    try {
      state.segs = parseConflicts(await invoke('read_file', { root: repo.root, path }));
      state.choice = state.segs.map(() => null);
      render();
    } catch (e) {
      clear(body, el('div.empty', {}, 'Could not read file'));
      toastError(e, 'Conflict');
    }
  }

  function render() {
    const blocks = state.segs.filter((s) => s.text === undefined).length;
    const done = state.choice.filter(Boolean).length;
    saveBtn.textContent = done < blocks ? `Resolved ${done}/${blocks} · Save` : 'Save & mark resolved';
    clear(body, el('div.conflict', {}, state.segs.map((s, i) => {
      if (s.text !== undefined) return el('pre.c-text', {}, s.text);
      const pick = (v) => {
        state.choice[i] = v;
        render();
      };
      const ch = state.choice[i];
      return el('div.c-block' + (ch ? '.resolved' : ''), {},
        el('div.c-sides', {},
          el('div.c-side.ours' + (ch === 'ours' || ch === 'both' ? '.chosen' : ''), {},
            el('div.c-label', {}, `Current · ${s.oursLabel}`), el('pre', {}, s.ours || '(empty)')),
          el('div.c-side.theirs' + (ch === 'theirs' || ch === 'both' ? '.chosen' : ''), {},
            el('div.c-label', {}, `Incoming · ${s.theirsLabel}`), el('pre', {}, s.theirs || '(empty)'))),
        el('div.c-btns', {},
          el('button.btn.tiny' + (ch === 'ours' ? '.primary' : ''), { onclick: () => pick('ours') }, 'Take current'),
          el('button.btn.tiny' + (ch === 'theirs' ? '.primary' : ''), { onclick: () => pick('theirs') }, 'Take incoming'),
          el('button.btn.tiny' + (ch === 'both' ? '.primary' : ''), { onclick: () => pick('both') }, 'Take both'),
          ch && el('button.btn.tiny', { onclick: () => pick(null) }, 'Reset')));
    })));
  }

  function resolvedText() {
    return state.segs.map((s, i) => {
      if (s.text !== undefined) return s.text;
      const c = state.choice[i];
      if (c === 'ours') return s.ours;
      if (c === 'theirs') return s.theirs;
      if (c === 'both') return s.ours + s.theirs;
      return `<<<<<<< ${s.oursLabel}\n${s.ours}=======\n${s.theirs}>>>>>>> ${s.theirsLabel}\n`;
    }).join('');
  }

  async function save(markResolved) {
    const pending = state.choice.some((c, i) => !c && state.segs[i].text === undefined);
    if (pending && !(await confirm('Unresolved conflicts', 'Some blocks are not resolved yet. Save the file anyway and keep the remaining markers?', { ok: 'Save' })))
      return;
    try {
      await invoke('write_file', { root: repo.root, path, content: resolvedText() });
      if (markResolved && !pending) {
        await A.stage(repo, [path]);
        toast(`${path} resolved`);
        onClose();
      } else toast('Saved');
    } catch (e) {
      toastError(e, 'Save');
    }
  }

  async function whole(side) {
    await A.act(repo, `Use ${side} for ${path}`, async () => {
      await repo.git(['checkout', `--${side}`, '--', path]);
      await repo.git(['add', '--', path]);
    });
    onClose();
  }

  load();
  return { el: root, focus: () => root.focus() };
}
