//! 验证 relay：local → S3（经 temp 中转）与 S3 → local。
use std::sync::Arc;

use omnipanel_server::state::ServerState;
use omnipanel_server::transfer::{TransferStartRequest, transfer_start};
use omnipanel_store::{Connection, ConnectionKind};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let state = Arc::new(ServerState::new());
    let conn = Connection {
        id: "file-s3-relay".to_string(),
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
    };
    {
        let storage = state.storage.lock().await;
        storage.save_connection(&conn)?;
    }

    // 本地源文件
    let src = std::env::temp_dir().join("relay-src.txt");
    tokio::fs::write(&src, b"hello relay to s3").await?;

    // local → S3
    let job = transfer_start(
        state.clone(),
        TransferStartRequest {
            source_connection_id: "file-local".to_string(),
            source_path: src.to_str().unwrap().to_string(),
            dest_connection_id: conn.id.clone(),
            dest_path: "relay/from-local.txt".to_string(),
            conflict_policy: Some("overwrite".to_string()),
            resume: true,
        },
    )
    .await?;
    println!("local→S3 job: {job}");
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    // S3 → local
    let dst = std::env::temp_dir().join("relay-dst.txt");
    let job2 = transfer_start(
        state.clone(),
        TransferStartRequest {
            source_connection_id: conn.id.clone(),
            source_path: "relay/from-local.txt".to_string(),
            dest_connection_id: "file-local".to_string(),
            dest_path: dst.to_str().unwrap().to_string(),
            conflict_policy: Some("overwrite".to_string()),
            resume: true,
        },
    )
    .await?;
    println!("S3→local job: {job2}");
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    let data = tokio::fs::read(&dst).await?;
    assert_eq!(data, b"hello relay to s3");
    println!("RELAY local↔S3 PASSED ✅");
    Ok(())
}
