// One open repository: data loading, live refresh and per-repo preferences.
import { invoke } from '@tauri-apps/api/core';
import { LOG_FORMAT, REF_FORMAT, parseLog, parseRefs, parseStatus } from './parse.js';
import { layout } from './graph.js';

export const PAGE = 5000;
let nextId = 1;

export class GitError extends Error {
  constructor(args, out) {
    super((out.stderr || out.stdout).trim() || `git ${args[0]} failed (exit ${out.code})`);
    this.out = out;
  }
}

export class Repo {
  /** @param {{root: string, gitDir: string, commonDir: string}} info */
  constructor(info) {
    this.id = nextId++;
    Object.assign(this, info);
    this.name = info.root.split(/[\\/]/).pop();
    this.commits = [];
    this.list = [];
    this.index = new Map();
    this.refsBySha = new Map();
    this.rows = [];
    this.graphWidth = 1;
    this.refs = [];
    this.remotes = [];
    this.stashes = [];
    this.worktrees = [];
    this.head = { sha: null, branch: null };
    this.status = parseStatus('');
    this.state = '';
    this.limit = PAGE;
    this.selected = 'WIP';
    this.undoStack = [];
    this.busy = 0;
    const saved = loadPrefs(this.root);
    this.hidden = new Set(saved.hidden ?? []);
    this.solo = saved.solo ?? null;
    this.listeners = new Set();
  }

  static async open(path) {
    return new Repo(await invoke('open_repo', { path }));
  }

  /** Runs git; throws GitError unless the exit code is in `ok`. */
  async git(args, { stdin = null, env = null, ok = [0] } = {}) {
    const out = await invoke('run_git', { repo: this.root, args, stdin, env });
    if (!ok.includes(out.code)) throw new GitError(args, out);
    return out.stdout;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(what) {
    for (const fn of this.listeners) fn(what);
  }

  savePrefs() {
    localStorage.setItem('gitma.repo:' + this.root, JSON.stringify({ hidden: [...this.hidden], solo: this.solo }));
  }

  watch() {
    return invoke('watch_repo', { id: this.id, root: this.root, gitDir: this.gitDir, commonDir: this.commonDir });
  }

  unwatch() {
    return invoke('unwatch_repo', { id: this.id });
  }

  // ---------- loading ----------

  /** kind: 'refs' reloads everything; 'status' only the working tree. Concurrent calls coalesce. */
  refresh(kind = 'refs') {
    this.pending = this.pending === 'refs' ? 'refs' : kind;
    this.loading ??= this.#drain();
    return this.loading;
  }

  async #drain() {
    try {
      while (this.pending) {
        const kind = this.pending;
        this.pending = null;
        await (kind === 'refs' ? this.#loadAll() : this.#loadStatus());
        this.emit(kind);
      }
    } finally {
      this.loading = null;
    }
  }

  async #loadAll() {
    const [refs, head, remotes, stashes, worktrees] = await Promise.all([
      this.git(['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
      this.git(['rev-parse', '-q', '--verify', 'HEAD'], { ok: [0, 1, 128] }),
      this.git(['remote']),
      this.git(['stash', 'list', '--format=%gd%x1f%H%x1f%s%x1f%ct']),
      this.git(['worktree', 'list', '--porcelain']),
    ]);
    this.refs = parseRefs(refs);
    const current = this.refs.find((r) => r.head);
    this.head = { sha: head.trim() || null, branch: current?.short ?? null };
    this.remotes = remotes.split('\n').filter(Boolean);
    this.stashes = stashes.split('\n').filter(Boolean).map((l) => {
      const [ref, sha, subject, time] = l.split('\x1f');
      return { ref, sha, subject, time: Number(time) };
    });
    this.worktrees = worktrees.split('\n\n').filter(Boolean).map((b) => ({
      path: /^worktree (.*)$/m.exec(b)?.[1],
      branch: /^branch refs\/heads\/(.*)$/m.exec(b)?.[1] ?? '(detached)',
    })).filter((w) => w.path);
    if (this.solo && !this.refs.some((r) => r.name === this.solo)) this.solo = null;
    await Promise.all([this.#loadLog(), this.#loadStatus()]);
  }

  async #loadLog() {
    if (!this.head.sha && !this.refs.length) {
      this.commits = [];
    } else {
      const args = ['log', '--date-order', `-n${this.limit}`, `--format=${LOG_FORMAT}`];
      if (this.solo) args.push(this.solo, 'HEAD');
      else {
        for (const h of this.hidden) args.push(`--exclude=${h}`);
        args.push('--exclude=refs/stash', '--all');
      }
      this.commits = parseLog(await this.git(args, { ok: [0, 128] }));
    }
    this.index = new Map(this.commits.map((c, i) => [c.sha, i]));
    this.refsBySha = new Map();
    for (const r of this.refs) {
      if (this.hidden.has(r.name) || (this.solo && r.name !== this.solo && !r.head)) continue;
      if (!this.refsBySha.has(r.sha)) this.refsBySha.set(r.sha, []);
      this.refsBySha.get(r.sha).push(r);
    }
    this.#layout();
  }

  async #loadStatus() {
    const [status, state] = await Promise.all([
      this.git(['status', '--porcelain=v2', '-z', '--untracked-files=all']),
      invoke('repo_state', { gitDir: this.gitDir }),
    ]);
    this.status = parseStatus(status);
    this.state = state;
    this.#layout();
  }

  /** The WIP row is a virtual commit on top of HEAD whenever the working tree is dirty. */
  get hasWip() {
    return this.status.files.length > 0 || !this.head.sha;
  }

  #layout() {
    const list = this.hasWip
      ? [{ sha: 'WIP', parents: this.head.sha ? [this.head.sha] : [], wip: true }, ...this.commits]
      : this.commits;
    const { rows, width } = layout(list);
    this.list = list;
    this.rows = rows;
    this.graphWidth = width;
    if (this.selected === 'WIP' && !this.hasWip) this.selected = this.head.sha;
  }

  async loadMore() {
    if (this.loadingMore || this.loading || this.commits.length < this.limit) return;
    this.loadingMore = true;
    try {
      this.limit += PAGE;
      await this.#loadLog();
      this.emit('refs');
    } finally {
      this.loadingMore = false;
    }
  }

  rowOf(sha) {
    return this.list.findIndex((c) => c.sha === sha);
  }

  local(name) {
    return this.refs.find((r) => r.type === 'local' && r.short === name);
  }
}

function loadPrefs(root) {
  try {
    return JSON.parse(localStorage.getItem('gitma.repo:' + root)) ?? {};
  } catch {
    return {};
  }
}
