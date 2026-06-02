use std::sync::Arc;
use serde::Serialize;
use tokio::sync::Mutex;

/// 单条后台日志
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub timestamp: String,
    pub module: String,
    pub level: String,
    pub message: String,
}

/// 内存环形缓冲：所有后台模块共享，前端通过 IPC 拉取。
#[derive(Clone)]
pub struct LogStore {
    entries: Arc<Mutex<Vec<LogEntry>>>,
    max: usize,
}

impl LogStore {
    pub fn new(max: usize) -> Self {
        Self {
            entries: Arc::new(Mutex::new(Vec::with_capacity(max + 1))),
            max,
        }
    }

    pub async fn log(&self, module: &str, level: &str, message: &str) {
        let mut entries = self.entries.lock().await;
        let entry = LogEntry {
            timestamp: format_ts(),
            module: module.to_string(),
            level: level.to_string(),
            message: message.to_string(),
        };
        if entries.len() >= self.max {
            entries.remove(0);
        }
        entries.push(entry);
    }

    pub async fn get_all(&self) -> Vec<LogEntry> {
        self.entries.lock().await.clone()
    }

    pub async fn clear(&self) {
        self.entries.lock().await.clear();
    }
}

fn format_ts() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let h = (d / 3600) % 24;
    let m = (d / 60) % 60;
    let s = d % 60;
    format!("{h:02}:{m:02}:{s:02}")
}
