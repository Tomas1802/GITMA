//! Live repository listener: any change to refs/HEAD/index (from GITMA, a terminal or an AI agent)
//! or to a non-ignored working-tree file is reported to the UI as a `repo-changed` event.

use notify::{Event, RecursiveMode, Watcher};
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(250);
/// Above this many changed files we skip the ignore check and just refresh.
const MAX_IGNORE_CHECK: usize = 2000;

#[derive(Clone, Serialize)]
struct Change {
    id: u32,
    /// "refs" = branches/HEAD/tags moved (full reload); "status" = only working tree / index.
    kind: &'static str,
}

#[derive(Debug, Default, PartialEq)]
pub struct Classified {
    pub refs: bool,
    pub index: bool,
    pub worktree: Vec<PathBuf>,
}

/// Sorts raw event paths into what the UI needs to reload. `git_dirs` are the repo's git dir and
/// common dir (they differ for linked worktrees).
pub fn classify(paths: &[PathBuf], root: &Path, git_dirs: &[PathBuf]) -> Classified {
    let mut out = Classified::default();
    for p in paths {
        if let Some(rel) = git_dirs.iter().find_map(|d| p.strip_prefix(d).ok()) {
            let first = rel.components().next().map(|c| c.as_os_str().to_string_lossy().into_owned());
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            match first.as_deref() {
                // Object writes and reflogs always come with a ref/index change we already catch.
                // fsmonitor cookies / gc.log / FETCH_HEAD churn without meaningful changes (a fetch
                // that moved anything also touches refs/), and would otherwise cause refresh loops.
                Some("objects") | Some("logs") | Some("fsmonitor--daemon") | Some("gc.log") | Some("FETCH_HEAD") | None => {}
                _ if name.ends_with(".lock") => {}
                Some("index") => out.index = true,
                _ => out.refs = true,
            }
        } else if let Ok(rel) = p.strip_prefix(root) {
            if !rel.as_os_str().is_empty() {
                out.worktree.push(rel.to_path_buf());
            }
        }
    }
    out
}

/// True if at least one of `paths` is not ignored by git.
fn any_tracked(root: &Path, paths: &[PathBuf]) -> bool {
    if paths.len() > MAX_IGNORE_CHECK {
        return true;
    }
    let mut cmd = crate::git::command(root);
    cmd.args(["check-ignore", "--stdin", "-z"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let Ok(mut child) = cmd.spawn() else { return true };
    let input: Vec<u8> = paths
        .iter()
        .flat_map(|p| {
            let mut b = p.to_string_lossy().replace('\\', "/").into_bytes();
            b.push(0);
            b
        })
        .collect();
    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    match child.wait_with_output() {
        Ok(out) => {
            let ignored = out.stdout.split(|&b| b == 0).filter(|s| !s.is_empty()).count();
            ignored < paths.len()
        }
        Err(_) => true,
    }
}

/// Starts watching; dropping the returned watcher stops it (and ends the debounce thread).
pub fn start(
    app: AppHandle,
    id: u32,
    root: PathBuf,
    git_dirs: Vec<PathBuf>,
) -> notify::Result<notify::RecommendedWatcher> {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(tx)?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    for dir in git_dirs.iter().filter(|d| !d.starts_with(&root)) {
        watcher.watch(dir, RecursiveMode::Recursive)?;
    }
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut paths: Vec<PathBuf> = first.map(|e| e.paths).unwrap_or_default();
            let deadline = Instant::now() + DEBOUNCE;
            while let Ok(ev) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                paths.extend(ev.map(|e| e.paths).unwrap_or_default());
            }
            paths.sort();
            paths.dedup();
            let c = classify(&paths, &root, &git_dirs);
            let kind = if c.refs {
                "refs"
            } else if c.index || (!c.worktree.is_empty() && any_tracked(&root, &c.worktree)) {
                "status"
            } else {
                continue;
            };
            let _ = app.emit("repo-changed", Change { id, kind });
        }
    });
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn classifies_git_and_worktree_paths() {
        let root = p("C:/r");
        let dirs = vec![p("C:/r/.git")];
        let c = classify(
            &[
                p("C:/r/.git/objects/ab/cdef"),
                p("C:/r/.git/logs/HEAD"),
                p("C:/r/.git/refs/heads/main.lock"),
                p("C:/r/src/main.rs"),
            ],
            &root,
            &dirs,
        );
        assert_eq!(c, Classified { refs: false, index: false, worktree: vec![p("src/main.rs")] });

        let c = classify(&[p("C:/r/.git/index")], &root, &dirs);
        assert!(c.index && !c.refs);

        let c = classify(&[p("C:/r/.git/refs/heads/main"), p("C:/r/.git/HEAD")], &root, &dirs);
        assert!(c.refs);
    }

    #[test]
    fn linked_worktree_uses_common_dir() {
        let c = classify(
            &[p("C:/main/.git/refs/heads/x")],
            &p("C:/wt"),
            &[p("C:/main/.git/worktrees/wt"), p("C:/main/.git")],
        );
        assert!(c.refs);
    }
}
