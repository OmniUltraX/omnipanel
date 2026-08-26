//! MongoDB 引擎 sidecar：stdin/stdout JSON-RPC。
//!
//! 不要加 `windows_subsystem = "windows"`，否则 Windows 上没有 stdin/stdout。

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(omnipanel_db::sidecar::serve_stdio());
}
