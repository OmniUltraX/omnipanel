//! 目录递归展开为文件传输任务。

use omnipanel_error::{ErrorCode, OmniError};

use crate::provider::{TransferHost, TransferProtocol};
use crate::types::FileTransferItemSpec;
use crate::util::open_sftp;

pub async fn expand_transfer_items(
    host: &dyn TransferHost,
    items: &[FileTransferItemSpec],
) -> Result<Vec<FileTransferItemSpec>, OmniError> {
    let mut out = Vec::new();
    for item in items {
        if item.kind != "dir" {
            out.push(item.clone());
            continue;
        }
        expand_dir(
            host,
            &item.connection_id,
            &item.path,
            &item.name,
            "",
            &mut out,
        )
        .await?;
    }
    if out.is_empty() {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "目录为空，没有可传输的文件",
        ));
    }
    Ok(out)
}

async fn expand_dir(
    host: &dyn TransferHost,
    connection_id: &str,
    dir_path: &str,
    root_folder_name: &str,
    rel_prefix: &str,
    out: &mut Vec<FileTransferItemSpec>,
) -> Result<(), OmniError> {
    let entries = list_entries(host, connection_id, dir_path).await?;
    for entry in entries {
        let rel = if rel_prefix.is_empty() {
            format!("{root_folder_name}/{}", entry.name)
        } else {
            format!("{rel_prefix}/{}", entry.name)
        };
        if entry.kind == "dir" {
            Box::pin(expand_dir(
                host,
                connection_id,
                &entry.path,
                root_folder_name,
                &rel,
                out,
            ))
            .await?;
        } else {
            out.push(FileTransferItemSpec {
                connection_id: connection_id.to_string(),
                path: entry.path,
                kind: "file".into(),
                name: rel.replace('\\', "/"),
                size: entry.size,
            });
        }
    }
    Ok(())
}

struct Listed {
    name: String,
    path: String,
    kind: String,
    size: Option<f64>,
}

async fn list_entries(
    host: &dyn TransferHost,
    connection_id: &str,
    path: &str,
) -> Result<Vec<Listed>, OmniError> {
    if connection_id == host.local_connection_id() {
        let entries = host.list_local_dir(path)?;
        return Ok(entries
            .into_iter()
            .filter(|e| e.name != "." && e.name != "..")
            .map(|e| Listed {
                name: e.name,
                path: e.path,
                kind: e.kind,
                size: e.size,
            })
            .collect());
    }

    let proto = host.connection_protocol(connection_id).await?;
    match proto {
        TransferProtocol::Sftp => {
            let session = open_sftp(host, connection_id).await?;
            let entries = session.sftp_list(path).await?;
            Ok(entries
                .into_iter()
                .filter(|e| e.name != "." && e.name != "..")
                .map(|e| {
                    let full = if path.ends_with('/') {
                        format!("{path}{}", e.name)
                    } else {
                        format!("{path}/{}", e.name)
                    };
                    Listed {
                        name: e.name.clone(),
                        path: full,
                        kind: if e.is_dir {
                            "dir".into()
                        } else {
                            "file".into()
                        },
                        size: Some(e.size as f64),
                    }
                })
                .collect())
        }
        TransferProtocol::Local => {
            let p = host.resolve_local_path(path)?;
            let entries = host.list_local_dir(&p.to_string_lossy())?;
            Ok(entries
                .into_iter()
                .map(|e| Listed {
                    name: e.name,
                    path: e.path,
                    kind: e.kind,
                    size: e.size,
                })
                .collect())
        }
        _ => Err(OmniError::new(
            ErrorCode::InvalidInput,
            "当前协议暂不支持目录递归传输，请逐个选择文件",
        )),
    }
}
