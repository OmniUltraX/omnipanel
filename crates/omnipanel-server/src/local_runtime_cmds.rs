//! 本地模型运行时管理（Web IPC）：Ollama 探测 / 授权安装 / 模型拉取删除 / LM Studio 探测。
//!
//! 自 `src-tauri/src/commands/local_runtime.rs` 移植，去除 Tauri / specta 依赖。

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use sysinfo::System;
use tokio::process::Command;

const OLLAMA_HOST: &str = "http://127.0.0.1:11434";
const OLLAMA_OPENAI_BASE: &str = "http://127.0.0.1:11434/v1";
const LMSTUDIO_OPENAI_BASE: &str = "http://127.0.0.1:1234/v1";
const OLLAMA_DOWNLOAD_URL: &str = "https://ollama.com/download";
#[cfg(target_os = "windows")]
const OLLAMA_WINDOWS_SETUP_URL: &str = "https://ollama.com/download/OllamaSetup.exe";

pub type ProgressCb = Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>;

fn report(progress: &ProgressCb, message: impl Into<String>, index: u32, total: u32) {
    progress(message.into(), index, total, None, None);
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))
}

fn long_http_client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(3600))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))
}

/// 运行时状态。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LocalRuntimeStatus {
    NotInstalled,
    InstalledNotRunning,
    Running,
}

/// 已安装模型摘要。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelInfo {
    pub name: String,
    pub size_bytes: u64,
    pub digest: String,
    pub family: String,
}

/// Ollama 探测结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaProbeResult {
    pub status: LocalRuntimeStatus,
    pub endpoint: String,
    pub openai_base_url: String,
    pub version: Option<String>,
    pub cli_path: Option<String>,
    pub models: Vec<LocalModelInfo>,
    pub error: Option<String>,
}

/// LM Studio / 自定义端点探测。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiCompatProbeResult {
    pub reachable: bool,
    pub endpoint: String,
    pub models: Vec<String>,
    pub error: Option<String>,
}

/// 聚合探测。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRuntimeProbeResult {
    pub ollama: OllamaProbeResult,
    pub lm_studio: OpenAiCompatProbeResult,
    pub hardware: ollama_recommend::LocalHardwareInfo,
    /// 系统内存 MB（兼容旧字段）
    pub total_memory_mb: u64,
    pub hardware_tier: String,
    pub recommended_models: Vec<ollama_recommend::RecommendedModel>,
    /// 推荐清单来源说明
    pub catalog_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRuntimeInstallResult {
    pub method: String,
    pub started: bool,
    pub message: String,
    pub manual_url: String,
}

#[cfg(windows)]
fn hide_console(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut std::process::Command) {}

#[cfg(windows)]
fn hide_console_tokio(cmd: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_tokio(_cmd: &mut Command) {}

fn find_ollama_cli() -> Option<String> {
    let candidates: Vec<PathBuf> = if cfg!(windows) {
        let mut list = Vec::new();
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            list.push(PathBuf::from(local).join("Programs").join("Ollama").join("ollama.exe"));
        }
        if let Ok(user) = std::env::var("USERPROFILE") {
            list.push(
                PathBuf::from(user)
                    .join("AppData")
                    .join("Local")
                    .join("Programs")
                    .join("Ollama")
                    .join("ollama.exe"),
            );
        }
        list.push(PathBuf::from(r"C:\Program Files\Ollama\ollama.exe"));
        list
    } else if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/usr/local/bin/ollama"),
            PathBuf::from("/opt/homebrew/bin/ollama"),
            PathBuf::from("/Applications/Ollama.app/Contents/Resources/ollama"),
        ]
    } else {
        vec![
            PathBuf::from("/usr/local/bin/ollama"),
            PathBuf::from("/usr/bin/ollama"),
            PathBuf::from(format!(
                "{}/.local/bin/ollama",
                std::env::var("HOME").unwrap_or_default()
            )),
        ]
    };

    if let Some(found) = candidates
        .into_iter()
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
    {
        return Some(found);
    }

    let mut cmd = std::process::Command::new(if cfg!(windows) { "where" } else { "which" });
    hide_console(&mut cmd);
    if let Ok(output) = cmd.arg("ollama").output() {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = text.lines().next() {
                let p = line.trim();
                if !p.is_empty() && PathBuf::from(p).exists() {
                    return Some(p.to_string());
                }
            }
        }
    }
    None
}

