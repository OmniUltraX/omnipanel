use std::path::PathBuf;

/// 开发态：优先 `src-tauri/../agent`，其次同级独立仓库 `../../omniagent`（D:/project/omniagent）。
/// 发布构建未 bundle agent 时作为 Node 子进程回退路径。
pub fn resolve_repo_agent_dir() -> Option<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for relative in ["../agent", "../../omniagent"] {
        let agent_dir = manifest.join(relative);
        if agent_dir.join("index.ts").exists() {
            return agent_dir.canonicalize().ok();
        }
    }
    None
}

/// 发布态：Tauri resource 目录下的 `agent/`。
pub fn resolve_bundled_agent_dir(resource_dir: &PathBuf) -> Option<PathBuf> {
    let bundled = resource_dir.join("agent");
    if bundled.join("index.ts").exists() {
        bundled.canonicalize().ok()
    } else {
        None
    }
}
