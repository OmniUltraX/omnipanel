//! MCP 工具注册表 — 持久化于 omnipanel.db 的 mcp_tools 表。

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::app_module::{AppModuleStatus, DEFAULT_APP_MODULES};
use super::storage::{Storage, map_sqlite};

/// 默认 MCP 工具清单：(tool_name, module_key, description)
pub const DEFAULT_MCP_TOOLS: &[(&str, &str, &str)] = &[
    (
        "omni_terminal_run_terminal_command",
        "terminal",
        "在当前活动终端会话中执行 shell 命令。危险命令会进入用户确认流程；执行完成后返回退出码与输出。",
    ),
    (
        "omni_database_get_databases_from_connection",
        "database",
        "根据连接名获取该连接下的数据库列表，可选关键字过滤。",
    ),
    (
        "omni_database_get_tables_from_database",
        "database",
        "根据连接名和数据库名获取表列表，可选关键字过滤。",
    ),
    (
        "omni_database_get_table_info",
        "database",
        "根据连接名、数据库名和表名获取表结构信息（MySQL/MariaDB 执行 DESC，其他引擎使用 introspect）。",
    ),
    (
        "omni_database_execute_sql",
        "database",
        "在指定连接和数据库上执行 SQL。SELECT 结果最多返回 500 行；DML 返回影响行数。",
    ),
    (
        "omni_knowledge_create_document",
        "knowledge",
        "在知识库中创建文档。",
    ),
    (
        "omni_knowledge_remove_document",
        "knowledge",
        "按 ID 删除知识库文档。",
    ),
    (
        "omni_knowledge_list_documents",
        "knowledge",
        "列出知识库文档，可按类型或标签过滤。",
    ),
];

/// 持久化的 MCP 工具条目。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct McpToolRecord {
    pub tool_name: String,
    pub module_key: String,
    pub description: String,
    pub enabled: bool,
}

/// 从前端目录同步时的输入（不覆盖用户已设置的 enabled）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct McpToolCatalogEntry {
    pub tool_name: String,
    pub module_key: String,
    pub description: String,
}

impl Storage {
    /// 补种默认 MCP 工具（不覆盖已有行的 enabled）。
    pub fn repair_mcp_tools(&self) -> OmniResult<()> {
        for (name, module, desc) in DEFAULT_MCP_TOOLS {
            self.conn()
                .execute(
                    "INSERT OR IGNORE INTO mcp_tools (tool_name, module_key, description, enabled) VALUES (?1, ?2, ?3, 1)",
                    params![name, module, desc],
                )
                .map_err(map_sqlite)?;
        }
        Ok(())
    }

    /// 列出全部 MCP 工具。
    pub fn mcp_tool_list(&self) -> OmniResult<Vec<McpToolRecord>> {
        self.repair_mcp_tools()?;
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT tool_name, module_key, description, enabled FROM mcp_tools ORDER BY module_key ASC, tool_name ASC",
            )
            .map_err(map_sqlite)?;

        let rows = stmt
            .query_map([], |row| {
                Ok(McpToolRecord {
                    tool_name: row.get(0)?,
                    module_key: row.get(1)?,
                    description: row.get(2)?,
                    enabled: row.get::<_, i32>(3)? != 0,
                })
            })
            .map_err(map_sqlite)?;