async fn fetch_ollama_version(client: &Client) -> Option<String> {
    let resp = client
        .get(format!("{OLLAMA_HOST}/api/version"))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: serde_json::Value = resp.json().await.ok()?;
    v.get("version")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

async fn fetch_ollama_models(client: &Client) -> Result<Vec<LocalModelInfo>, String> {
    #[derive(Deserialize)]
    struct TagsResponse {
        models: Option<Vec<TagModel>>,
    }
    #[derive(Deserialize)]
    struct TagModel {
        name: String,
        size: Option<u64>,
        digest: Option<String>,
        details: Option<TagDetails>,
    }
    #[derive(Deserialize)]
    struct TagDetails {
        family: Option<String>,
    }

    let resp = client
        .get(format!("{OLLAMA_HOST}/api/tags"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("api/tags HTTP {}", resp.status()));
    }
    let parsed: TagsResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(parsed
        .models
        .unwrap_or_default()
        .into_iter()
        .map(|m| LocalModelInfo {
            name: m.name,
            size_bytes: m.size.unwrap_or(0),
            digest: m.digest.unwrap_or_default(),
            family: m.details.and_then(|d| d.family).unwrap_or_default(),
        })
        .collect())
}

async fn probe_ollama() -> OllamaProbeResult {
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => {
            let cli_path = find_ollama_cli();
            return OllamaProbeResult {
                status: if cli_path.is_some() {
                    LocalRuntimeStatus::InstalledNotRunning
                } else {
                    LocalRuntimeStatus::NotInstalled
                },
                endpoint: OLLAMA_HOST.into(),
                openai_base_url: OLLAMA_OPENAI_BASE.into(),
                version: None,
                cli_path,
                models: vec![],
                error: Some(e),
            };
        }
    };

    match fetch_ollama_models(&client).await {
        Ok(models) => {
            let version = fetch_ollama_version(&client).await;
            OllamaProbeResult {
                status: LocalRuntimeStatus::Running,
                endpoint: OLLAMA_HOST.into(),
                openai_base_url: OLLAMA_OPENAI_BASE.into(),
                version,
                cli_path: None,
                models,
                error: None,
            }
        }
        Err(e) => {
            let cli_path = find_ollama_cli();
            let status = if cli_path.is_some() {
                LocalRuntimeStatus::InstalledNotRunning
            } else {
                LocalRuntimeStatus::NotInstalled
            };
            OllamaProbeResult {
                status,
                endpoint: OLLAMA_HOST.into(),
                openai_base_url: OLLAMA_OPENAI_BASE.into(),
                version: None,
                cli_path,
                models: vec![],
                error: Some(e),
            }
        }
    }
}

async fn probe_openai_compat(base: &str) -> OpenAiCompatProbeResult {
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => {
            return OpenAiCompatProbeResult {
                reachable: false,
                endpoint: base.into(),
                models: vec![],
                error: Some(e),
            };
        }
    };
    let url = format!("{}/models", base.trim_end_matches('/'));
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            #[derive(Deserialize)]
            struct ModelsResp {
                data: Option<Vec<ModelItem>>,
            }
            #[derive(Deserialize)]
            struct ModelItem {
                id: String,
            }
            let parsed: ModelsResp = resp.json().await.unwrap_or(ModelsResp { data: None });
            let models = parsed
                .data
                .unwrap_or_default()
                .into_iter()
                .map(|m| m.id)
                .collect();
            OpenAiCompatProbeResult {
                reachable: true,
                endpoint: base.into(),
                models,
                error: None,
            }
        }
        Ok(resp) => OpenAiCompatProbeResult {
            reachable: false,
            endpoint: base.into(),
            models: vec![],
            error: Some(format!("HTTP {}", resp.status())),
        },
        Err(e) => OpenAiCompatProbeResult {
            reachable: false,
            endpoint: base.into(),
            models: vec![],
            error: Some(e.to_string()),
        },
    }
}

fn system_memory_mb() -> u64 {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.total_memory() / (1024 * 1024)
}

/// 探测本机本地运行时（Ollama + LM Studio）与硬件推荐。
pub async fn local_runtime_probe() -> Result<LocalRuntimeProbeResult, String> {
    let total_memory_mb = system_memory_mb();
    let hardware = ollama_recommend::probe_hardware(total_memory_mb);
    let (recommended_models, catalog_source) =
        ollama_recommend::build_recommendations(&hardware, false).await;
    let ollama = probe_ollama().await;
    let lm_studio = probe_openai_compat(LMSTUDIO_OPENAI_BASE).await;
    Ok(LocalRuntimeProbeResult {
        ollama,
        lm_studio,
        hardware_tier: hardware.hardware_tier.clone(),
        total_memory_mb,
        hardware,
        recommended_models,
        catalog_source,
    })
}

