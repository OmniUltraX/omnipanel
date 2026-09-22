//! OpenCode HTTP：用 `opencode serve` 拉起固定端口服务。
//!
//! ```text
//! opencode serve --hostname 127.0.0.1 --port 4096
//! OPENCODE_SERVER_PASSWORD=<固定密码>
//! Basic auth: opencode:<密码>
//! ```
//!
//! 启动一次 → 缓存 endpoint → 业务请求直连。不搞 service daemon / 动态端口 / 连环重试。
//! 若 4096 已被「密码不匹配」的 serve 占用，直接杀掉再拉起（本机回环，OmniPanel 托管）。

use std::fs;
use std::io::Write;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use super::client::{OpenCodeClient, OpenCodeModel};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 4096;
/// 本机回环固定密码（仅本机 Basic auth；可用环境变量覆盖）。
const DEFAULT_PASSWORD: &str = "omnipanel-opencode-local";

#[derive(Debug, Clone)]
pub struct OpenCodeEndpoint {
    pub base_url: String,
    pub password: String,
}

struct ServiceState {
    endpoint: Option<OpenCodeEndpoint>,
    /// 我们拉起的 `opencode serve` 子进程；None 表示复用了已有服务。
    child: Option<Child>,
}

static SERVICE: std::sync::Mutex<ServiceState> = std::sync::Mutex::new(ServiceState {
    endpoint: None,
    child: None,
});

static START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn debug_log_path() -> PathBuf {
    std::env::temp_dir().join("omnipanel-opencode-debug.log")
}

fn serve_stderr_path() -> PathBuf {
    std::env::temp_dir().join("omnipanel-opencode-serve.stderr.log")
}

fn dbg_log(msg: impl AsRef<str>) {
    let msg = msg.as_ref();
    tracing::info!(target: "opencode", "{msg}");
    eprintln!("[opencode] {msg}");
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(debug_log_path())
    {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{ts}] {msg}");
    }
}

fn password() -> String {
    std::env::var("OPENCODE_SERVER_PASSWORD")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_PASSWORD.to_string())
}

fn endpoint_for(password: &str) -> OpenCodeEndpoint {
    OpenCodeEndpoint {
        base_url: format!("http://{HOST}:{PORT}"),
        password: password.to_string(),
    }
}

fn cached_endpoint() -> Option<OpenCodeEndpoint> {
    SERVICE.lock().ok().and_then(|g| g.endpoint.clone())
}

fn store_ready(ep: OpenCodeEndpoint, child: Option<Child>) {
    if let Ok(mut g) = SERVICE.lock() {
        // 换新进程前先干掉旧的
        if let Some(mut old) = g.child.take() {
            let _ = old.kill();
            let _ = old.wait();
        }
        g.endpoint = Some(ep);
        g.child = child;
    }
}

