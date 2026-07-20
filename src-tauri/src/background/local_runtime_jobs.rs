//! Ollama 安装 / 模型拉取后台任务。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::AppHandle;

use crate::commands::local_runtime::{
    install_ollama_with_progress, pull_ollama_with_progress,
};

type ProgressCb = Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>;

pub async fn run_ollama_install_background(
    _app: AppHandle,
    _task_id: String,
    cancel: Arc<AtomicBool>,
    progress: ProgressCb,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Ok(());
    }
    progress(
        "开始安装 Ollama…".into(),
        0,
        100,
        None,
        None,
    );
    let result = install_ollama_with_progress(cancel.clone(), progress.clone()).await;
    if cancel.load(Ordering::Relaxed) {
        return Ok(());
    }
    match result {
        Ok(msg) => {
            progress(msg, 100, 100, None, None);
            Ok(())
        }
        Err(e) => Err(e),
    }
}

pub async fn run_ollama_pull_background(
    _app: AppHandle,
    _task_id: String,
    model: String,
    cancel: Arc<AtomicBool>,
    progress: ProgressCb,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Ok(());
    }
    let model = model.trim().to_string();
    progress(
        format!("准备拉取 {model}…"),
        0,
        100,
        None,
        None,
    );
    pull_ollama_with_progress(model, cancel, progress).await
}