/// 强制刷新 ollama.com/library 缓存并返回最新推荐。
pub async fn local_runtime_refresh_catalog() -> Result<LocalRuntimeProbeResult, String> {
    let total_memory_mb = system_memory_mb();
    let hardware = ollama_recommend::probe_hardware(total_memory_mb);
    let (recommended_models, catalog_source) =
        ollama_recommend::build_recommendations(&hardware, true).await;
    let ollama = probe_ollama().await;
    let lm_studio = probe_openai_compat(LMSTUDIO_OPENAI_BASE).await;
    Ok(LocalRuntimeProbeResult {
        ollama,
        lm_studio,
        hardware_tier: hardware.hardware_tier.clone(),
        total_memory_mb,
        hardware,
        recommended_models,
        catalog_source,
    })
}

/// 尝试启动已安装的 Ollama（`ollama serve` 后台）。
pub async fn local_runtime_start_ollama() -> Result<bool, String> {
    let cli = find_ollama_cli().ok_or_else(|| "未找到 ollama 可执行文件".to_string())?;
    if let Ok(client) = http_client() {
        if fetch_ollama_models(&client).await.is_ok() {
            return Ok(true);
        }
    }
    let mut serve = Command::new(&cli);
    hide_console_tokio(&mut serve);
    serve
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动 ollama serve 失败: {e}"))?;

    let client = http_client()?;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if fetch_ollama_models(&client).await.is_ok() {
            return Ok(true);
        }
    }
    Err("已启动 ollama，但服务尚未就绪，请稍后重试".into())
}

