//! OmniPanel Web 服务端二进制入口。
//!
//! 用法：
//! ```bash
//! cargo run -p omnipanel-server -- --static-dir frontend/dist [--port 8899]
//! ```
//! 浏览器打开 `http://127.0.0.1:8899` 即用（与桌面端共用同一套前端产物）。

use std::path::PathBuf;

use omnipanel_server::{run_server, ServerConfig};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let args: Vec<String> = std::env::args().collect();
    let mut port: u16 = 8899;
    let mut static_dir: Option<PathBuf> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                i += 1;
                if i < args.len() {
                    port = args[i].parse().unwrap_or(8899);
                }
            }
            "--static-dir" => {
                i += 1;
                if i < args.len() {
                    static_dir = Some(PathBuf::from(&args[i]));
                }
            }
            "--help" | "-h" => {
                println!(
                    "OmniPanel Web Server\n\n  --port <port>        监听端口 (默认 8899)\n  --static-dir <dir>   前端静态目录 (frontend/dist)"
                );
                return Ok(());
            }
            _ => {}
        }
        i += 1;
    }

    let config = ServerConfig {
        bind_addr: format!("0.0.0.0:{port}"),
        static_dir,
    };

    let handle = run_server(config)?;
    tokio::signal::ctrl_c().await?;
    handle.shutdown().await;
    Ok(())
}
