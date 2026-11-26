#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod git;
mod watch;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct Watchers(Mutex<HashMap<u32, notify::RecommendedWatcher>>);

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Runs git off the UI thread. Exit code is returned, not treated as an error: callers decide.
#[tauri::command]
async fn run_git(
    repo: String,
    args: Vec<String>,
    stdin: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<git::GitOutput, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git::run(&repo, &args, stdin.as_deref(), &env.unwrap_or_default())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn open_repo(path: String) -> Result<git::RepoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || git::open(&path)).await.map_err(err)?
}

#[tauri::command]
fn repo_state(git_dir: String) -> &'static str {
    git::state(Path::new(&git_dir))
}

#[tauri::command]
fn read_file(root: String, path: String) -> Result<String, String> {
    std::fs::read_to_string(git::existing_repo_file(&root, &path)?).map_err(err)
}

#[tauri::command]
fn write_file(root: String, path: String, content: String) -> Result<(), String> {
    std::fs::write(git::existing_repo_file(&root, &path)?, content).map_err(err)
}

/// Writes a scratch file (rebase todo, reword messages) and returns its path with forward slashes,
/// ready to be used inside git's sh-run editor commands.
#[tauri::command]
fn write_temp(name: String, content: String) -> Result<String, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
        return Err("invalid temp file name".into());
    }
    let dir = std::env::temp_dir().join("gitma");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let path = dir.join(name);
    std::fs::write(&path, content).map_err(err)?;
    Ok(path.to_string_lossy().replace('\\', "/"))
}

#[tauri::command]
fn watch_repo(
    app: AppHandle,
    watchers: State<Watchers>,
    id: u32,
    root: String,
    git_dir: String,
    common_dir: String,
) -> Result<(), String> {
    let dirs = vec![PathBuf::from(git_dir), PathBuf::from(common_dir)];
    let w = watch::start(app, id, PathBuf::from(root), dirs).map_err(err)?;
    watchers.0.lock().map_err(err)?.insert(id, w);
    Ok(())
}

#[tauri::command]
fn unwatch_repo(watchers: State<Watchers>, id: u32) -> Result<(), String> {
    watchers.0.lock().map_err(err)?.remove(&id);
    Ok(())
}

/// First non-flag argument: `gitma <folder>` (Explorer menu, MABO, a terminal).
fn path_from_args(args: impl Iterator<Item = String>) -> Option<String> {
    // Explorer passes "C:\" for drive roots as `C:\"`; drop that stray quote.
    args.skip(1).find(|a| !a.starts_with('-')).map(|a| a.trim_end_matches('"').to_string())
}

#[tauri::command]
fn initial_path() -> Option<String> {
    path_from_args(std::env::args())
}

fn main() {
    tauri::Builder::default()
        // Must be first: a second launch opens the folder as a tab in the running window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(path) = path_from_args(argv.into_iter()) {
                // `gitma .` from a terminal: relative to that terminal, not to us.
                let path = Path::new(&cwd).join(path).to_string_lossy().into_owned();
                let _ = app.emit("open-repo", path);
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Watchers::default())
        .invoke_handler(tauri::generate_handler![
            run_git,
            open_repo,
            repo_state,
            read_file,
            write_file,
            write_temp,
            watch_repo,
            unwatch_repo,
            initial_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running GITMA");
}

#[cfg(test)]
mod tests {
    use super::path_from_args;

    #[test]
    fn picks_first_non_flag_arg() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter();
        assert_eq!(path_from_args(args(&["gitma.exe", "C:/repo"])), Some("C:/repo".into()));
        assert_eq!(path_from_args(args(&["gitma.exe", "--flag", "C:/r"])), Some("C:/r".into()));
        assert_eq!(path_from_args(args(&["gitma.exe"])), None);
    }
}