#[cfg(target_os = "windows")]
async fn winget_available() -> bool {
    let mut cmd = Command::new("winget");
    hide_console_tokio(&mut cmd);
    cmd.arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// 用户确认后安装 Ollama（Win 优先 winget，否则下载官方安装包并拉起）。
/// 供后台任务与兼容命令共用；返回最终说明文案。
pub async fn install_ollama_with_progress(
    cancel: Arc<AtomicBool>,
    progress: ProgressCb,
) -> Result<String, String> {
    report(&progress, "开始安装 Ollama…", 5, 100);

    #[cfg(target_os = "windows")]
    {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        if winget_available().await {
            report(&progress, "正在通过 winget 安装 Ollama.Ollama…", 20, 100);
            let mut winget = Command::new("winget");
            hide_console_tokio(&mut winget);
            let status = winget
                .args([
                    "install",
                    "-e",
                    "--id",
                    "Ollama.Ollama",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                ])
                .status()
                .await
                .map_err(|e| format!("执行 winget 失败: {e}"))?;
            if cancel.load(Ordering::Relaxed) {
                return Err("已取消".into());
            }
            if status.success() {
                report(&progress, "winget 安装完成，正在启动服务…", 85, 100);
                let _ = local_runtime_start_ollama().await;
                report(&progress, "已通过 winget 安装 Ollama", 100, 100);
                return Ok("已通过 winget 安装 Ollama".into());
            }
            report(
                &progress,
                "winget 安装未成功，改用官方安装包…",
                35,
                100,
            );
        }

        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        report(&progress, "正在下载 OllamaSetup.exe…", 45, 100);
        let client = long_http_client()?;
        let bytes = client
            .get(OLLAMA_WINDOWS_SETUP_URL)
            .send()
            .await
            .map_err(|e| format!("下载失败: {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("读取下载内容失败: {e}"))?;
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        let path = std::env::temp_dir().join("OllamaSetup.exe");
        tokio::fs::write(&path, &bytes)
            .await
            .map_err(|e| format!("写入安装包失败: {e}"))?;
        report(&progress, "正在打开官方安装程序…", 90, 100);
        Command::new(&path)
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {e}"))?;
        let msg = "已启动 OllamaSetup.exe，请完成安装向导后点击「重新探测」";
        report(&progress, msg, 100, 100);
        return Ok(msg.into());
    }

    #[cfg(target_os = "macos")]
    {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        report(&progress, "正在通过官方脚本安装 Ollama…", 30, 100);
        let status = Command::new("sh")
            .args(["-c", "curl -fsSL https://ollama.com/install.sh | sh"])
            .status()
            .await
            .map_err(|e| format!("执行安装脚本失败: {e}"))?;
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        if status.success() {
            report(&progress, "安装完成，正在启动服务…", 85, 100);
            let _ = local_runtime_start_ollama().await;
            report(&progress, "已通过官方脚本安装 Ollama", 100, 100);
            return Ok("已通过官方脚本安装 Ollama".into());
        }
        return Err(format!(
            "安装失败（退出码 {:?}）。请手动访问 {OLLAMA_DOWNLOAD_URL}",
            status.code()
        ));
    }

    #[cfg(target_os = "linux")]
    {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        report(&progress, "正在通过官方脚本安装 Ollama…", 30, 100);
        let status = Command::new("sh")
            .args(["-c", "curl -fsSL https://ollama.com/install.sh | sh"])
            .status()
            .await
            .map_err(|e| format!("执行安装脚本失败: {e}"))?;
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        if status.success() {
            report(&progress, "安装完成，正在启动服务…", 85, 100);
            let _ = local_runtime_start_ollama().await;
            report(&progress, "已通过官方脚本安装 Ollama", 100, 100);
            return Ok("已通过官方脚本安装 Ollama".into());
        }
        return Err(format!(
            "安装失败（退出码 {:?}）。请手动访问 {OLLAMA_DOWNLOAD_URL}",
            status.code()
        ));
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (cancel, progress);
        Err(format!("当前平台暂不支持自动安装，请访问 {OLLAMA_DOWNLOAD_URL}"))
    }
}

/// 用户确认后安装 Ollama（兼容同步命令；进度走后台任务更佳）。
pub async fn local_runtime_install_ollama() -> Result<LocalRuntimeInstallResult, String> {
    let progress: ProgressCb = Arc::new(|_, _, _, _, _| {});
    let cancel = Arc::new(AtomicBool::new(false));
    let message = install_ollama_with_progress(cancel, progress).await?;
    Ok(LocalRuntimeInstallResult {
        method: "auto".into(),
        started: true,
        message,
        manual_url: OLLAMA_DOWNLOAD_URL.into(),
    })
}

/// 拉取模型（带后台任务进度）。
pub async fn pull_ollama_with_progress(
    model: String,
    cancel: Arc<AtomicBool>,
    progress: ProgressCb,
) -> Result<(), String> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("模型名不能为空".into());
    }
    let client = long_http_client()?;
    report(&progress, format!("请求拉取 {model}…"), 1, 100);
    let resp = client
        .post(format!("{OLLAMA_HOST}/api/pull"))
        .json(&serde_json::json!({ "name": model, "stream": true }))
        .send()
        .await
        .map_err(|e| format!("请求 pull 失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("pull 失败 {status}: {body}"));
    }

    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    let mut buffer = String::new();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        let chunk = chunk.map_err(|e| format!("读取 pull 流失败: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(idx) = buffer.find('\n') {
            let line = buffer[..idx].trim().to_string();
            buffer = buffer[idx + 1..].to_string();
            if line.is_empty() {
                continue;
            }
            let v: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
            let status = v
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let completed = v.get("completed").and_then(|x| x.as_u64()).unwrap_or(0);
            let total = v.get("total").and_then(|x| x.as_u64()).unwrap_or(0);
            let error = v
                .get("error")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            if let Some(err) = error {
                return Err(err);
            }
            let pct = if total > 0 {
                ((completed as f64 / total as f64) * 100.0).round() as u32
            } else if status == "success" {
                100
            } else {
                5
            };
            let pct = pct.min(99);
            let msg = if total > 0 {
                format!(
                    "拉取 {model}：{status}（{}/{}）",
                    format_bytes_u64(completed),
                    format_bytes_u64(total)
                )
            } else {
                format!("拉取 {model}：{status}")
            };
            report(&progress, msg, pct, 100);
            if status == "success" {
                report(&progress, format!("已拉取 {model}"), 100, 100);
                return Ok(());
            }
        }
    }
    report(&progress, format!("已拉取 {model}"), 100, 100);
    Ok(())
}

fn format_bytes_u64(bytes: u64) -> String {
    if bytes == 0 {
        return "0 B".into();
    }
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut n = bytes as f64;
    let mut i = 0usize;
    while n >= 1024.0 && i < UNITS.len() - 1 {
        n /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{bytes} {}", UNITS[i])
    } else {
        format!("{n:.1} {}", UNITS[i])
    }
}

/// 拉取模型（兼容同步命令）。
pub async fn local_runtime_ollama_pull(model: String) -> Result<(), String> {
    let progress: ProgressCb = Arc::new(|_, _, _, _, _| {});
    let cancel = Arc::new(AtomicBool::new(false));
    pull_ollama_with_progress(model, cancel, progress).await
}

/// 删除本地 Ollama 模型。
pub async fn local_runtime_ollama_delete(model: String) -> Result<(), String> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("模型名不能为空".into());
    }
    let client = http_client()?;
    let resp = client
        .post(format!("{OLLAMA_HOST}/api/delete"))
        .json(&serde_json::json!({ "name": model }))
        .send()
        .await
        .map_err(|e| format!("删除请求失败: {e}"))?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("删除失败: {body}"));
    }
    Ok(())
}

