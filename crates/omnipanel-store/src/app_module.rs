//! 应用模块状态 — 持久化于 omnipanel.db 的 app_modules 表。
//!
//! - `open`：打开，侧栏可见且可访问
//! - `closed`：关闭，用户主动隐藏
//! - `disabled`：禁用，开发中模块，用户不可切换

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::storage::{Storage, map_sqlite};

/// 模块运行状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AppModuleStatus {
    Open,
    Closed,
    Disabled,
}

impl AppModuleStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
            Self::Disabled => "disabled",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "open" => Some(Self::Open),
            "closed" => Some(Self::Closed),
            "disabled" => Some(Self::Disabled),
            _ => None,
        }
    }
}

/// 默认模块清单：(module_key, sort_order, status)
pub const DEFAULT_APP_MODULES: &[(&str, i32, AppModuleStatus)] = &[
    ("terminal", 0, AppModuleStatus::Open),
    ("database", 1, AppModuleStatus::Open),
    ("ssh", 2, AppModuleStatus::Open),
    ("docker", 3, AppModuleStatus::Open),
    ("server", 4, AppModuleStatus::Open),
    ("files", 5, AppModuleStatus::Open),
    ("protocol", 6, AppModuleStatus::Open),
    ("workflow", 7, AppModuleStatus::Disabled),
    ("knowledge", 8, AppModuleStatus::Open),
    ("web", 9, AppModuleStatus::Open),
];

/// 持久化的模块配置条目。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AppModule {
    pub module_key: String,
    pub status: AppModuleStatus,
    pub sort_order: i32,
}

fn row_to_app_module(row: &rusqlite::Row<'_>) -> rusqlite::Result<AppModule> {
    let status_raw: String = row.get(1)?;
    let status = AppModuleStatus::parse(&status_raw).unwrap_or(AppModuleStatus::Closed);
    Ok(AppModule {
        module_key: row.get(0)?,
        status,
        sort_order: row.get(2)?,
    })
}

impl Storage {
    /// 确保 app_modules 表包含所有已知模块（新增模块时补种，不覆盖用户配置）。
    pub fn repair_app_modules(&self) -> OmniResult<()> {
        for (key, order, status) in DEFAULT_APP_MODULES {
            self.conn()
                .execute(
                    "INSERT OR IGNORE INTO app_modules (module_key, status, sort_order) VALUES (?1, ?2, ?3)",
                    params![key, status.as_str(), order],
                )
                .map_err(map_sqlite)?;
        }
        Ok(())
    }

    pub(crate) fn app_module_get(&self, module_key: &str) -> OmniResult<AppModule> {
        self.conn()
            .query_row(
                "SELECT module_key, status, sort_order FROM app_modules WHERE module_key = ?1",
                [module_key],
                row_to_app_module,
            )
            .map_err(map_sqlite)
    }

    /// 列出全部模块，按 sort_order 排序。
    pub fn app_module_list(&self) -> OmniResult<Vec<AppModule>> {
        self.repair_app_modules()?;
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT module_key, status, sort_order FROM app_modules ORDER BY sort_order ASC, module_key ASC",
            )
            .map_err(map_sqlite)?;

        let rows = stmt
            .query_map([], row_to_app_module)
            .map_err(map_sqlite)?;

        rows.collect::<Result<Vec<_>, _>>().map_err(map_sqlite)
    }

    /// 更新单个模块状态（用户仅可设为 open / closed；disabled 模块不可改）。
    pub fn app_module_set_status(
        &self,
        module_key: &str,
        status: AppModuleStatus,
    ) -> OmniResult<AppModule> {
        if status == AppModuleStatus::Disabled {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "无法将模块设为禁用状态",
            ));
        }

        self.repair_app_modules()?;
        let current = self.app_module_get(module_key)?;

        if current.status == AppModuleStatus::Disabled {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("模块 {module_key} 正在开发中，暂不可配置"),
            ));
        }

        let updated = self
            .conn()
            .execute(
                "UPDATE app_modules SET status = ?1 WHERE module_key = ?2",
                params![status.as_str(), module_key],
            )
            .map_err(map_sqlite)?;

        if updated == 0 {
            return Err(OmniError::new(
                ErrorCode::NotFound,
                format!("未知模块: {module_key}"),
            ));
        }

        // 由非 open 转为 open 时恢复其下工具；转为非 open 时禁用其下工具。
        if status == AppModuleStatus::Open && current.status != AppModuleStatus::Open {
            self.builtin_tool_restore_for_module(module_key)?;
        } else {
            self.builtin_tool_sync_with_module(module_key)?;
        }

        self.app_module_get(module_key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_module_defaults_and_status() {
        let storage = Storage::open_in_memory().unwrap();
        let modules = storage.app_module_list().unwrap();
        assert_eq!(modules.len(), DEFAULT_APP_MODULES.len());

        let workflow = modules.iter().find(|m| m.module_key == "workflow").unwrap();
        assert_eq!(workflow.status, AppModuleStatus::Disabled);

        let err = storage
            .app_module_set_status("workflow", AppModuleStatus::Open)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);

        let updated = storage
            .app_module_set_status("terminal", AppModuleStatus::Closed)
            .unwrap();
        assert_eq!(updated.status, AppModuleStatus::Closed);

        let again = storage.app_module_list().unwrap();
        let terminal = again.iter().find(|m| m.module_key == "terminal").unwrap();
        assert_eq!(terminal.status, AppModuleStatus::Closed);
    }
}
