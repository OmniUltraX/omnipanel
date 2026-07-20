//! 本地模型运行时管理：Ollama 探测 / 授权安装 / 模型拉取删除 / LM Studio 探测。

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use specta::Type;
use sysinfo::System;
use tokio::process::Command;

const OLLAMA_HOST: &str = "http://127.0.0.1:11434";
const OLLAMA_OPENAI_BASE: &str = "http://127.0.0.1:11434/v1";
const LMSTUDIO_OPENAI_BASE: &str = "http://127.0.0.1:1234/v1";
const OLLAMA_DOWNLOAD_URL: &str = "https://ollama.com/download";
const OLLAMA_WINDOWS_SETUP_URL: &str = "https://ollama.com/download/OllamaSetup.exe";

type ProgressCb = Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>;

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
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LocalRuntimeStatus {
    NotInstalled,
    InstalledNotRunning,
    Running,
}

/// 已安装模型摘要。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelInfo {
    pub name: String,
    #[specta(type = f64)]
    pub size_bytes: u64,
    pub digest: String,
    pub family: String,
}

/// Ollama 探测结果。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
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
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiCompatProbeResult {
    pub reachable: bool,
    pub endpoint: String,
    pub models: Vec<String>,
    pub error: Option<String>,
}

/// 聚合探测。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalRuntimeProbeResult {
    pub ollama: OllamaProbeResult,
    pub lm_studio: OpenAiCompatProbeResult,
    pub hardware: crate::commands::ollama_recommend::LocalHardwareInfo,
    /// 系统内存 MB（兼容旧字段）
    #[specta(type = f64)]
    pub total_memory_mb: u64,
    pub hardware_tier: String,
    pub recommended_models: Vec<crate::commands::ollama_recommend::RecommendedModel>,
    /// 推荐清单来源说明
    pub catalog_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
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
    // 先查常见安装路径，避免每次探测都 spawn `where`/`which`（Windows 会闪黑框）
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

    // PATH 兜底（隐藏控制台窗口）
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
            family: m
                .details
                .and_then(|d| d.family)
                .unwrap_or_default(),
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

    // 先走 HTTP：服务已运行时不必查 CLI，避免状态栏轮询反复 spawn
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
#[tauri::command]
#[specta::specta]
pub async fn local_runtime_probe() -> Result<LocalRuntimeProbeResult, String> {
    let total_memory_mb = system_memory_mb();
    let hardware = crate::commands::ollama_recommend::probe_hardware(total_memory_mb);
    let (recommended_models, catalog_source) =
        crate::commands::ollama_recommend::build_recommendations(&hardware, false).await;
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
#[tauri::command]
#[specta::specta]
pub async fn local_runtime_refresh_catalog() -> Result<LocalRuntimeProbeResult, String> {
    let total_memory_mb = system_memory_mb();
    let hardware = crate::commands::ollama_recommend::probe_hardware(total_memory_mb);
    let (recommended_models, catalog_source) =
        crate::commands::ollama_recommend::build_recommendations(&hardware, true).await;
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
#[tauri::command]
#[specta::specta]
pub async fn local_runtime_start_ollama() -> Result<bool, String> {
    let cli = find_ollama_cli().ok_or_else(|| "未找到 ollama 可执行文件".to_string())?;
    // 若已在运行，直接成功
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

    // 轮询就绪
    let client = http_client()?;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if fetch_ollama_models(&client).await.is_ok() {
            return Ok(true);
        }
    }
    Err("已启动 ollama，但服务尚未就绪，请稍后重试".into())
}

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
pub(crate) async fn install_ollama_with_progress(
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
#[tauri::command]
#[specta::specta]
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
pub(crate) async fn pull_ollama_with_progress(
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
#[tauri::command]
#[specta::specta]
pub async fn local_runtime_ollama_pull(model: String) -> Result<(), String> {
    let progress: ProgressCb = Arc::new(|_, _, _, _, _| {});
    let cancel = Arc::new(AtomicBool::new(false));
    pull_ollama_with_progress(model, cancel, progress).await
}

/// 删除本地 Ollama 模型。
#[tauri::command]
#[specta::specta]
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
#[tauri::command]
#[specta::specta]
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
#[tauri::command]
#[specta::specta]
pub async fn local_runtime_ollama_download_url() -> Result<String, String> {
    Ok(OLLAMA_DOWNLOAD_URL.into())
}
