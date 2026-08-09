//! P3 集成验证：通过 ServerState + storage 直接驱动 FTP / transfer 命令。
//! 用法：cargo test -p omnipanel-server --test ftp_web_test -- --nocapture

use std::sync::Arc;

use omnipanel_server::{run_server, ServerConfig};
use omnipanel_store::{Connection, ConnectionKind};

fn ftp_conn() -> Connection {
    Connection {
        id: "ftp-test-1".to_string(),
        kind: ConnectionKind::File,
        name: "本地测试 FTP".to_string(),
        group: "测试".to_string(),
        env_tag: "test".to_string(),
        tags: vec![],
        config: serde_json::json!({
            "protocol": "ftp",
            "host": "127.0.0.1",
            "port": 2121,
            "user": "testuser",
            "rootPath": "/"
        })
        .to_string(),
        credential_ref: Some("ftp-test-1-pass".to_string()),
        created_at: 0,
        updated_at: 0,
    }
}

#[tokio::test]
async fn ftp_list_read_via_server_state() {
    let state = Arc::new(omnipanel_server::terminal::ServerState::new());
    // 写入 Vault 密码（无 keyring 环境自动降级文件存储）
    omnipanel_store::Vault::store("ftp-test-1-pass", "testpass").expect("存储 FTP 密码失败");
    // 写入 FTP 连接
    {
        let storage = state.storage.lock().await;
        storage
            .save_connection(&ftp_conn())
            .expect("保存 FTP 连接失败");
    }
    // 保存密码到 Vault（credential_ref 为 None → resolve_secret 用 Vault::get(None) 返回空）
    // 用 user 固定密码：files.rs resolve_secret 在 credential_ref None 时走 Vault::get(None)
    // 这里直接验证 list 路径（登录失败场景给明确错误）

    // 1) 列目录（FTP 带密码登录）
    let result = omnipanel_server::files::file_list_dir(
        &state,
        "ftp-test-1".to_string(),
        "/".to_string(),
        None,
    )
    .await;
    println!("ftp list result: {result:?}");
    assert!(result.is_ok(), "FTP 列目录应成功");
    let entries = result.unwrap().entries;
    assert!(entries.iter().any(|e| e.name == "hello.txt"), "应列出 hello.txt");

    // 1b) FTP 读取文件
    let read = omnipanel_server::files::file_read_file(
        &state,
        "ftp-test-1".to_string(),
        "/hello.txt".to_string(),
        1024.0 * 1024.0,
    )
    .await;
    println!("ftp read: {:?}", read.as_ref().map(|d| String::from_utf8_lossy(d).into_owned()));
    assert_eq!(
        String::from_utf8_lossy(&read.unwrap()).trim(),
        "ftp test file content",
        "FTP 读取内容应一致"
    );

    // 1c) FTP 上传
    let up = omnipanel_server::files::file_upload_file(
        &state,
        "ftp-test-1".to_string(),
        "/uploaded.txt".to_string(),
        b"uploaded by web".to_vec(),
    )
    .await;
    println!("ftp upload: {up:?}");
    assert!(up.is_ok(), "FTP 上传应成功");
    let up_read = omnipanel_server::files::file_read_file(
        &state,
        "ftp-test-1".to_string(),
        "/uploaded.txt".to_string(),
        1024.0 * 1024.0,
    )
    .await
    .unwrap();
    assert_eq!(up_read, b"uploaded by web".to_vec());

    // 1d) FTP 删除
    let del = omnipanel_server::files::file_delete(
        &state,
        "ftp-test-1".to_string(),
        "/uploaded.txt".to_string(),
        None,
    )
    .await;
    println!("ftp delete: {del:?}");
    assert!(del.is_ok(), "FTP 删除应成功");

    // 2) transfer_start local -> local（服务端 relay 主链路）
    let req = omnipanel_server::transfer::TransferStartRequest {
        source_connection_id: "file-local".to_string(),
        source_path: "/tmp/relay_src/test.txt".to_string(),
        dest_connection_id: "file-local".to_string(),
        dest_path: "/tmp/relay_dst/via_test.txt".to_string(),
        conflict_policy: Some("overwrite".to_string()),
        resume: true,
    };
    let job = omnipanel_server::transfer::transfer_start(state.clone(), req).await;
    println!("transfer_start: {job:?}");
    assert!(job.is_ok(), "transfer_start 应成功");
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let copied = tokio::fs::read_to_string("/tmp/relay_dst/via_test.txt").await;
    println!("copied content: {copied:?}");
    assert_eq!(copied.unwrap_or_default().trim(), "hello relay p3b");
}

#[tokio::test]
async fn server_boots_with_transfer_routes() {
    let cfg = ServerConfig {
        bind_addr: "127.0.0.1:18999".to_string(),
        static_dir: None,
        api_key: None,
    };
    let handle = run_server(cfg).expect("server 启动");
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let ok = reqwest::get("http://127.0.0.1:18999/healthz")
        .await
        .expect("healthz 请求");
    assert!(ok.status().is_success());
    handle.stop();
}