        rows.collect::<Result<Vec<_>, _>>().map_err(map_sqlite)
    }

    /// 同步前端目录：新增工具并更新描述/模块，保留 enabled。
    pub fn mcp_tool_sync_catalog(&self, entries: &[McpToolCatalogEntry]) -> OmniResult<()> {
        self.repair_mcp_tools()?;
        for entry in entries {
            self.conn()
                .execute(
                    "INSERT INTO mcp_tools (tool_name, module_key, description, enabled) VALUES (?1, ?2, ?3, 1)
                     ON CONFLICT(tool_name) DO UPDATE SET
                       module_key = excluded.module_key,
                       description = excluded.description",
                    params![entry.tool_name, entry.module_key, entry.description],
                )
                .map_err(map_sqlite)?;
        }
        Ok(())
    }

    /// 设置 MCP 工具启用状态（模块未打开时不允许启用）。
    pub fn mcp_tool_set_enabled(&self, tool_name: &str, enabled: bool) -> OmniResult<McpToolRecord> {
        self.repair_mcp_tools()?;
        let tool = self.mcp_tool_get(tool_name)?;

        if enabled {
            self.repair_app_modules()?;
            let module = self.app_module_get(&tool.module_key)?;
            if module.status != AppModuleStatus::Open {
                return Err(OmniError::new(
                    ErrorCode::InvalidInput,
                    format!("模块 {} 未打开，无法启用 MCP 工具", tool.module_key),
                ));
            }
        }

        let updated = self
            .conn()
            .execute(
                "UPDATE mcp_tools SET enabled = ?1 WHERE tool_name = ?2",
                params![i32::from(enabled), tool_name],
            )
            .map_err(map_sqlite)?;

        if updated == 0 {
            return Err(OmniError::new(
                ErrorCode::NotFound,
                format!("未知 MCP 工具: {tool_name}"),
            ));
        }

        self.mcp_tool_get(tool_name)
    }

    /// 查询工具在 DB 中是否标记为启用。
    pub fn mcp_tool_is_enabled(&self, tool_name: &str) -> OmniResult<bool> {
        self.repair_mcp_tools()?;
        let result: Result<i32, _> = self.conn().query_row(
            "SELECT enabled FROM mcp_tools WHERE tool_name = ?1",
            [tool_name],
            |row| row.get(0),
        );
        match result {
            Ok(v) => Ok(v != 0),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(map_sqlite(e)),
        }
    }

    /// 工具是否可注册/可调用：DB 启用且所属模块为打开状态。
    pub fn mcp_tool_is_available(&self, tool_name: &str) -> OmniResult<bool> {
        self.repair_mcp_tools()?;
        self.repair_app_modules()?;
        let tool = match self.mcp_tool_get(tool_name) {
            Ok(t) => t,
            Err(_) => return Ok(false),
        };
        if !tool.enabled {
            return Ok(false);
        }
        let module = self.app_module_get(&tool.module_key)?;
        Ok(module.status == AppModuleStatus::Open)
    }

    /// 按模块批量设置 MCP 工具启用状态。
    pub fn mcp_tool_set_enabled_for_module(
        &self,
        module_key: &str,
        enabled: bool,
    ) -> OmniResult<()> {
        self.repair_mcp_tools()?;
        self.conn()
            .execute(
                "UPDATE mcp_tools SET enabled = ?1 WHERE module_key = ?2",
                params![i32::from(enabled), module_key],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 根据模块状态同步其下全部 MCP 工具（关闭/禁用时全部禁用）。
    pub fn mcp_tool_sync_with_module(&self, module_key: &str) -> OmniResult<()> {
        self.repair_mcp_tools()?;
        self.repair_app_modules()?;
        let module = self.app_module_get(module_key)?;
        if module.status != AppModuleStatus::Open {
            self.mcp_tool_set_enabled_for_module(module_key, false)?;
        }
        Ok(())
    }

    /// 按全部模块状态同步 MCP 工具（启动/迁移后调用）。
    pub fn mcp_tool_sync_all_modules(&self) -> OmniResult<()> {
        for (key, _, _) in DEFAULT_APP_MODULES {
            self.mcp_tool_sync_with_module(key)?;
        }
        Ok(())
    }

    fn mcp_tool_get(&self, tool_name: &str) -> OmniResult<McpToolRecord> {
        self.conn()
            .query_row(
                "SELECT tool_name, module_key, description, enabled FROM mcp_tools WHERE tool_name = ?1",
                [tool_name],
                |row| {
                    Ok(McpToolRecord {
                        tool_name: row.get(0)?,
                        module_key: row.get(1)?,
                        description: row.get(2)?,
                        enabled: row.get::<_, i32>(3)? != 0,
                    })
                },
            )
            .map_err(map_sqlite)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_module::AppModuleStatus;

    #[test]
    fn mcp_tool_module_sync() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .mcp_tool_set_enabled("omni_terminal_run_terminal_command", true)
            .unwrap();
        storage
            .app_module_set_status("terminal", AppModuleStatus::Closed)
            .unwrap();
        assert!(!storage
            .mcp_tool_is_enabled("omni_terminal_run_terminal_command")
            .unwrap());
        assert!(!storage
            .mcp_tool_is_available("omni_terminal_run_terminal_command")
            .unwrap());
    }

    #[test]
    fn mcp_tool_sync_and_toggle() {
        let storage = Storage::open_in_memory().unwrap();
        let list = storage.mcp_tool_list().unwrap();
        assert!(list.iter().any(|t| t.tool_name == "omni_terminal_run_terminal_command"));

        storage
            .mcp_tool_set_enabled("omni_terminal_run_terminal_command", false)
            .unwrap();
        assert!(!storage
            .mcp_tool_is_enabled("omni_terminal_run_terminal_command")
            .unwrap());

        storage
            .mcp_tool_sync_catalog(&[McpToolCatalogEntry {
                tool_name: "omni_terminal_run_terminal_command".to_string(),
                module_key: "terminal".to_string(),
                description: "updated desc".to_string(),
            }])
            .unwrap();
        assert!(!storage
            .mcp_tool_is_enabled("omni_terminal_run_terminal_command")
            .unwrap());
        let tool = storage
            .mcp_tool_get("omni_terminal_run_terminal_command")
            .unwrap();
        assert_eq!(tool.description, "updated desc");
    }
}
