//! 端到端验证：S3 分块上传 / Range 下载（Web 端文件链路，不整载进内存）。
//!
//! 前置：
//! 1. `python3 docs/web/mock_s3_server.py 19000`（path-style + 不验签 + multipart 支持）
//! 2. 运行 `cargo run -p omnipanel-server --example verify_s3_multipart`
//!
//! 逻辑：
//! 1. 向元数据库写入一个 S3 file 连接
//! 2. 生成本地 16MB 文件，`file_upload_local_path_multipart` 分块上传（1MB/片 → 16 片）
//! 3. `file_download_s3_range_to_file` 按 Range 分块下载回本地
//! 4. 校验内容一致 + 读回完整对象长度正确
//! 5. 通过打印 OK，退出码 0

use std::sync::Arc;

use omnipanel_server::files::{
    file_download_s3_range_to_file, file_list_dir, file_read_file,
    file_upload_local_path_multipart,
};
use omnipanel_server::state::ServerState;
use omnipanel_store::{Connection, ConnectionKind};

fn s3_conn() -> Connection {
    Connection {
        id: "file-s3-mp".to_string(),
        kind: ConnectionKind::File,
        name: "mock-s3-multipart".to_string(),
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

    // 1. 生成本地 16MB 源文件
    let src = std::env::temp_dir().join("s3-mp-src.bin");
    let payload: Vec<u8> = (0..16 * 1024 * 1024).map(|i| (i % 253) as u8).collect();
    tokio::fs::write(&src, &payload).await?;
    println!("local source: {} bytes", payload.len());

    // 2. 分块上传（1MB/片 → 16 片）
    let written = file_upload_local_path_multipart(
        &state,
        cid.clone(),
        "mp/big.bin".to_string(),
        src.to_string_lossy().into_owned(),
        Some(1024 * 1024),
    )
    .await
    .map_err(|e| format!("multipart upload: {e}"))?;
    assert_eq!(written as usize, payload.len(), "上传字节数不一致");
    println!("OK multipart upload: {written} bytes");

    // 3. 列目录确认
    let list = file_list_dir(&state, cid.clone(), "mp".to_string(), None, None)
        .await
        .map_err(|e| format!("list: {e}"))?;
    assert!(list.entries.iter().any(|e| e.name == "big.bin"), "entries: {:?}", list.entries);
    println!("OK list: {:?}", list.entries.iter().map(|e| (&e.name, e.size)).collect::<Vec<_>>());

    // 4. 完整读回（验证对象内容）
    let data = file_read_file(&state, cid.clone(), "mp/big.bin".to_string(), 64.0 * 1024.0 * 1024.0)
        .await
        .map_err(|e| format!("read: {e}"))?;
    assert_eq!(data.len(), payload.len(), "读回长度不一致");
    assert_eq!(data, payload, "读回内容不一致");
    println!("OK full read: {} bytes", data.len());

    // 5. Range 分块下载回本地
    let dst = std::env::temp_dir().join("s3-mp-dst.bin");
    let downloaded = file_download_s3_range_to_file(
        &state,
        cid.clone(),
        "mp/big.bin".to_string(),
        dst.to_string_lossy().into_owned(),
        Some(1024 * 1024),
    )
    .await
    .map_err(|e| format!("range download: {e}"))?;
    let dst_data = tokio::fs::read(&dst).await?;
    assert_eq!(dst_data.len(), payload.len(), "下载长度不一致");
    assert_eq!(dst_data, payload, "下载内容不一致");
    println!("OK range download: {downloaded} bytes");

    // 6. 清理
    omnipanel_server::files::file_delete(&state, cid.clone(), "mp/big.bin".to_string(), Some("file".to_string()))
        .await
        .map_err(|e| format!("delete: {e}"))?;
    let _ = tokio::fs::remove_file(&src).await;
    let _ = tokio::fs::remove_file(&dst).await;

    println!("\nALL S3 MULTIPART WEB VERIFY PASSED ✅");
    Ok(())
}
