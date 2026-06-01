mod ssh_stats;

use std::sync::Arc;

use serde::Deserialize;
use tokio::sync::Mutex;
use tracing::error;

use omnipanel_ssh::SshSession;

/// Single command definition in task config
#[derive(Debug, Deserialize, Clone)]
pub struct TaskCommand {
    #[allow(dead_code)]
    pub id: String,
    #[allow(dead_code)]
    pub cmd: String,
    #[allow(dead_code)]
    pub parser: String,
}

/// Task definition from tasks.toml
#[derive(Debug, Deserialize, Clone)]
pub struct TaskDef {
    pub id: String,
    pub enabled: bool,
    #[allow(dead_code)]
    pub description: String,
    pub interval_secs: u64,
    #[allow(dead_code)]
    pub commands: Vec<TaskCommand>,
}

/// Root config structure matching tasks.toml
#[derive(Debug, Deserialize)]
struct TasksConfig {
    #[allow(dead_code)]
    scheduler: Option<SchedulerConfig>,
    tasks: Vec<TaskDef>,
}

#[derive(Debug, Deserialize)]
struct SchedulerConfig {
    #[allow(dead_code)]
    default_interval_secs: Option<u64>,
}

/// Background scheduler: reads task config and spawns tokio tasks
pub struct BackgroundScheduler;

impl BackgroundScheduler {
    pub fn load_config() -> Vec<TaskDef> {
        let config_str = include_str!("tasks.toml");
        match toml::from_str::<TasksConfig>(config_str) {
            Ok(cfg) => cfg.tasks,
            Err(e) => {
                error!("Failed to parse tasks.toml: {e}");
                vec![]
            }
        }
    }

    pub fn start(
        ssh_sessions: Arc<Mutex<std::collections::HashMap<String, SshSession>>>,
        app_handle: tauri::AppHandle,
    ) {
        let tasks = Self::load_config();
        for task in tasks {
            if !task.enabled {
                continue;
            }
            let app = app_handle.clone();
            let sessions = ssh_sessions.clone();
            tauri::async_runtime::spawn(async move {
                Self::run_task_loop(task, sessions, app).await;
            });
        }
        tracing::info!("Background scheduler started");
    }

    async fn run_task_loop(
        task: TaskDef,
        ssh_sessions: Arc<Mutex<std::collections::HashMap<String, SshSession>>>,
        app_handle: tauri::AppHandle,
    ) {
        let interval = tokio::time::Duration::from_secs(task.interval_secs.max(1));
        loop {
            tokio::time::sleep(interval).await;
            match task.id.as_str() {
                "ssh_system_stats" => {
                    let sessions = ssh_sessions.lock().await;
                    ssh_stats::collect_all(&sessions, &app_handle).await;
                }
                _ => {}
            }
        }
    }
}
