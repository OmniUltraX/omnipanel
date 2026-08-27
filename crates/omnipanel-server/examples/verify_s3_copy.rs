//! 端到端验证：S3 服务端复制（含大对象分片复制 UploadPartCopy）。
//!
//! 前置：
//! 1. `python3 docs/web/mock_s3_server.py 19000`
//! 2. 运行 `cargo run -p omnipanel-server --example verify_s3_copy`
//!
//! 逻辑：
//! 1. 向元数据库写入一个 S3 file 连接
//! 2. 上传一个 8MB 源对象（大对象，触发分片复制路径）
//! 3. 调 `file_s3_copy_object` 同连接服务端复制 src → dst
//! 4. 读回 dst 校验内容一致 + 长度正确
//! 5. 小对象单次拷贝路径也验证一次
//! 6. 通过打印 OK，退出码 0

use std::sync::Arc;

use omnipanel_server::files::{
    file_read_file, file_s3_copy_object, file_upload_local_path_multipart,
};
use omnipanel_server::state::ServerState;
use omnipanel_store::{Connection, ConnectionKind};

fn s3_conn() -> Connection {
    Connection {
        id: "file-s3-copy".to_string(),
        kind: ConnectionKind::File,
        name: "mock-s3-copy".to_string(),
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

    // 1. 生成本地 8MB 源文件
    let src = std::env::temp_dir().join("s3-copy-src.bin");
    let payload: Vec<u8> = (0..8 * 1024 * 1024).map(|i| (i % 247) as u8).collect();
    tokio::fs::write(&src, &payload).await?;

    // 2. 分块上传源对象
    file_upload_local_path_multipart(
        &state,
        cid.clone(),
        "copy-src.bin".to_string(),
        src.to_string_lossy().into_owned(),
        None,
    )
    .await
    .map_err(|e| format!("upload src: {e}"))?;
    println!("OK upload src (8MB)");

    // 3. 服务端复制 src → dst（>5MB 走分片复制路径）
    let copied = file_s3_copy_object(
        &state,
        cid.clone(),
        "copy-src.bin".to_string(),
        "copy-dst.bin".to_string(),
    )
    .await
    .map_err(|e| format!("s3 copy: {e}"))?;
    assert_eq!(copied as usize, payload.len(), "copied size mismatch");
    println!("OK s3 copy big (multipart) copied={copied} bytes");

    // 4. 读回 dst 校验内容一致
    let got = file_read_file(
        &state,
        cid.clone(),
        "copy-dst.bin".to_string(),
        (16 * 1024 * 1024) as f64,
    )
    .await
    .map_err(|e| format!("read dst: {e}"))?;
    assert_eq!(got, payload, "dst content mismatch");
    println!("OK read dst content identical");

    // 5. 小对象单次拷贝
    file_upload_local_path_multipart(
        &state,
        cid.clone(),
        "small-src.txt".to_string(),
        src.to_string_lossy().into_owned(),
        None,
    )
    .await
    .map_err(|e| format!("upload small src: {e}"))?;
    // 用小文件验证（写入后再复制）
    tokio::fs::write(&src, b"small copy payload").await?;
    file_upload_local_path_multipart(
        &state,
        cid.clone(),
        "small-src.txt".to_string(),
        src.to_string_lossy().into_owned(),
        None,
    )
    .await
    .map_err(|e| format!("upload small src: {e}"))?;
    file_s3_copy_object(
        &state,
        cid.clone(),
        "small-src.txt".to_string(),
        "small-dst.txt".to_string(),
    )
    .await
    .map_err(|e| format!("small s3 copy: {e}"))?;
    let got = file_read_file(&state, cid.clone(), "small-dst.txt".to_string(), 1024.0)
        .await
        .map_err(|e| format!("read small dst: {e}"))?;
    assert_eq!(got, b"small copy payload");
    println!("OK s3 copy small (single)");

    println!("ALL OK");
    Ok(())
}
