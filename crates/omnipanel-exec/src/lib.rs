//! 动作执行引擎：统一调度终端/SSH/数据库等动作的执行，流式回流进度并返回退出码。
//!
//! 设计要点：
//! - [`Executor`] 是扩展点（仿 `AiProvider`），各领域实现一个 executor 并注册到 [`ExecutionEngine`]。
//! - 进度通过 [`ProgressSink`] 抽象回调回流，crate 本身不依赖 Tauri；事件桥接由 `src-tauri` 提供。
//! - 审计落库由调用方（`src-tauri`）在拿到结果后写入 `omnipanel-store`，保持 crate 边界清晰。

use std::collections::HashMap;
use std::sync::Arc;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

mod shell;
pub use shell::ShellExecutor;

/// 前端发起的动作请求。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ActionRequest {
    pub id: String,
    /// 动作类型（terminal/docker/server/ssh/sql 等），决定分发到哪个 executor。
    pub kind: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub resource_id: Option<String>,
    #[serde(default)]
    pub env_tag: Option<String>,
    /// 工作目录（本地 shell 类执行可用）。
    #[serde(default)]
    pub cwd: Option<String>,
}

/// 进度流类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ProgressStream {
    Stdout,
    Stderr,
    Status,
}

/// 动作状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ActionStatus {
    Running,
    Completed,
    Failed,
}

/// 单条执行进度，emit 到前端 `action-progress` 事件。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ActionProgress {
    pub action_id: String,
    pub stream: ProgressStream,
    #[serde(default)]
    pub chunk: String,
    #[serde(default)]
    pub status: Option<ActionStatus>,
    #[serde(default)]
    pub exit_code: Option<i32>,
}

impl ActionProgress {
    pub fn output(action_id: &str, stream: ProgressStream, chunk: impl Into<String>) -> Self {
        Self {
            action_id: action_id.to_string(),
            stream,
            chunk: chunk.into(),
            status: None,
            exit_code: None,
        }
    }

    pub fn status(action_id: &str, status: ActionStatus, exit_code: Option<i32>) -> Self {
        Self {
            action_id: action_id.to_string(),
            stream: ProgressStream::Status,
            chunk: String::new(),
            status: Some(status),
            exit_code,
        }
    }
}

/// 进度回调抽象。`src-tauri` 注入「emit 到事件」的实现；测试可注入收集器。
pub type ProgressSink = Arc<dyn Fn(ActionProgress) + Send + Sync>;

/// 动作执行器扩展点。各领域（terminal/ssh/db）实现并注册到引擎。
#[async_trait::async_trait]
pub trait Executor: Send + Sync {
    /// 执行动作，过程中通过 `sink` 回流进度，返回退出码（0 表示成功）。
    async fn execute(&self, action: &ActionRequest, sink: &ProgressSink) -> OmniResult<i32>;
}

/// 执行引擎：按 `action.kind` 分发到已注册的 executor。
#[derive(Default)]
pub struct ExecutionEngine {
    executors: HashMap<String, Arc<dyn Executor>>,
}

impl ExecutionEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册某类动作的 executor。
    pub fn register(&mut self, kind: impl Into<String>, executor: Arc<dyn Executor>) {
        self.executors.insert(kind.into(), executor);
    }

    /// 分发执行。发出 running/completed/failed 状态进度，返回退出码。
    pub async fn execute(&self, action: &ActionRequest, sink: &ProgressSink) -> OmniResult<i32> {
        let executor = self.executors.get(&action.kind).cloned().ok_or_else(|| {
            OmniError::new(
                ErrorCode::InvalidInput,
                format!("暂不支持执行 \"{}\" 类型的动作", action.kind),
            )
        })?;

        sink(ActionProgress::status(
            &action.id,
            ActionStatus::Running,
            None,
        ));

        match executor.execute(action, sink).await {
            Ok(code) => {
                let status = if code == 0 {
                    ActionStatus::Completed
                } else {
                    ActionStatus::Failed
                };
                sink(ActionProgress::status(&action.id, status, Some(code)));
                Ok(code)
            }
            Err(err) => {
                sink(ActionProgress::output(
                    &action.id,
                    ProgressStream::Stderr,
                    err.message.clone(),
                ));
                sink(ActionProgress::status(
                    &action.id,
                    ActionStatus::Failed,
                    None,
                ));
                Err(err)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn collector() -> (ProgressSink, Arc<Mutex<Vec<ActionProgress>>>) {
        let store = Arc::new(Mutex::new(Vec::new()));
        let store2 = store.clone();
        let sink: ProgressSink = Arc::new(move |p| store2.lock().unwrap().push(p));
        (sink, store)
    }

    struct OkExecutor;
    #[async_trait::async_trait]
    impl Executor for OkExecutor {
        async fn execute(&self, action: &ActionRequest, sink: &ProgressSink) -> OmniResult<i32> {
            sink(ActionProgress::output(
                &action.id,
                ProgressStream::Stdout,
                "hello",
            ));
            Ok(0)
        }
    }

    #[tokio::test]
    async fn dispatch_unknown_kind_errors() {
        let engine = ExecutionEngine::new();
        let (sink, _) = collector();
        let req = ActionRequest {
            id: "a".into(),
            kind: "nope".into(),
            command: None,
            resource_id: None,
            env_tag: None,
            cwd: None,
        };
        assert!(engine.execute(&req, &sink).await.is_err());
    }

    #[tokio::test]
    async fn dispatch_emits_status_and_output() {
        let mut engine = ExecutionEngine::new();
        engine.register("terminal", Arc::new(OkExecutor));
        let (sink, store) = collector();
        let req = ActionRequest {
            id: "a".into(),
            kind: "terminal".into(),
            command: Some("noop".into()),
            resource_id: None,
            env_tag: None,
            cwd: None,
        };
        let code = engine.execute(&req, &sink).await.unwrap();
        assert_eq!(code, 0);

        let events = store.lock().unwrap();
        // running -> stdout(hello) -> completed
        assert!(matches!(
            events.first().unwrap().status,
            Some(ActionStatus::Running)
        ));
        assert!(events.iter().any(|e| e.chunk == "hello"));
        assert!(matches!(
            events.last().unwrap().status,
            Some(ActionStatus::Completed)
        ));
    }
}
