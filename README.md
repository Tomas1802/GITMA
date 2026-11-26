<p align="center"><img src="app-icon.svg" width="96" alt="GITMA logo" /></p>
<h1 align="center">GITMA</h1>
<p align="center">A fast, lightweight Git client for Windows — the GitKraken features you use every day, nothing else.</p>

---

## Features

- **Live graph** — every change to the repo (from GITMA, a terminal, or an AI agent running git) shows up instantly.
- **All branches** in a colored commit graph; **hide** any branch or **solo** one; ahead/behind badges.
- **Commit details** and **diffs** (inline or split, syntax highlighted), **file history** and **blame**.
- **Stage / unstage / discard** by file, hunk or individual line; commit and amend.
- **Branches**: checkout (double-click), create, rename, delete, set upstream, fast-forward.
- **Remotes**: fetch, pull, push (force-with-lease on rejection), background auto-fetch.
- **Drag & drop** a branch onto another to merge or rebase.
- Cherry-pick, revert, reset (soft / mixed / hard), **interactive rebase** (reorder, reword, squash, fixup, drop).
- **Conflict editor** with take current / incoming / both, plus continue / skip / abort for merges and rebases.
- Stashes, tags, worktrees, multiple repo tabs, **undo** of the last actions, command palette.
- **Auto-updates**: new releases download in the background; one click restarts into them.

## Shortcuts

| Keys | Action |
|---|---|
| Ctrl+P | Command palette |
| Ctrl+O / Ctrl+W / Ctrl+Tab | Open repo / close tab / next tab |
| Ctrl+Z | Undo last action |
| Ctrl+F | Search commits (Enter / Shift+Enter: next / previous) |
| Ctrl+B | New branch |
| Ctrl+Shift+L / Ctrl+Shift+K | Pull / push |
| Ctrl+Shift+S | Stash |
| Ctrl+Shift+M | Go to commit message |
| Ctrl+Enter / Ctrl+Shift+Enter | Commit / stage all & commit |
| ↑ ↓ PgUp PgDn Home End | Move through the graph |
| F5 | Refresh |
| Esc | Close diff / blame / history |

Open a folder from a terminal with `gitma <folder>`, or right-click a folder → **Open in GITMA**.

## Development

```sh
npm install
npm run tauri dev       # run
npm test                # JS unit tests
cargo test --manifest-path src-tauri/Cargo.toml
```

## Releasing

Push a tag like `v0.1.0`. The workflow builds, signs and publishes the installer plus `latest.json`, which installed
copies pick up automatically. The repo needs the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
secrets (GITMA's own key pair; the public key is in `tauri.conf.json`, the private key lives outside the repo).