/// 探测任意 OpenAI 兼容本地端点。
pub async fn local_runtime_probe_openai_compat(
    base_url: String,
) -> Result<OpenAiCompatProbeResult, String> {
    let base = base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("base_url 不能为空".into());
    }
    Ok(probe_openai_compat(&base).await)
}

/// 返回官方下载页 URL（供前端打开）。
pub async fn local_runtime_ollama_download_url() -> Result<String, String> {
    Ok(OLLAMA_DOWNLOAD_URL.into())
}

/// 本地模型推荐（自 `src-tauri/commands/ollama_recommend.rs` 精简移植，依赖 `ollama_catalog`）。
pub mod ollama_recommend {
    use serde::{Deserialize, Serialize};

    use super::ollama_catalog::{
        catalog_source_label, load_library_catalog, LibraryModelEntry,
    };

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct LocalHardwareInfo {
        pub total_memory_mb: u64,
        pub vram_mb: u64,
        pub has_discrete_gpu: bool,
        pub gpu_name: Option<String>,
        pub hardware_tier: String,
        pub quant_pref: String,
        pub max_param_b: f64,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RecommendedModel {
        pub name: String,
        pub scenario: String,
        pub kind: String,
        pub approx_size_gb: f64,
        pub description: String,
        pub tier: String,
        pub quant_hint: String,
        pub pulls: Option<u64>,
        pub from_library: bool,
    }

    pub fn probe_hardware(total_memory_mb: u64) -> LocalHardwareInfo {
        let (quant_pref, max_param_b, tier) = recommend_quant_and_size(total_memory_mb, 0, false);
        LocalHardwareInfo {
            total_memory_mb,
            vram_mb: 0,
            has_discrete_gpu: false,
            gpu_name: None,
            hardware_tier: tier.into(),
            quant_pref: quant_pref.into(),
            max_param_b,
        }
    }

    fn recommend_quant_and_size(
        ram_mb: u64,
        vram_mb: u64,
        has_discrete: bool,
    ) -> (&'static str, f64, &'static str) {
        let budget_mb = if has_discrete && vram_mb > 0 {
            vram_mb
        } else if vram_mb > 0 {
            vram_mb.min(ram_mb / 2)
        } else {
            ram_mb / 2
        };
        let max_param_b = (budget_mb as f64 / 1024.0) / 0.7;
        let (quant, tier) = if budget_mb >= 24 * 1024 {
            ("Q5_K_M", "strong")
        } else if budget_mb >= 12 * 1024 {
            ("Q4_K_M", "strong")
        } else if budget_mb >= 6 * 1024 {
            ("Q4_K_M", "balanced")
        } else {
            ("Q4_K_M", "entry")
        };
        (quant, max_param_b.max(1.0), tier)
    }

    fn parse_size_tag_b(tag: &str) -> Option<f64> {
        let t = tag.trim().to_lowercase();
        t.strip_suffix('b')?.parse::<f64>().ok()
    }

    fn size_tags(entry: &LibraryModelEntry) -> Vec<f64> {
        let mut sizes: Vec<f64> = entry
            .tags
            .iter()
            .filter_map(|t| parse_size_tag_b(t))
            .collect();
        sizes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        sizes.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
        sizes
    }

    fn format_size_tag(b: f64) -> String {
        if (b - b.round()).abs() < 1e-6 {
            format!("{}b", b as u64)
        } else {
            format!("{b}b")
        }
    }

    fn pick_size_tag(entry: &LibraryModelEntry, max_param_b: f64) -> Option<String> {
        let sizes = size_tags(entry);
        if sizes.is_empty() {
            return None;
        }
        let fit = sizes
            .iter()
            .copied()
            .filter(|s| *s <= max_param_b * 1.05)
            .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        Some(format_size_tag(fit.unwrap_or(sizes[0])))
    }

    fn approx_gb_for(param_b: f64, quant: &str) -> f64 {
        let factor = match quant {
            "Q8_0" => 1.05,
            "Q5_K_M" => 0.75,
            _ => 0.6,
        };
        (param_b * factor * 10.0).round() / 10.0
    }

    fn is_embedding(entry: &LibraryModelEntry) -> bool {
        let n = entry.name.to_lowercase();
        entry.tags.iter().any(|t| t == "embedding")
            || n.contains("embed")
            || n.contains("bge-")
            || n.starts_with("nomic-embed")
            || n.contains("mxbai-embed")
    }

    fn is_coding(entry: &LibraryModelEntry) -> bool {
        let n = entry.name.to_lowercase();
        n.contains("coder")
            || n.contains("codellama")
            || n.contains("starcoder")
            || n.contains("deepseek-coder")
            || n.contains("codegemma")
            || (n.contains("kimi-k2") && n.contains("code"))
    }

    fn is_chinese_friendly(entry: &LibraryModelEntry) -> bool {
        let n = entry.name.to_lowercase();
        if is_embedding(entry) || is_coding(entry) {
            return false;
        }
        n.starts_with("qwen")
            || n.starts_with("glm")
            || n.starts_with("deepseek")
            || n.starts_with("yi")
            || n.starts_with("internlm")
            || n.starts_with("chatglm")
            || n.starts_with("hunyuan")
    }

    fn build_pull_name(entry: &LibraryModelEntry, size: Option<&str>, _quant: &str) -> String {
        match size {
            Some(sz) => format!("{}:{}", entry.name, sz),
            None => entry.name.clone(),
        }
    }

    fn quant_hint_text(quant: &str, size: Option<&str>) -> String {
        match (quant, size) {
            ("Q5_K_M", Some(sz)) => format!(
                "建议 {quant}；可试 `{sz}-q5_K_M`，失败则用 `:{sz}`（默认多为 Q4_K_M）"
            ),
            ("Q5_K_M", None) => format!("建议 {quant}；可试 `:q5_K_M`"),
            (_, Some(_)) => format!("{quant}（Ollama 默认尺寸 tag 常见为此量化）"),
            _ => quant.to_string(),
        }
    }

    fn format_pulls(n: u64) -> String {
        if n >= 1_000_000 {
            format!("{:.1}M", n as f64 / 1_000_000.0)
        } else if n >= 1_000 {
            format!("{:.1}K", n as f64 / 1_000.0)
        } else {
            n.to_string()
        }
    }

    fn make_rec(
        entry: &LibraryModelEntry,
        scenario: &str,
        hw: &LocalHardwareInfo,
        size: Option<String>,
    ) -> RecommendedModel {
        let size_ref = size.as_deref();
        let param = size_ref
            .and_then(parse_size_tag_b)
            .unwrap_or(if scenario == "embedding" { 0.3 } else { 3.0 });
        let name = build_pull_name(entry, size_ref, &hw.quant_pref);
        RecommendedModel {
            name,
            scenario: scenario.into(),
            kind: scenario.into(),
            approx_size_gb: if scenario == "embedding" {
                approx_gb_for(param.min(1.0), &hw.quant_pref).max(0.3)
            } else {
                approx_gb_for(param, &hw.quant_pref)
            },
            description: if entry.description.is_empty() {
                format!("{} · 热度 {}", entry.name, format_pulls(entry.pulls))
            } else {
                format!("{} · 热度 {}", entry.description, format_pulls(entry.pulls))
            },
            tier: hw.hardware_tier.clone(),
            quant_hint: quant_hint_text(&hw.quant_pref, size_ref),
            pulls: Some(entry.pulls),
            from_library: true,
        }
    }

    fn pick_top(
        catalog: &[LibraryModelEntry],
        pred: impl Fn(&LibraryModelEntry) -> bool,
        hw: &LocalHardwareInfo,
        scenario: &str,
        limit: usize,
    ) -> Vec<RecommendedModel> {
        let mut matched: Vec<&LibraryModelEntry> = catalog.iter().filter(|e| pred(e)).collect();
        matched.sort_by(|a, b| b.pulls.cmp(&a.pulls));
        let mut out = Vec::new();
        for entry in matched {
            let size = pick_size_tag(entry, hw.max_param_b);
            if scenario != "embedding" {
                if let Some(min) = size_tags(entry).first().copied() {
                    if min > hw.max_param_b * 1.25 {
                        continue;
                    }
                }
            }
            out.push(make_rec(entry, scenario, hw, size));
            if out.len() >= limit {
                break;
            }
        }
        out
    }

    pub async fn build_recommendations(
        hw: &LocalHardwareInfo,
        force_refresh: bool,
    ) -> (Vec<RecommendedModel>, String) {
        let (catalog, source) = load_library_catalog(force_refresh).await;
        let source_label = catalog_source_label(&source).to_string();

        let mut list = Vec::new();
        list.extend(pick_top(&catalog, is_coding, hw, "coding", 4));
        list.extend(pick_top(
            &catalog,
            is_chinese_friendly,
            hw,
            "chinese_chat",
            4,
        ));
        list.extend(pick_top(&catalog, is_embedding, hw, "embedding", 3));

        if list.iter().all(|m| m.scenario != "embedding") {
            list.push(RecommendedModel {
                name: "nomic-embed-text".into(),
                scenario: "embedding".into(),
                kind: "embedding".into(),
                approx_size_gb: 0.3,
                description: "知识库 / Skill 向量化推荐".into(),
                tier: hw.hardware_tier.clone(),
                quant_hint: "—".into(),
                pulls: None,
                from_library: false,
            });
        }

        if list.is_empty() {
            let chat = if hw.max_param_b >= 12.0 {
                ("qwen2.5-coder:14b", 9.0, "coding", "编码 14B")
            } else if hw.max_param_b >= 6.0 {
                ("qwen2.5-coder:7b", 4.7, "coding", "编码 7B")
            } else {
                ("qwen2.5:3b", 2.0, "chinese_chat", "中文轻量 3B")
            };
            list.push(RecommendedModel {
                name: chat.0.into(),
                scenario: chat.2.into(),
                kind: chat.2.into(),
                approx_size_gb: chat.1,
                description: chat.3.into(),
                tier: hw.hardware_tier.clone(),
                quant_hint: hw.quant_pref.clone(),
                pulls: None,
                from_library: false,
            });
        }

        (list, source_label)
    }
}

/// Ollama Library 目录缓存（自 `src-tauri/commands/ollama_catalog.rs` 移植）。
mod ollama_catalog {
    use std::fs;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use omnipanel_store::ai_config_dir;
    use reqwest::Client;

