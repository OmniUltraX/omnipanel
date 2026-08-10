//! 端到端验证：本地 mock S3 上的 Web 端文件链路。
//!
//! 前置：
//! 1. `python3 /tmp/mock_s3.py 19000`
//! 2. 运行 `cargo run -p omnipanel-server --example verify_s3_web -- --port 18899`
//!
//! 逻辑：
//! 1. 向元数据库写入一个 S3 file 连接（endpoint=127.0.0.1:19000, path-style）
//! 2. 调 file_upload_file 上传对象 → file_list_dir 列出 → file_read_file 读回
//! 3. 调 file_s3_search 搜索 → file_mkdir → file_rename → file_delete
//! 4. 全部通过打印 OK，退出码 0

use std::sync::Arc;

use omnipanel_server::files::{file_delete, file_list_dir, file_mkdir, file_read_file, file_rename, file_s3_search, file_upload_file};
use omnipanel_server::state::ServerState;
use omnipanel_store::{Connection, ConnectionKind};

fn s3_conn() -> Connection {
    Connection {
        id: "file-s3-mock".to_string(),
        kind: ConnectionKind::File,
        name: "mock-s3".to_string(),
        group: "文件".to_string(),
        env_tag: "dev".to_string(),
        tags: vec![],
        config: serde_json::json!({
            "protocol": "s3",
            "bucket": "test-bucket",
            "provider": "aws",
            "region": "us-east-1",
            "endpoint": "http://127.0.0.1:19000",
            "accessKey": "minioadmin",
            "prefix": "",
        })
        .to_string(),
        credential_ref: None,
        created_at: 0,
        updated_at: 0,
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let state = Arc::new(ServerState::new());
    let conn = s3_conn();
    {
        let storage = state.storage.lock().await;
        storage.save_connection(&conn)?;
    }
    let cid = conn.id.clone();

    // 1. 上传
    file_upload_file(
        &state,
        cid.clone(),
        "dir/hello.txt".to_string(),
        b"hello s3 web verify".to_vec(),
    )
    .await
    .map_err(|e| format!("upload: {e}"))?;
    println!("OK upload");

    // 2. 列目录
    let list = file_list_dir(&state, cid.clone(), "dir".to_string(), None, None)
        .await
        .map_err(|e| format!("list: {e}"))?;
    assert!(list.entries.iter().any(|e| e.name == "hello.txt"), "entries: {:?}", list.entries);
    println!("OK list dir: {:?}", list.entries.iter().map(|e| (&e.name, &e.kind)).collect::<Vec<_>>());

    // 3. 读回
    let data = file_read_file(&state, cid.clone(), "dir/hello.txt".to_string(), 1024.0)
        .await
        .map_err(|e| format!("read: {e}"))?;
    assert_eq!(data, b"hello s3 web verify");
    println!("OK read");

    // 4. 搜索（前缀模式）
    let found = file_s3_search(&state, cid.clone(), "dir/".to_string(), None)
        .await
        .map_err(|e| format!("search: {e}"))?;
    assert!(!found.entries.is_empty());
    println!("OK search prefix: {:?}", found.entries.iter().map(|e| &e.name).collect::<Vec<_>>());

    // 5. mkdir
    file_mkdir(&state, cid.clone(), "newdir".to_string()).await.map_err(|e| format!("mkdir: {e}"))?;
    println!("OK mkdir");

    // 6. rename
    file_rename(&state, cid.clone(), "dir/hello.txt".to_string(), "dir/renamed.txt".to_string())
        .await
        .map_err(|e| format!("rename: {e}"))?;
    let list2 = file_list_dir(&state, cid.clone(), "dir".to_string(), None, None)
        .await
        .map_err(|e| format!("list2: {e}"))?;
    assert!(list2.entries.iter().any(|e| e.name == "renamed.txt"));
    println!("OK rename");

    // 7. delete 文件
    file_delete(&state, cid.clone(), "dir/renamed.txt".to_string(), Some("file".to_string()))
        .await
        .map_err(|e| format!("delete: {e}"))?;
    let list3 = file_list_dir(&state, cid.clone(), "dir".to_string(), None, None)
        .await
        .map_err(|e| format!("list3: {e}"))?;
    assert!(list3.entries.is_empty(), "entries: {:?}", list3.entries);
    println!("OK delete");

    // 8. delete 目录
    file_delete(&state, cid.clone(), "newdir".to_string(), Some("dir".to_string()))
        .await
        .map_err(|e| format!("delete dir: {e}"))?;
    println!("OK delete dir");

    println!("\nALL S3 WEB VERIFY PASSED ✅");
    Ok(())
}
