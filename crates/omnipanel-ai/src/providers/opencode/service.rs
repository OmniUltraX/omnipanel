use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;

use super::client::{OpenCodeClient, OpenCodeModel};

const DEFAULT_PORT: u16 = 4096;
const DEFAULT_HOST: &str = "127.0.0.1";

#[derive(Debug, Clone)]
pub struct OpenCodeEndpoint {
    pub base_url: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
struct ServiceFile {
    password: String,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    hostname: Option<String>,
}

struct ServiceState {
    child: Option<Child>,
    endpoint: Option<OpenCodeEndpoint>,
}

static SERVICE: Mutex<ServiceState> = Mutex::new(ServiceState {
    child: None,
    endpoint: None,
});

fn with_service<R>(f: impl FnOnce(&mut ServiceState) -> R) -> Result<R, String> {
    let mut guard = SERVICE.lock().map_err(|e| e.to_string())?;
    Ok(f(&mut guard))
}

fn cached_endpoint() -> Option<OpenCodeEndpoint> {
    with_service(|s| s.endpoint.clone()).ok().flatten()
}

fn store_endpoint(ep: OpenCodeEndpoint) {
    let _ = with_service(|s| {
        s.endpoint = Some(ep);
    });
}

fn store_child(child: Child) {
    let _ = with_service(|s| {
        if let Some(mut old) = s.child.take() {
            let _ = old.kill();
        }
        s.child = Some(child);
    });
}

fn config_dir() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("OPENCODE_CONFIG_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let home = dirs_home_dir().ok_or_else(|| "无法解析用户主目录".to_string())?;
    Ok(home.join(".config").join("opencode"))
}

fn dirs_home_dir() -> Option<PathBuf> {
    if let Ok(h) = std::env::var("USERPROFILE") {
        if !h.trim().is_empty() {
            return Some(PathBuf::from(h));
        }
    }
    if let Ok(h) = std::env::var("HOME") {
        if !h.trim().is_empty() {
            return Some(PathBuf::from(h));
        }
    }
    None
}

fn service_json_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("service.json"))
}

fn read_service_file() -> Result<ServiceFile, String> {
    let path = service_json_path()?;
    if !path.is_file() {
        return Err(format!(
            "未找到 OpenCode service.json（{}）；请先运行 `opencode serve`",
            path.display()
        ));
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取 service.json 失败: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("解析 service.json 失败: {e}"))
}

fn endpoint_from_service(file: &ServiceFile) -> OpenCodeEndpoint {
    let host = file
        .hostname
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_HOST);
    let port = file.port.unwrap_or(DEFAULT_PORT);
    OpenCodeEndpoint {
        base_url: format!("http://{host}:{port}"),
        password: file.password.clone(),
    }
}

async fn probe(endpoint: &OpenCodeEndpoint) -> bool {
    OpenCodeClient::new(endpoint.clone()).health_ok().await
}

fn spawn_serve(binary: &Path, port: u16) -> Result<Child, String> {
    let mut cmd = Command::new(binary);
    cmd.args([
        "serve",
        "--hostname",
        DEFAULT_HOST,
        "--port",
        &port.to_string(),
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .map_err(|e| format!("启动 `opencode serve` 失败（{}）: {e}", binary.display()))
}

/// 确保本机 OpenCode HTTP 服务可用；必要时用 `binary` 拉起 `opencode serve`。
pub async fn ensure_opencode_service(binary: Option<&Path>) -> Result<OpenCodeEndpoint, String> {
    if let Some(ep) = cached_endpoint() {
        if probe(&ep).await {
            return Ok(ep);
        }
    }

    // 尝试读已有 service.json（用户可能已手动 serve）
    if let Ok(file) = read_service_file() {
        let ep = endpoint_from_service(&file);
        if probe(&ep).await {
            store_endpoint(ep.clone());
            return Ok(ep);
        }
    }

    let binary = binary.ok_or_else(|| {
        "OpenCode 未安装或未找到可执行文件，无法拉起 `opencode serve`".to_string()
    })?;
    if !binary.is_file() {
        return Err(format!("OpenCode 二进制不存在: {}", binary.display()));
    }

    let child = spawn_serve(binary, DEFAULT_PORT)?;
    store_child(child);

    // 等待 service.json 写出 + 健康
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(file) = read_service_file() {
            let ep = endpoint_from_service(&file);
            if probe(&ep).await {
                store_endpoint(ep.clone());
                return Ok(ep);
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err("等待 OpenCode serve 就绪超时（20s）".to_string());
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

/// 列出 OpenCode 模型（自动 ensure 服务）。
/// 返回缓存条目：`{providerID}/{modelID}\\u{1f}{displayName}`。
pub async fn list_opencode_models(binary: Option<&Path>) -> Result<Vec<String>, String> {
    let endpoint = ensure_opencode_service(binary).await?;
    let client = OpenCodeClient::new(endpoint);
    let models = client.list_models().await?;
    Ok(models.into_iter().map(|m| m.cache_entry()).collect())
}

#[allow(dead_code)]
pub async fn list_opencode_model_infos(
    binary: Option<&Path>,
) -> Result<Vec<OpenCodeModel>, String> {
    let endpoint = ensure_opencode_service(binary).await?;
    OpenCodeClient::new(endpoint).list_models().await
}
