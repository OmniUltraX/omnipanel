//! 验证 relay：S3 → S3 同桶（服务端拷贝优先，回落内存 relay）。
use std::sync::Arc;

use omnipanel_server::state::ServerState;
use omnipanel_server::transfer::{transfer_start, TransferStartRequest};
use omnipanel_store::{Connection, ConnectionKind};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let state = Arc::new(ServerState::new());
    let conn = Connection {
        id: "file-s3-src".to_string(),
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
        }).to_string(),
        credential_ref: None,
        created_at: 0,
        updated_at: 0,
    };
    {
        let storage = state.storage.lock().await;
        storage.save_connection(&conn)?;
    }

    // 先在 S3 放源对象
    let client = omnipanel_s3::S3Client::new(
        omnipanel_s3::S3Config {
            bucket: "test-bucket".to_string(),
            provider: "aws".to_string(),
            region: "us-east-1".to_string(),
            endpoint: "http://127.0.0.1:19000".to_string(),
            access_key: "minioadmin".to_string(),
            ..Default::default()
        },
        "minioadmin".to_string(),
    )?;
    client.put_object("s3s3/src.txt", b"s3 to s3 same bucket").await?;

    // S3 → S3（同连接）
    let job = transfer_start(
        state.clone(),
        TransferStartRequest {
            source_connection_id: conn.id.clone(),
            source_path: "s3s3/src.txt".to_string(),
            dest_connection_id: conn.id.clone(),
            dest_path: "s3s3/dst.txt".to_string(),
            conflict_policy: Some("overwrite".to_string()),
            resume: true,
        },
    )
    .await?;
    println!("S3→S3 job: {job}");
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    let data = client.get_object("s3s3/dst.txt").await?;
    assert_eq!(data, b"s3 to s3 same bucket");
    println!("RELAY S3↔S3 PASSED ✅");
    Ok(())
}
