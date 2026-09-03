use serde::{Deserialize, Serialize};
use specta::Type;

use crate::contribution::PluginContributes;
use crate::error::PluginError;
use crate::kind::PluginKind;
use crate::permission::PluginPermission;
use crate::platform::PluginPlatform;

/// 宿主插件 API 版本（破坏性变更时递增）。
pub const HOST_API_VERSION: u32 = 1;

/// 插件方法声明：`plugin_invoke` 网关白名单 + 权限注解（缺权即拒绝）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginMethodDecl {
    pub name: String,
    #[serde(default)]
    pub permissions: Vec<PluginPermission>,
    /// 写方法：宿主消费 `presenceToken` / `presenceTarget`，插件不得自行签发。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub danger_action: Option<String>,
}

/// 插件逻辑 / sidecar 入口声明。缺省 = 纯 L1 声明式插件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntryDecl {
    /// 逻辑包相对路径（如 `logic.wasm`）；位于安装目录内。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logic: Option<String>,
    /// T1 sidecar 可执行文件相对路径（如 `bin/omnipanel-engine-clickhouse`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver: Option<String>,
}

/// 引擎驱动运行时。缺省 = 宿主进程内（T0）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum PluginRuntime {
    Inproc,
    Sidecar,
    Http,
}

impl PluginEntryDecl {
    fn relative_ok(path: &str) -> bool {
        let path = path.trim();
        !path.is_empty()
            && !path.starts_with('/')
            && !path.starts_with('\\')
            && !path.split(['/', '\\']).any(|seg| seg == "..")
    }

    /// 合法性：相对路径、禁止 `..`、必须指向 .wasm / .js。
    pub fn validate_logic(&self) -> Result<(), PluginError> {
        let Some(path) = self.logic.as_deref().map(str::trim) else {
            return Ok(());
        };
        if !Self::relative_ok(path)
            || !{
                let p = path.to_ascii_lowercase();
                p.ends_with(".wasm") || p.ends_with(".js")
            }
        {
            return Err(PluginError::InvalidManifest(format!(
                "entry.logic 非法: {path}"
            )));
        }
        Ok(())
    }

    pub fn validate_driver(&self) -> Result<(), PluginError> {
        let Some(path) = self.driver.as_deref().map(str::trim) else {
            return Ok(());
        };
        if !Self::relative_ok(path) {
            return Err(PluginError::InvalidManifest(format!(
                "entry.driver 非法: {path}"
            )));
        }
        Ok(())
    }
}

/// 插件装载合同。第一方与后续磁盘/WASM 包共用。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub version: String,
    pub kind: PluginKind,
    #[serde(default)]
    pub contributes: PluginContributes,
    #[serde(default)]
    pub permissions: Vec<PluginPermission>,
    /// 网关白名单；未声明 method 一律 `UnknownMethod`。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub methods: Vec<PluginMethodDecl>,
    /// L2/L3/T1 入口声明；缺省为纯声明式插件。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<PluginEntryDecl>,
    /// 引擎驱动运行时；缺省视为宿主进程内。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<PluginRuntime>,
    /// 所需最低宿主 API 版本；超过宿主当前版本时拒绝装载。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_host_api: Option<u32>,
    /// 缺省 = 全平台；当前 OS 不在列表中则不 activate。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<PluginPlatform>>,
}

impl PluginManifest {
    pub fn from_json(raw: &str) -> Result<Self, PluginError> {
        let value: serde_json::Value = serde_json::from_str(raw)
            .map_err(|e| PluginError::InvalidManifest(format!("清单 JSON 无法解析: {e}")))?;
        Self::from_value(value)
    }

    pub fn from_value(value: serde_json::Value) -> Result<Self, PluginError> {
        if let Some(kind) = value.get("kind").and_then(|v| v.as_str()) {
            PluginKind::parse(kind).map_err(PluginError::UnknownKind)?;
        } else {
            return Err(PluginError::InvalidManifest("清单缺少 kind".into()));
        }
        serde_json::from_value(value).map_err(|e| PluginError::InvalidManifest(e.to_string()))
    }

    pub fn validate(&self) -> Result<(), PluginError> {
        if self.id.trim().is_empty() {
            return Err(PluginError::InvalidManifest("清单 id 不能为空".into()));
        }
        if self.version.trim().is_empty() {
            return Err(PluginError::InvalidManifest("清单 version 不能为空".into()));
        }
        if self.kind == PluginKind::Theme && !self.permissions.is_empty() {
            return Err(PluginError::InvalidManifest(
                "theme 插件 permissions 必须为空".into(),
            ));
        }
        let mut seen = std::collections::BTreeSet::new();
        for method in &self.methods {
            if method.name.trim().is_empty() {
                return Err(PluginError::InvalidManifest(
                    "methods[].name 不能为空".into(),
                ));
            }
            if !seen.insert(method.name.clone()) {
                return Err(PluginError::InvalidManifest(format!(
                    "methods 重复声明: {}",
                    method.name
                )));
            }
        }
        if let Some(entry) = &self.entry {
            entry.validate_logic()?;
            entry.validate_driver()?;
        }
        if self.runtime == Some(PluginRuntime::Sidecar) {
            let driver = self.driver_entry();
            if driver.is_none() {
                return Err(PluginError::InvalidManifest(
                    "runtime=sidecar 必须声明 entry.driver".into(),
                ));
            }
        }
        if let Some(min_api) = self.min_host_api {
            if min_api > HOST_API_VERSION {
                return Err(PluginError::InvalidManifest(format!(
                    "minHostApi {min_api} 高于宿主当前版本 {HOST_API_VERSION}"
                )));
            }
        }
        if let Some(home) = &self.contributes.ui.home {
            home.validate()?;
        }
        if let Some(module) = &self.contributes.module {
            let mut seen = std::collections::BTreeSet::new();
            for cap in &module.capabilities {
                if cap.id.trim().is_empty() {
                    return Err(PluginError::InvalidManifest(
                        "module.capabilities[].id 不能为空".into(),
                    ));
                }
                if !seen.insert(cap.id.clone()) {
                    return Err(PluginError::InvalidManifest(format!(
                        "module.capabilities 重复声明: {}",
                        cap.id
                    )));
                }
            }
        }
        Ok(())
    }

    /// L2 逻辑包相对路径（未声明则 None）。
    pub fn logic_entry(&self) -> Option<&str> {
        self.entry
            .as_ref()
            .and_then(|e| e.logic.as_deref())
            .map(str::trim)
            .filter(|p| !p.is_empty())
    }

    /// T1 sidecar 可执行文件相对路径（未声明则 None）。
    pub fn driver_entry(&self) -> Option<&str> {
        self.entry
            .as_ref()
            .and_then(|e| e.driver.as_deref())
            .map(str::trim)
            .filter(|p| !p.is_empty())
    }

    /// 网关白名单查询：未声明返回 None。
    pub fn declared_method(&self, name: &str) -> Option<&PluginMethodDecl> {
        self.methods.iter().find(|m| m.name == name)
    }

    pub fn supports_platform(&self, os: PluginPlatform) -> bool {
        match &self.platforms {
            None => true,
            Some(list) if list.is_empty() => true,
            Some(list) => list.contains(&os),
        }
    }
}