    const LIBRARY_URL: &str = "https://ollama.com/library";
    const CACHE_FILE: &str = "ollama_library_cache.json";
    const CACHE_TTL: Duration = Duration::from_secs(24 * 3600);

    #[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct LibraryModelEntry {
        pub name: String,
        pub pulls: u64,
        pub tags: Vec<String>,
        pub description: String,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum CatalogSource {
        Cache,
        Network,
        Fallback,
    }

    #[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LibraryCacheFile {
        fetched_at_ms: u64,
        models: Vec<LibraryModelEntry>,
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn cache_path() -> Result<std::path::PathBuf, String> {
        let dir = ai_config_dir().map_err(|e| e.to_string())?;
        Ok(dir.join(CACHE_FILE))
    }

    fn parse_pull_count(raw: &str) -> u64 {
        let s = raw.trim().replace(',', "");
        if let Some(n) = s.strip_suffix('M').or_else(|| s.strip_suffix('m')) {
            return (n.parse::<f64>().unwrap_or(0.0) * 1_000_000.0) as u64;
        }
        if let Some(n) = s.strip_suffix('K').or_else(|| s.strip_suffix('k')) {
            return (n.parse::<f64>().unwrap_or(0.0) * 1_000.0) as u64;
        }
        s.parse::<u64>().unwrap_or(0)
    }

