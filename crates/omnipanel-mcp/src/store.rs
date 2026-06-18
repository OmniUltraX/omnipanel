use std::fs;
use std::path::Path;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_store::mcp_services_path;

use crate::types::{McpServiceConfig, McpServicesFile, BUILTIN_SERVICE_ID};

pub fn load_services_file() -> OmniResult<McpServicesFile> {
    let path = mcp_services_path()?;
    if !path.exists() {
        return Ok(McpServicesFile::default());
    }
    let raw = fs::read_to_string(&path).map_err(map_io)?;
    if raw.trim().is_empty() {
        return Ok(McpServicesFile::default());
    }
    match serde_json::from_str::<McpServicesFile>(&raw) {
        Ok(file) => Ok(normalize_file(file)),
        Err(err) => {
            tracing::warn!(
                path = %path.display(),
                error = %err,
                "解析 MCP 配置失败，使用空配置"
            );
            Ok(McpServicesFile::default())
        }
    }
}

pub fn save_services_file(file: &McpServicesFile) -> OmniResult<()> {
    let path = mcp_services_path()?;
    write_json_atomic(&path, file)
}

fn normalize_file(mut file: McpServicesFile) -> McpServicesFile {
    file.services.retain(|s| !s.builtin && s.id != BUILTIN_SERVICE_ID);
    file
}

fn write_json_atomic(path: &Path, file: &McpServicesFile) -> OmniResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(map_io)?;
    }
    let tmp = path.with_extension("json.tmp");
    let json =
        serde_json::to_string_pretty(file).map_err(|e| OmniError::new(ErrorCode::Internal, e.to_string()))?;
    fs::write(&tmp, json.as_bytes()).map_err(map_io)?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path).map_err(map_io)?;
    Ok(())
}

pub fn upsert_custom_service(
    file: &mut McpServicesFile,
    service: McpServiceConfig,
) -> OmniResult<McpServiceConfig> {
    if service.builtin {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "不能修改内置 MCP 服务配置",
        ));
    }
    if service.name.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "服务名称不能为空"));
    }
    validate_transport(&service.transport)?;

    if let Some(existing) = file.services.iter_mut().find(|s| s.id == service.id) {
        *existing = service.clone();
    } else {
        file.services.push(service.clone());
    }
    save_services_file(file)?;
    Ok(service)
}

pub fn delete_custom_service(file: &mut McpServicesFile, id: &str) -> OmniResult<()> {
    if id == BUILTIN_SERVICE_ID {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "不能删除内置 OmniMCP 服务",
        ));
    }
    let before = file.services.len();
    file.services.retain(|s| s.id != id);
    if file.services.len() == before {
        return Err(OmniError::new(ErrorCode::NotFound, "MCP 服务不存在"));
    }
    save_services_file(file)
}

pub fn set_service_enabled(
    file: &mut McpServicesFile,
    id: &str,
    enabled: bool,
) -> OmniResult<McpServiceConfig> {
    let service = file
        .services
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "MCP 服务不存在"))?;
    if service.builtin {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "内置 OmniMCP 服务始终启用",
        ));
    }
    service.enabled = enabled;
    let cloned = service.clone();
    save_services_file(file)?;
    Ok(cloned)
}

fn validate_transport(transport: &crate::types::McpTransport) -> OmniResult<()> {
    use crate::types::McpTransport;
    match transport {
        McpTransport::Stdio { config } => {
            if config.command.trim().is_empty() {
                return Err(OmniError::new(ErrorCode::InvalidInput, "stdio 命令不能为空"));
            }
        }
        McpTransport::Sse { config } => {
            if config.url.trim().is_empty() {
                return Err(OmniError::new(ErrorCode::InvalidInput, "SSE URL 不能为空"));
            }
        }
    }
    Ok(())
}

fn map_io(err: std::io::Error) -> OmniError {
    OmniError::new(ErrorCode::Io, "读写 MCP 配置失败").with_cause(err.to_string())
}
