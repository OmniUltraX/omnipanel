//! OmniPanel Web 服务端二进制入口。
//!
//! 用法：
//! ```bash
//! cargo run -p omnipanel-server -- --static-dir frontend/dist [--port 8899] [--api-key <key>]
//! ```
//! 浏览器打开 `http://127.0.0.1:8899` 即用（与桌面端共用同一套前端产物）。
//!
//! `--api-key` 可选：配置后 `/ipc/invoke` / `/ipc/events` 需要
//! `Authorization: Bearer <key>`（复用 gateway 的 api_key 模式）。

use std::path::PathBuf;

use omnipanel_server::{ServerConfig, run_server};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let args: Vec<String> = std::env::args().collect();
    let mut port: u16 = 8899;
    let mut bind: String = "0.0.0.0".to_string();
    let mut static_dir: Option<PathBuf> = None;
    let mut api_key: Option<String> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                i += 1;
                if i < args.len() {
                    port = args[i].parse().unwrap_or(8899);
                }
            }
            "--bind" => {
                i += 1;
                if i < args.len() {
                    bind = args[i].clone();
                }
            }
            "--static-dir" => {
                i += 1;
                if i < args.len() {
                    static_dir = Some(PathBuf::from(&args[i]));
                }
            }
            "--api-key" => {
                i += 1;
                if i < args.len() {
                    api_key = Some(args[i].clone());
                }
            }
            "--help" | "-h" => {
                println!(
                    "OmniPanel Web Server\n\n  --port <port>        监听端口 (默认 8899)\n  --bind <addr>        监听地址 (默认 0.0.0.0；生产建议 127.0.0.1 + 反代)\n  --static-dir <dir>   前端静态目录 (frontend/dist)\n  --api-key <key>      API Key（可选；配置后 IPC 需 Authorization: Bearer <key>）"
                );
                return Ok(());
            }
            _ => {}
        }
        i += 1;
    }

    let config = ServerConfig {
        bind_addr: format!("{bind}:{port}"),
        static_dir,
        api_key,
    };

    let handle = run_server(config)?;
    tokio::signal::ctrl_c().await?;
    handle.shutdown().await;
    Ok(())
}