    pub fn parse_library_html(html: &str) -> Vec<LibraryModelEntry> {
        regex_lite::parse_library_cards(html)
    }

    fn html_unescape_lite(s: &str) -> String {
        s.replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .trim()
            .to_string()
    }

    fn read_cache() -> Option<LibraryCacheFile> {
        let path = cache_path().ok()?;
        let text = fs::read_to_string(path).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn write_cache(models: &[LibraryModelEntry]) -> Result<(), String> {
        let path = cache_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let file = LibraryCacheFile {
            fetched_at_ms: now_ms(),
            models: models.to_vec(),
        };
        let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
        fs::write(path, json).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn cache_fresh(file: &LibraryCacheFile) -> bool {
        now_ms().saturating_sub(file.fetched_at_ms) < CACHE_TTL.as_millis() as u64
    }

    async fn fetch_library_html() -> Result<String, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client
            .get(LIBRARY_URL)
            .send()
            .await
            .map_err(|e| format!("请求 ollama.com/library 失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("ollama.com/library HTTP {}", resp.status()));
        }
        resp.text()
            .await
            .map_err(|e| format!("读取 library 页面失败: {e}"))
    }

    pub fn catalog_source_label(source: &CatalogSource) -> &'static str {
        match source {
            CatalogSource::Cache => "本地缓存（ollama.com/library）",
            CatalogSource::Network => "ollama.com/library（已刷新）",
            CatalogSource::Fallback => "内置回退清单",
        }
    }

    pub async fn load_library_catalog(force_refresh: bool) -> (Vec<LibraryModelEntry>, CatalogSource) {
        if !force_refresh {
            if let Some(cache) = read_cache() {
                if cache_fresh(&cache) && !cache.models.is_empty() {
                    return (cache.models, CatalogSource::Cache);
                }
            }
        }

        match fetch_library_html().await {
            Ok(html) => {
                let models = parse_library_html(&html);
                if !models.is_empty() {
                    let _ = write_cache(&models);
                    return (models, CatalogSource::Network);
                }
            }
            Err(e) => {
                tracing::warn!("拉取 ollama library 失败: {e}");
            }
        }

        if let Some(cache) = read_cache() {
            if !cache.models.is_empty() {
                return (cache.models, CatalogSource::Fallback);
            }
        }

        (fallback_catalog(), CatalogSource::Fallback)
    }

    fn fallback_catalog() -> Vec<LibraryModelEntry> {
        vec![
            LibraryModelEntry {
                name: "qwen2.5-coder".into(),
                pulls: 5_000_000,
                tags: vec!["tools".into(), "7b".into(), "14b".into()],
                description: "Qwen 2.5 Coder".into(),
            },
            LibraryModelEntry {
                name: "qwen2.5".into(),
                pulls: 8_000_000,
                tags: vec!["tools".into(), "3b".into(), "7b".into()],
                description: "Qwen 2.5".into(),
            },
            LibraryModelEntry {
                name: "nomic-embed-text".into(),
                pulls: 3_000_000,
                tags: vec!["embedding".into()],
                description: "Nomic Embed Text".into(),
            },
        ]
    }

    mod regex_lite {
        use super::{html_unescape_lite, parse_pull_count, LibraryModelEntry};

        pub fn parse_library_cards(html: &str) -> Vec<LibraryModelEntry> {
            let mut out = Vec::new();
            let mut seen = std::collections::HashSet::new();
            let card_marker = r#"href="/library/"#;
            let mut pos = 0usize;
            while let Some(start) = html[pos..].find(card_marker) {
                let abs = pos + start;
                let slice = &html[abs..];
                let name_start = r#"href="/library/"#.len();
                let name_end = slice[name_start..]
                    .find('"')
                    .map(|i| name_start + i)
                    .unwrap_or(name_start);
                if name_end <= name_start {
                    pos = abs + 1;
                    continue;
                }
                let name = slice[name_start..name_end].to_string();
                if name.is_empty() || !seen.insert(name.clone()) {
                    pos = abs + 1;
                    continue;
                }
                let desc_start = slice.find(r#"<p class="max-w-lg"#);
                let pulls_marker = slice.find("Pulls");
                if let (Some(ds), Some(_pm)) = (desc_start, pulls_marker) {
                    let desc_region = &slice[ds..];
                    let description = html_unescape_lite(&extract_tag_text(desc_region, 'p'));
                    let pulls = parse_pull_count(&extract_pulls(slice).unwrap_or_else(|| "0".into()));
                    let mut tags = extract_tags(slice);
                    tags.sort();
                    tags.dedup();
                    out.push(LibraryModelEntry {
                        name,
                        pulls,
                        tags,
                        description,
                    });
                }
                pos = abs + card_marker.len();
            }
            out.sort_by(|a, b| b.pulls.cmp(&a.pulls));
            out
        }

        fn extract_tag_text(region: &str, tag: char) -> String {
            let open = format!("<{tag}");
            let close = format!("</{tag}>");
            if let Some(start) = region.find(&open) {
                if let Some(gt) = region[start..].find('>') {
                    let content_start = start + gt + 1;
                    if let Some(end) = region[content_start..].find(&close) {
                        return region[content_start..content_start + end]
                            .trim()
                            .to_string();
                    }
                }
            }
            String::new()
        }

        fn extract_pulls(slice: &str) -> Option<String> {
            let re_like = slice
                .split("<span")
                .filter_map(|part| {
                    let num: String = part
                        .chars()
                        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
                        .collect();
                    if num.len() >= 2 && part.contains("Pulls") {
                        Some(num)
                    } else {
                        None
                    }
                })
                .next();
            re_like
        }

        fn extract_tags(slice: &str) -> Vec<String> {
            slice
                .split("text-indigo-600")
                .chain(slice.split("text-blue-600"))
                .filter_map(|part| {
                    part.find('>').and_then(|gt| {
                        part[gt + 1..]
                            .split('<')
                            .next()
                            .map(|s| s.trim().to_lowercase())
                            .filter(|s| !s.is_empty())
                    })
                })
                .collect()
        }
    }
}
