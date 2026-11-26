use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Serialize)]
pub struct GitOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub root: String,
    pub git_dir: String,
    pub common_dir: String,
}

/// A `git` process that never pops a console window, never blocks on a prompt or editor,
/// and never takes optional locks (so our own reads don't touch the index and re-trigger the watcher).
pub fn command(cwd: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd)
        // Pin config that would change output we parse or make our own reads write into .git.
        .args([
            "-c", "core.quotepath=false",
            "-c", "color.ui=false",
            "-c", "log.showSignature=false",
            "-c", "core.fsmonitor=false",
            "-c", "diff.noprefix=false",
            "-c", "diff.mnemonicPrefix=false",
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_EDITOR", "true")
        .env("LC_ALL", "C");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

pub fn run(repo: &str, args: &[String], stdin: Option<&str>, env: &HashMap<String, String>) -> Result<GitOutput, String> {
    let mut cmd = command(Path::new(repo));
    cmd.args(args)
        .envs(env)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("could not start git: {e}"))?;
    if let Some(input) = stdin {
        let mut pipe = child.stdin.take().ok_or("no stdin")?;
        let input = input.to_owned();
        // Write from a thread so a large patch can't deadlock against a full stdout pipe.
        std::thread::spawn(move || {
            let _ = pipe.write_all(input.as_bytes());
        });
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(GitOutput {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

pub fn open(path: &str) -> Result<RepoInfo, String> {
    let args: Vec<String> = ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]
        .map(String::from)
        .to_vec();
    let out = run(path, &args, None, &HashMap::new())?;
    if out.code != 0 {
        let why = out.stderr.trim();
        return Err(if why.is_empty() { format!("Not a git repository: {path}") } else { why.to_string() });
    }
    let mut lines = out.stdout.lines();
    let mut next = || lines.next().map(str::to_owned).ok_or_else(|| "unexpected rev-parse output".to_string());
    Ok(RepoInfo { root: next()?, git_dir: next()?, common_dir: next()? })
}

/// Which multi-step operation is in progress, if any.
pub fn state(git_dir: &Path) -> &'static str {
    let has = |p: &str| git_dir.join(p).exists();
    if has("rebase-merge") || has("rebase-apply") {
        "rebase"
    } else if has("MERGE_HEAD") {
        "merge"
    } else if has("CHERRY_PICK_HEAD") {
        "cherry-pick"
    } else if has("REVERT_HEAD") {
        "revert"
    } else {
        ""
    }
}

/// Resolves an existing repo file, refusing anything outside the repo — including via symlinks/junctions.
pub fn existing_repo_file(root: &str, rel: &str) -> Result<PathBuf, String> {
    let path = repo_path(root, rel)?;
    let real = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let real_root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    if !real.starts_with(&real_root) {
        return Err(format!("path outside repository: {rel}"));
    }
    Ok(real)
}

/// Joins a repo-relative path, refusing anything that could escape the repo (`..`, absolute, drive).
pub fn repo_path(root: &str, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    let safe = !rel.is_empty()
        && rel_path.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if !safe {
        return Err(format!("path outside repository: {rel}"));
    }
    Ok(Path::new(root).join(rel_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_path_rejects_escapes() {
        assert!(repo_path("C:/r", "src/a.rs").is_ok());
        assert!(repo_path("C:/r", "../x").is_err());
        assert!(repo_path("C:/r", "a/../../x").is_err());
        assert!(repo_path("C:/r", "C:/Windows/x").is_err());
        assert!(repo_path("C:/r", "/etc/passwd").is_err());
        assert!(repo_path("C:/r", "").is_err());
    }
}