/// 把 .cmd / shim 解析成真实 opencode.exe。
fn resolve_native_binary(binary: &Path) -> PathBuf {
    let lower = binary
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if lower.ends_with(".exe") && binary.is_file() {
        return binary.to_path_buf();
    }
    if let Some(prefix) = binary.parent() {
        for rel in [
            "node_modules/@opencode/cli/bin/opencode.exe",
            "node_modules/opencode-ai/bin/opencode.exe",
            "opencode.exe",
        ] {
            let candidate = prefix.join(rel);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    binary.to_path_buf()
}

fn apply_no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    let _ = cmd;
}

fn port_listening() -> bool {
    TcpStream::connect_timeout(
        &format!("{HOST}:{PORT}")
            .parse()
            .expect("HOST:PORT is valid"),
        Duration::from_millis(200),
    )
    .is_ok()
}

/// 杀掉占用 4096 的进程（Windows：netstat；其它：lsof）。
fn kill_port_occupant() {
    #[cfg(windows)]
    {
        let output = Command::new("cmd")
            .args(["/C", &format!("netstat -ano | findstr :{PORT}")])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();
        let Ok(out) = output else {
            return;
        };
        let text = String::from_utf8_lossy(&out.stdout);
        let mut pids = std::collections::BTreeSet::new();
        for line in text.lines() {
            // TCP    127.0.0.1:4096    0.0.0.0:0    LISTENING    12345
            if !line.contains("LISTENING") {
                continue;
            }
            if let Some(pid) = line.split_whitespace().last() {
                if let Ok(pid) = pid.parse::<u32>() {
                    if pid > 0 {
                        pids.insert(pid);
                    }
                }
            }
        }
        for pid in pids {
            dbg_log(format!("reclaim port {PORT}: taskkill /PID {pid}"));
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F", "/T"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
    #[cfg(not(windows))]
    {
        let output = Command::new("sh")
            .args([
                "-c",
                &format!("lsof -tiTCP:{PORT} -sTCP:LISTEN 2>/dev/null || true"),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();
        let Ok(out) = output else {
            return;
        };
        let text = String::from_utf8_lossy(&out.stdout);
        for pid in text.split_whitespace() {
            if let Ok(pid) = pid.parse::<i32>() {
                dbg_log(format!("reclaim port {PORT}: kill {pid}"));
                let _ = Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .status();
            }
        }
    }
}

async fn health_ok(ep: &OpenCodeEndpoint) -> bool {
    OpenCodeClient::new(ep.clone()).health_probe().await.is_ok()
}

async fn health_probe_err(ep: &OpenCodeEndpoint) -> Option<String> {
    match OpenCodeClient::new(ep.clone()).health_probe().await {
        Ok(()) => None,
        Err(e) => Some(e),
    }
}

/// 后台拉起：`opencode serve --hostname 127.0.0.1 --port 4096`
fn spawn_serve(binary: &Path, password: &str) -> Result<Child, String> {
    let native = resolve_native_binary(binary);
    if !native.is_file() {
        return Err(format!("OpenCode 二进制不存在: {}", native.display()));
    }
    dbg_log(format!(
        "spawn: {} serve --hostname {HOST} --port {PORT} (password len={})",
        native.display(),
        password.len()
    ));

    let stderr_path = serve_stderr_path();
    let _ = fs::remove_file(&stderr_path);
    let stderr_file = fs::File::create(&stderr_path).map_err(|e| {
        format!(
            "无法创建 stderr 日志 {}: {e}",
            stderr_path.display()
        )
    })?;

    let mut cmd = Command::new(&native);
    cmd.args(["serve", "--hostname", HOST, "--port", &PORT.to_string()])
        .env("OPENCODE_SERVER_PASSWORD", password)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file));
    apply_no_window(&mut cmd);

    cmd.spawn()
        .map_err(|e| format!("启动 `opencode serve` 失败（{}）: {e}", native.display()))
}

fn read_serve_stderr() -> String {
    fs::read_to_string(serve_stderr_path())
        .unwrap_or_default()
        .trim()
        .chars()
        .take(500)
        .collect()
}

/// 获取 endpoint：有缓存直接返回；否则启动 `opencode serve` 一次。
pub async fn ensure_opencode_service(binary: Option<&Path>) -> Result<OpenCodeEndpoint, String> {
    if let Some(ep) = cached_endpoint() {
        // 缓存仍健康才复用；进程挂了就清掉重来
        if health_ok(&ep).await {
            return Ok(ep);
        }
        dbg_log("cached endpoint unhealthy → clear");
        stop_opencode_serve();
    }

    let _guard = START_LOCK.lock().await;
    if let Some(ep) = cached_endpoint() {
        if health_ok(&ep).await {
            return Ok(ep);
        }
        stop_opencode_serve();
    }

    let pw = password();
    let ep = endpoint_for(&pw);

    // 已有人在 4096 上、且密码匹配 → 直接用
    if let Some(err) = health_probe_err(&ep).await {
        dbg_log(format!("pre-spawn health: {err}"));
    } else {
        dbg_log(format!("reuse existing serve {}", ep.base_url));
        store_ready(ep.clone(), None);
        return Ok(ep);
    }

    // 端口被占但密码不对（例如手动 `opencode serve` 随机密码）→ 回收后重起
    if port_listening() {
        dbg_log(format!(
            "port {PORT} occupied but auth mismatch → reclaim"
        ));
        kill_port_occupant();
        // 等端口释放
        for _ in 0..20 {
            if !port_listening() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    let binary = binary.ok_or_else(|| "OpenCode 未安装或未找到可执行文件".to_string())?;
    let mut child = spawn_serve(binary, &pw)?;

    // 等监听就绪（最多 ~15s，间隔 300ms）
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let mut last_err = String::new();
    loop {
        match health_probe_err(&ep).await {
            None => {
                dbg_log(format!("serve ready {}", ep.base_url));
                store_ready(ep.clone(), Some(child));
                return Ok(ep);
            }
            Some(e) => last_err = e,
        }
        // 子进程已退出 → 启动失败
        if let Ok(Some(status)) = child.try_wait() {
            let stderr = read_serve_stderr();
            return Err(format!(
                "`opencode serve` 已退出（code={:?}）{}; 日志 {}",
                status.code(),
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!("; stderr={stderr}")
                },
                debug_log_path().display()
            ));
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let stderr = read_serve_stderr();
            return Err(format!(
                "等待 `opencode serve` 就绪超时（{}）; last={last_err}{}; 日志 {}",
                ep.base_url,
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!("; stderr={stderr}")
                },
                debug_log_path().display()
            ));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

pub async fn probe_opencode_online(binary: Option<&Path>) -> bool {
    ensure_opencode_service(binary).await.is_ok()
}

pub async fn list_opencode_models(binary: Option<&Path>) -> Result<Vec<String>, String> {
    let endpoint = ensure_opencode_service(binary).await?;
    let models = OpenCodeClient::new(endpoint).list_models().await?;
    Ok(models.into_iter().map(|m| m.cache_entry()).collect())
}

#[allow(dead_code)]
pub async fn list_opencode_model_infos(
    binary: Option<&Path>,
) -> Result<Vec<OpenCodeModel>, String> {
    let endpoint = ensure_opencode_service(binary).await?;
    OpenCodeClient::new(endpoint).list_models().await
}

/// 停止我们拉起的 serve（禁用智能体时可选调用）。
pub fn stop_opencode_serve() {
    if let Ok(mut g) = SERVICE.lock() {
        g.endpoint = None;
        if let Some(mut child) = g.child.take() {
            dbg_log("stop: killing opencode serve child");
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    // 保险：禁用时也清掉 4096 上残留（含复用的外部进程）
    if port_listening() {
        kill_port_occupant();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_native_from_cmd_shim() {
        let cmd = PathBuf::from(r"C:\nvm4w\nodejs\opencode.cmd");
        let exe =
            PathBuf::from(r"C:\nvm4w\nodejs\node_modules\@opencode\cli\bin\opencode.exe");
        if exe.is_file() {
            assert_eq!(resolve_native_binary(&cmd), exe);
        }
    }
}
