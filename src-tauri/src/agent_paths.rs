use std::path::PathBuf;

/// 开发态：`src-tauri/../agent`（git submodule OmniAgent）。
pub fn resolve_repo_agent_dir() -> Option<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let agent_dir = manifest.join("../agent");
    if agent_dir.join("index.ts").exists() {
        return agent_dir.canonicalize().ok();
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
