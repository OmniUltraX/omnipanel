//! 内置工具注册表 — 持久化于 omnipanel.db 的 builtin_tools 表。

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::app_module::{AppModuleStatus, DEFAULT_APP_MODULES};
use super::builtin_tool_spec::BUILTIN_TOOL_SPECS;
use super::storage::{Storage, map_sqlite};

/// 持久化的内置工具条目。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct BuiltinToolRecord {
    pub tool_name: String,
    pub module_key: String,
    pub description: String,
    /// 内部编排 ToolRegistry 是否加载
    pub internal_enabled: bool,
    /// 是否经 OmniMCP 对外暴露
    pub external_exposed: bool,
    /// 工具参数 JSON Schema（后端 spec 为准，供前端渲染/校验与模型注入）
    pub input_schema: String,
}

/// 从前端目录同步时的输入（不覆盖用户已设置的 enabled）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct BuiltinToolCatalogEntry {
    pub tool_name: String,
    pub module_key: String,
    pub description: String,
}

impl Storage {
    /// 以后端 spec 为准补种/修复内置工具：
    /// - 新工具按默认开关写入；
    /// - 已存在行更新 module_key / description / input_schema（保留用户开关）。
    pub fn repair_builtin_tools(&self) -> OmniResult<()> {
        self.ensure_builtin_tool_columns()?;
        for spec in BUILTIN_TOOL_SPECS {
            self.conn()
                .execute(
                    "INSERT INTO builtin_tools (tool_name, module_key, description, enabled, internal_enabled, external_exposed, input_schema)
                     VALUES (?1, ?2, ?3, 1, 1, 1, ?4)
                     ON CONFLICT(tool_name) DO UPDATE SET
                       module_key = excluded.module_key,
                       description = excluded.description,
                       input_schema = excluded.input_schema",
                    params![spec.tool_name, spec.module_key, spec.description, spec.input_schema],
                )
                .map_err(map_sqlite)?;
        }
        Ok(())
    }

    fn ensure_builtin_tool_columns(&self) -> OmniResult<()> {
        let mut stmt = self
            .conn()
            .prepare("PRAGMA table_info(builtin_tools)")
            .map_err(map_sqlite)?;
        let cols: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(map_sqlite)?
            .collect::<Result<_, _>>()
            .map_err(map_sqlite)?;
        if !cols.iter().any(|c| c == "internal_enabled") {
            self.conn()
                .execute(
                    "ALTER TABLE builtin_tools ADD COLUMN internal_enabled INTEGER NOT NULL DEFAULT 1",
                    [],
                )
                .map_err(map_sqlite)?;
            self.conn()
                .execute(
                    "UPDATE builtin_tools SET internal_enabled = enabled",
                    [],
                )
                .ok();
        }
        if !cols.iter().any(|c| c == "external_exposed") {
            self.conn()
                .execute(
                    "ALTER TABLE builtin_tools ADD COLUMN external_exposed INTEGER NOT NULL DEFAULT 1",
                    [],
                )
                .map_err(map_sqlite)?;
        }
        if !cols.iter().any(|c| c == "input_schema") {
            self.conn()
                .execute(
                    "ALTER TABLE builtin_tools ADD COLUMN input_schema TEXT NOT NULL DEFAULT ''",
                    [],
                )
                .map_err(map_sqlite)?;
        }
        Ok(())
    }

    /// 列出全部内置工具。
    pub fn builtin_tool_list(&self) -> OmniResult<Vec<BuiltinToolRecord>> {
        self.repair_builtin_tools()?;
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT tool_name, module_key, description, internal_enabled, external_exposed, input_schema FROM builtin_tools ORDER BY module_key ASC, tool_name ASC",
            )
            .map_err(map_sqlite)?;

        let rows = stmt
            .query_map([], |row| {
                Ok(BuiltinToolRecord {
                    tool_name: row.get(0)?,
                    module_key: row.get(1)?,
                    description: row.get(2)?,
                    internal_enabled: row.get::<_, i32>(3)? != 0,
                    external_exposed: row.get::<_, i32>(4)? != 0,
                    input_schema: row.get(5)?,
                })
            })
            .map_err(map_sqlite)?;

