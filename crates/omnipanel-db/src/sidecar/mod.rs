//! 数据库引擎 sidecar：进程外驱动 + JSON-RPC EngineSession 协议。

mod protocol;

#[cfg(feature = "sidecar-host")]
mod dbx_dialect;
#[cfg(feature = "sidecar-host")]
mod engine;
#[cfg(feature = "sidecar-host")]
mod host;
#[cfg(feature = "sidecar-host")]
mod plugin_gate;
#[cfg(feature = "sidecar-serve")]
mod serve;
#[cfg(feature = "sidecar-serve")]
mod serve_extra;

#[cfg(feature = "sidecar-host")]
pub use engine::{
    bundled_jre_java, find_java_binary, java_version_ok, launch_for_params, launch_from_driver_file,
    launch_from_driver_file_result, resolve_java_for_jar, set_plugin_engine_launches, EngineKind,
    EngineLaunch,
};
#[cfg(feature = "sidecar-host")]
pub use host::{
    connect_clickhouse, connect_engine, connect_launch, evict_all_external_launches,
    evict_all_of_kind, evict_clickhouse, evict_engine, evict_launch, invoke_json, invoke_query,
    resolve_clickhouse_sidecar, resolve_sidecar, SidecarDriver,
};
#[cfg(feature = "sidecar-host")]
pub use plugin_gate::{
    engine_plugin_allowed, engine_plugin_allowed_in, gated_plugin_id,
    reject_if_engine_plugin_disabled, reject_if_params_plugin_disabled, set_disabled_engine_plugins,
};
pub use protocol::{CLICKHOUSE_SIDECAR_BIN, PROTOCOL_VERSION};
#[cfg(feature = "sidecar-serve")]
pub use serve::{serve, serve_stdio};

#[cfg(all(test, feature = "sidecar-host"))]
mod tests {
    use super::*;
    use crate::sidecar::protocol::{HandshakeResult, RpcRequest, RpcResponse};
    use serde_json::json;

    #[test]
    fn handshake_json_roundtrip() {
        let req = RpcRequest::new(1, "handshake", json!({}));
        let raw = serde_json::to_string(&req).unwrap();
        let parsed: RpcRequest = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.method, "handshake");
        assert_eq!(parsed.id, 1);
        let _ = HandshakeResult {
            protocol_version: PROTOCOL_VERSION,
            engine: "clickhouse".into(),
            capabilities: vec![],
        };
        let _ = RpcResponse::ok(1, json!({}));
    }

    #[test]
    fn look_in_dir_finds_named_binary() {
        let dir = std::env::temp_dir().join(format!(
            "omni-ch-sidecar-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(super::host::sidecar_file_name(CLICKHOUSE_SIDECAR_BIN));
        std::fs::write(&path, b"x").unwrap();
        let found = super::host::look_in_dir(&dir, CLICKHOUSE_SIDECAR_BIN).expect("应找到 sidecar");
        assert_eq!(found, path);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn query_result_json_roundtrip() {
        use crate::sidecar::protocol::{decode_query_result, encode_query_result};
        use crate::QueryResult;
        let original = QueryResult {
            columns: vec!["id".into()],
            rows: vec![vec![json!(1)]],
            rows_affected: 0,
        };
        let back = decode_query_result(encode_query_result(&original)).unwrap();
        assert_eq!(back.columns, original.columns);
        assert_eq!(back.rows, original.rows);
        assert_eq!(back.rows_affected, original.rows_affected);
    }
}

#[cfg(all(test, feature = "sidecar-serve"))]
mod serve_tests {
    use super::*;
    use crate::sidecar::protocol::{HandshakeResult, RpcRequest, RpcResponse};
    use serde_json::json;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[tokio::test]
    async fn serve_handshake_over_duplex() {
        let (client, server) = tokio::io::duplex(16 * 1024);
        let (server_read, server_write) = tokio::io::split(server);
        let server_task = tokio::spawn(async move { serve(server_read, server_write).await });

        let (client_read, mut client_write) = tokio::io::split(client);
        let req = RpcRequest::new(7, "handshake", json!({}));
        let mut line = serde_json::to_string(&req).unwrap();
        line.push('\n');
        client_write.write_all(line.as_bytes()).await.unwrap();
        client_write.flush().await.unwrap();

        let mut reader = BufReader::new(client_read);
        let mut response_line = String::new();
        reader.read_line(&mut response_line).await.unwrap();
        let response: RpcResponse = serde_json::from_str(response_line.trim()).unwrap();
        assert!(response.error.is_none());
        let handshake: HandshakeResult =
            serde_json::from_value(response.result.unwrap()).unwrap();
        assert_eq!(handshake.protocol_version, PROTOCOL_VERSION);
        assert!(!handshake.engine.is_empty());
        assert!(handshake.capabilities.contains(&"connect".to_string()));

        drop(client_write);
        drop(reader);
        let _ = server_task.await;
    }

    #[tokio::test]
    async fn serve_rejects_unknown_method_before_connect() {
        let (client, server) = tokio::io::duplex(16 * 1024);
        let (server_read, server_write) = tokio::io::split(server);
        let server_task = tokio::spawn(async move { serve(server_read, server_write).await });

        let (client_read, mut client_write) = tokio::io::split(client);
        let req = RpcRequest::new(2, "version", json!({}));
        let mut line = serde_json::to_string(&req).unwrap();
        line.push('\n');
        client_write.write_all(line.as_bytes()).await.unwrap();
        client_write.flush().await.unwrap();

        let mut reader = BufReader::new(client_read);
        let mut response_line = String::new();
        reader.read_line(&mut response_line).await.unwrap();
        let response: RpcResponse = serde_json::from_str(response_line.trim()).unwrap();
        assert!(response
            .error
            .as_ref()
            .map(|e| e.message.contains("尚未 connect"))
            .unwrap_or(false));

        drop(client_write);
        drop(reader);
        let _ = server_task.await;
    }
}