        rows.collect::<Result<Vec<_>, _>>().map_err(map_sqlite)
    }

    /// 同步前端目录：仅登记后端 spec 未涵盖的「未知工具」，不覆盖任何既有行。
    ///
    /// 内置工具的 module_key / description / input_schema 一律以后端
    /// `BUILTIN_TOOL_SPECS` 单一真相源为准（`repair_builtin_tools` 会持续校正），
    /// 故此处对已存在工具不做修改，避免与真相源冲突。
    pub fn builtin_tool_sync_catalog(&self, entries: &[BuiltinToolCatalogEntry]) -> OmniResult<()> {
        self.repair_builtin_tools()?;
        for entry in entries {
            self.conn()
                .execute(
                    "INSERT OR IGNORE INTO builtin_tools (tool_name, module_key, description, enabled, internal_enabled, external_exposed, input_schema) VALUES (?1, ?2, ?3, 1, 1, 1, '')",
                    params![entry.tool_name, entry.module_key, entry.description],
                )
                .map_err(map_sqlite)?;
        }
        Ok(())
    }

    /// 设置内置工具「内部可用」状态。
    pub fn builtin_tool_set_internal_enabled(
        &self,
        tool_name: &str,
        enabled: bool,
    ) -> OmniResult<BuiltinToolRecord> {
        self.repair_builtin_tools()?;
        let tool = self.builtin_tool_get(tool_name)?;

        if enabled {
            self.repair_app_modules()?;
            let module = self.app_module_get(&tool.module_key)?;
            if module.status != AppModuleStatus::Open {
                return Err(OmniError::new(
                    ErrorCode::InvalidInput,
                    format!("模块 {} 未打开，无法启用内置工具", tool.module_key),
                ));
            }
        }

        self.conn()
            .execute(
                "UPDATE builtin_tools SET internal_enabled = ?1, enabled = ?1 WHERE tool_name = ?2",
                params![i32::from(enabled), tool_name],
            )
            .map_err(map_sqlite)?;

        self.builtin_tool_get(tool_name)
    }

    /// 设置内置工具「对外暴露」状态（OmniMCP 对外可见）。
    ///
    /// 开启暴露要求所属模块处于 open；具体能否被外部 MCP 直调取决于后端是否已实现
    ///（Native 只读/写工具可直调，UiDelegated 工具可在列表中暴露但直调需桌面端会话）。
    pub fn builtin_tool_set_external_exposed(
        &self,
        tool_name: &str,
        exposed: bool,
    ) -> OmniResult<BuiltinToolRecord> {
        self.repair_builtin_tools()?;
        let tool = self.builtin_tool_get(tool_name)?;

        if exposed {
            self.repair_app_modules()?;
            let module = self.app_module_get(&tool.module_key)?;
            if module.status != AppModuleStatus::Open {
                return Err(OmniError::new(
                    ErrorCode::InvalidInput,
                    format!("模块 {} 未打开，无法开启对外暴露", tool.module_key),
                ));
            }
        }

        self.conn()
            .execute(
                "UPDATE builtin_tools SET external_exposed = ?1 WHERE tool_name = ?2",
                params![i32::from(exposed), tool_name],
            )
            .map_err(map_sqlite)?;
        self.builtin_tool_get(tool_name)
    }

    /// 设置内置工具启用状态（兼容旧 API，等同 internal_enabled）。
    pub fn builtin_tool_set_enabled(&self, tool_name: &str, enabled: bool) -> OmniResult<BuiltinToolRecord> {
        self.builtin_tool_set_internal_enabled(tool_name, enabled)
    }

    /// 查询工具在 DB 中是否标记为内部可用。
    pub fn builtin_tool_is_enabled(&self, tool_name: &str) -> OmniResult<bool> {
        self.repair_builtin_tools()?;
        let result: Result<i32, _> = self.conn().query_row(
            "SELECT internal_enabled FROM builtin_tools WHERE tool_name = ?1",
            [tool_name],
            |row| row.get(0),
        );
        match result {
            Ok(v) => Ok(v != 0),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(map_sqlite(e)),
        }
    }

    /// 查询工具是否对外暴露。
    pub fn builtin_tool_is_exposed(&self, tool_name: &str) -> OmniResult<bool> {
        self.repair_builtin_tools()?;
        let result: Result<i32, _> = self.conn().query_row(
            "SELECT external_exposed FROM builtin_tools WHERE tool_name = ?1",
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
    pub fn builtin_tool_is_available(&self, tool_name: &str) -> OmniResult<bool> {
        self.repair_builtin_tools()?;
        self.repair_app_modules()?;
        let tool = match self.builtin_tool_get(tool_name) {
            Ok(t) => t,
            Err(_) => return Ok(false),
        };
        if !tool.internal_enabled {
            return Ok(false);
        }
        let module = self.app_module_get(&tool.module_key)?;
        Ok(module.status == AppModuleStatus::Open)
    }

    /// 工具是否可经 OmniMCP 对外暴露：external_exposed 且模块打开。
    pub fn builtin_tool_is_exposed_available(&self, tool_name: &str) -> OmniResult<bool> {
        self.repair_builtin_tools()?;
        self.repair_app_modules()?;
        let tool = match self.builtin_tool_get(tool_name) {
            Ok(t) => t,
            Err(_) => return Ok(false),
        };
        if !tool.external_exposed {
            return Ok(false);
        }
        let module = self.app_module_get(&tool.module_key)?;
        Ok(module.status == AppModuleStatus::Open)
    }

    /// 按模块批量设置内置工具内部可用状态。
    pub fn builtin_tool_set_enabled_for_module(
        &self,
        module_key: &str,
        enabled: bool,
    ) -> OmniResult<()> {
        self.repair_builtin_tools()?;
        self.conn()
            .execute(
                "UPDATE builtin_tools SET internal_enabled = ?1, enabled = ?1 WHERE module_key = ?2",
                params![i32::from(enabled), module_key],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 根据模块状态同步其下全部内置工具（关闭/禁用时全部禁用）。
    ///
    /// 注意：此方法会在启动时对所有模块调用，故**不**在此恢复工具，
    /// 以免覆盖用户手动禁用。恢复仅在模块 open 状态转换时由
    /// `builtin_tool_restore_for_module` 触发（见 `app_module_set_status`）。
    pub fn builtin_tool_sync_with_module(&self, module_key: &str) -> OmniResult<()> {
        self.repair_builtin_tools()?;
        self.repair_app_modules()?;
        let module = self.app_module_get(module_key)?;
        if module.status != AppModuleStatus::Open {
            self.builtin_tool_set_enabled_for_module(module_key, false)?;
        }
        Ok(())
    }

    /// 模块由非 open 转为 open 时恢复其下工具为可用（粗策略：全部置为 internal_enabled）。
    /// 仅应在 open 状态转换时调用，不可在启动时对所有模块调用。
    pub fn builtin_tool_restore_for_module(&self, module_key: &str) -> OmniResult<()> {
        self.repair_builtin_tools()?;
        self.builtin_tool_set_enabled_for_module(module_key, true)
    }

    /// 按全部模块状态同步内置工具（启动/迁移后调用）。
    pub fn builtin_tool_sync_all_modules(&self) -> OmniResult<()> {
        for (key, _, _) in DEFAULT_APP_MODULES {
            self.builtin_tool_sync_with_module(key)?;
        }
        Ok(())
    }

    fn builtin_tool_get(&self, tool_name: &str) -> OmniResult<BuiltinToolRecord> {
        self.conn()
            .query_row(
                "SELECT tool_name, module_key, description, internal_enabled, external_exposed, input_schema FROM builtin_tools WHERE tool_name = ?1",
                [tool_name],
                |row| {
                    Ok(BuiltinToolRecord {
                        tool_name: row.get(0)?,
                        module_key: row.get(1)?,
                        description: row.get(2)?,
                        internal_enabled: row.get::<_, i32>(3)? != 0,
                        external_exposed: row.get::<_, i32>(4)? != 0,
                        input_schema: row.get(5)?,
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
    fn builtin_tool_module_sync() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .builtin_tool_set_enabled("omni_terminal_run_terminal_command", true)
            .unwrap();
        storage
            .app_module_set_status("terminal", AppModuleStatus::Closed)
            .unwrap();
        assert!(!storage
            .builtin_tool_is_enabled("omni_terminal_run_terminal_command")
            .unwrap());
        assert!(!storage
            .builtin_tool_is_available("omni_terminal_run_terminal_command")
            .unwrap());
    }

    #[test]
    fn builtin_tool_sync_and_toggle() {
        let storage = Storage::open_in_memory().unwrap();
        let list = storage.builtin_tool_list().unwrap();
        assert!(list.iter().any(|t| t.tool_name == "omni_terminal_run_terminal_command"));

        storage
            .builtin_tool_set_enabled("omni_terminal_run_terminal_command", false)
            .unwrap();
        assert!(!storage
            .builtin_tool_is_enabled("omni_terminal_run_terminal_command")
            .unwrap());

        // 前端 catalog 不再覆盖内置工具描述：单一真相源以后端 spec 为准，
        // 且用户开关（internal_enabled=false）保留。
        storage
            .builtin_tool_sync_catalog(&[BuiltinToolCatalogEntry {
                tool_name: "omni_terminal_run_terminal_command".to_string(),
                module_key: "terminal".to_string(),
                description: "updated desc".to_string(),
            }])
            .unwrap();
        assert!(!storage
            .builtin_tool_is_enabled("omni_terminal_run_terminal_command")
            .unwrap());
        let tool = storage
            .builtin_tool_get("omni_terminal_run_terminal_command")
            .unwrap();
        assert_ne!(tool.description, "updated desc");
        assert!(!tool.input_schema.is_empty(), "内置工具应带 spec schema");
    }

    #[test]
    fn builtin_tool_list_carries_input_schema() {
        let storage = Storage::open_in_memory().unwrap();
        let list = storage.builtin_tool_list().unwrap();
        let term = list
            .iter()
            .find(|t| t.tool_name == "omni_terminal_run_terminal_command")
            .unwrap();
        let schema: serde_json::Value = serde_json::from_str(&term.input_schema).unwrap();
        let required = schema.get("required").and_then(|r| r.as_array()).unwrap();
        assert!(required.iter().any(|x| x.as_str() == Some("command")));
    }

    #[test]
    fn external_exposed_allows_all_builtin_tools_when_module_open() {
        let storage = Storage::open_in_memory().unwrap();
        assert!(storage
            .builtin_tool_set_external_exposed("omni_terminal_run_terminal_command", true)
            .is_ok());
        assert!(storage
            .builtin_tool_set_external_exposed("omni_database_list_connections", true)
            .is_ok());
    }

    #[test]
    fn external_exposed_rejects_when_module_closed() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .app_module_set_status("terminal", AppModuleStatus::Closed)
            .unwrap();
        let err = storage
            .builtin_tool_set_external_exposed("omni_terminal_run_terminal_command", true)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn module_reopen_restores_tools() {
        let storage = Storage::open_in_memory().unwrap();
        // 关闭 database 模块 → 其工具被禁用
        storage
            .app_module_set_status("database", AppModuleStatus::Closed)
            .unwrap();
        assert!(!storage
            .builtin_tool_is_enabled("omni_database_execute_sql")
            .unwrap());
        // 重新打开 → 工具恢复
        storage
            .app_module_set_status("database", AppModuleStatus::Open)
            .unwrap();
        assert!(storage
            .builtin_tool_is_enabled("omni_database_execute_sql")
            .unwrap());
    }
}
