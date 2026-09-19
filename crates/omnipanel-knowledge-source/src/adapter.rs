//! 知识源适配器契约（`kind: knowledge` 插件 + 原生适配器共用）。
//!
//! 切分原则：适配器只管**列目录、取文档、解析成 Markdown**（可为 L2 JS）；
//! 落库、命名空间隔离、增量状态、调度由宿主引擎负责，适配器不写知识库。
//!
//! 方法调用是同步签名：L2 插件侧由调用方把异步网关桥接为阻塞调用
//! （见 `PluginAdapter` + `MethodCaller`）。

use serde::{Deserialize, Serialize};
use specta::Type;

/// 笔记本/目录。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KsNotebook {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
}

/// 文档引用（含变更指纹；指纹相同即跳过）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KsDocRef {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    /// 盒子/笔记本 id（归档与分区用）。
    pub box_id: String,
    /// 源内相对路径（展示与诊断用）。
    pub rel_path: String,
    /// 变更指纹：mtime 文本 / ETag / updatedAt，字符串比对。
    pub fingerprint: String,
    /// 解析出的文档标签（引擎合并进条目 tags；命名空间标签另由 adapter.tag 保证）。
    #[serde(default)]
    pub tags: Vec<String>,
}

/// 文档正文。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KsDocContent {
    pub title: String,
    pub markdown: String,
    #[serde(default)]
    pub updated_at_ms: Option<i64>,
}

/// 镜像资源上限（思源 assets 图片/附件；超限留原 URL，不同同步炸）。
pub const MAX_ASSET_BYTES: u64 = 32 * 1024 * 1024;

/// 数据源适配器（同步方法；L2 插件经 `PluginAdapter` 桥接）。
pub trait SourceAdapter {
    /// 命名空间（短串，如 `siyuan`；决定 source 前缀与默认标签）。
    fn namespace(&self) -> &str;

    /// 条目 id 映射（默认 `ks-<kind>-<id>`；存量源覆盖为旧格式）。
    fn folder_entry_id(&self, box_id: &str) -> String {
        format!("ks-box-{box_id}")
    }

    fn doc_entry_id(&self, doc_id: &str) -> String {
        format!("ks-doc-{doc_id}")
    }

    fn archive_folder_id(&self, box_id: &str) -> String {
        format!("ks-archive-{box_id}")
    }

    /// source 字段映射（默认 `import:ks:<ns>:…`，决定知识库"导入文档"分区）。
    fn folder_source(&self, box_id: &str) -> String {
        format!("import:ks:{}:box:{box_id}", self.namespace())
    }

    fn doc_source(&self, box_id: &str, doc_id: &str) -> String {
        format!("import:ks:{}:doc:{box_id}/{doc_id}", self.namespace())
    }

    fn archive_source(&self, box_id: &str) -> String {
        format!("import:ks:{}:archive:{box_id}", self.namespace())
    }

    /// 标签（默认 `[namespace]`；归档标签默认 `<tag>:archived`）。
    fn tag(&self) -> String {
        self.namespace().to_string()
    }

    fn archive_tag(&self) -> String {
        format!("{}:archived", self.tag())
    }

    /// 状态隔离键（默认 `plugin:<namespace>`）。
    fn source_key(&self) -> String {
        format!("plugin:{}", self.namespace())
    }

    /// 适配器种类标记（存配置行，供诊断）。
    fn adapter_kind(&self) -> &'static str {
        "plugin"
    }

    /// 文件状态键（默认 `<box>:<rel>`；存量源覆盖保持字节一致）。
    fn file_key(&self, doc: &KsDocRef) -> String {
        format!("{}:{}", doc.box_id, doc.rel_path)
    }

    fn list_notebooks(&self) -> Result<Vec<KsNotebook>, String>;
    fn list_documents(&self) -> Result<Vec<KsDocRef>, String>;
    fn get_document(&self, doc: &KsDocRef) -> Result<KsDocContent, String>;

    /// 是否接管镜像资源落盘（true 时引擎把正文 `assets/…` 引用收进附件目录并改写 URL）。
    fn asset_managed(&self) -> bool {
        false
    }

    /// 取镜像资源字节：`rel` 为正文里的 `assets/…` 相对路径；返回 (存储文件名, 字节)。
    /// 取不到返回 Ok(None)（引擎保留原 URL，不炸整篇）。
    fn fetch_asset(
        &self,
        _doc: &KsDocRef,
        _rel: &str,
    ) -> Result<Option<(String, Vec<u8>)>, String> {
        Ok(None)
    }
}

/// L2 方法调用方（由宿主实现：网关/QuickJS 桥接；测试可注入内存实现）。
pub trait MethodCaller: Send + Sync {
    fn call(
        &self,
        plugin_id: &str,
        method: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String>;
}

fn required_str(value: &serde_json::Value, key: &str, what: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{what} 缺少字段: {key}"))
}

/// 解析结果里的 `tags` 数组（思源 .sy 的文档标签；非法/超长项丢弃，最多 64 个）。
pub fn parse_doc_tags(value: &serde_json::Value) -> Vec<String> {
    const MAX_TAGS: usize = 64;
    const MAX_CHARS: usize = 64;
    let mut out = Vec::new();
    if let Some(arr) = value.get("tags").and_then(|v| v.as_array()) {
        for item in arr {
            let tag = item.as_str().unwrap_or("").trim().to_string();
            if tag.is_empty()
                || tag.chars().count() > MAX_CHARS
                || out.len() >= MAX_TAGS
                || out.contains(&tag)
            {
                continue;
            }
            out.push(tag);
        }
    }
    out
}

/// id/标签覆盖（迁移兼容用；缺省走 `ks` / `import:ks` / namespace）。
#[derive(Debug, Clone, Default)]
pub struct AdapterOptions {
    pub id_prefix: Option<String>,
    pub source_prefix: Option<String>,
    pub tag: Option<String>,
}

/// L2 插件适配器：按清单 `knowledgeSources[]` 声明的方法名调用。
/// 方法返回允许 `{ notebooks: [...] }` 包裹或裸数组（宿主归一化）。
pub struct PluginAdapter<C> {
    plugin_id: String,
    namespace: String,
    list_method: String,
    get_method: String,
    list_documents_method: String,
    options: AdapterOptions,
    /// 每次调用合并的底包参数（源配置值 + Vault 密钥，调用方特定键优先）。
    extra_args: serde_json::Value,
    caller: C,
}

impl<C> PluginAdapter<C> {
    pub fn new(
        plugin_id: impl Into<String>,
        namespace: impl Into<String>,
        list_method: impl Into<String>,
        get_method: impl Into<String>,
        list_documents_method: impl Into<String>,
        caller: C,
    ) -> Self {
        let namespace = namespace.into();
        let plugin_id = plugin_id.into();
        Self {
            plugin_id,
            namespace,
            list_method: list_method.into(),
            get_method: get_method.into(),
            list_documents_method: list_documents_method.into(),
            options: AdapterOptions::default(),
            extra_args: serde_json::Value::Null,
            caller,
        }
    }

    pub fn with_options(mut self, options: AdapterOptions) -> Self {
        self.options = options;
        self
    }

    /// 设置底包参数（源配置值 + Vault 密钥）。
    pub fn with_extra_args(mut self, args: serde_json::Value) -> Self {
        self.extra_args = args;
        self
    }

    /// 合并底包与调用方参数（调用方特定键优先）。
    fn merged_args(&self, specific: serde_json::Value) -> serde_json::Value {
        let base = self.extra_args.as_object();
        let over = specific.as_object();
        match (base, over) {
            (Some(base), Some(over)) => {
                let mut merged = base.clone();
                for (key, value) in over {
                    merged.insert(key.clone(), value.clone());
                }
                serde_json::Value::Object(merged)
            }
            _ => specific,
        }
    }

    fn parse_notebooks(&self, value: &serde_json::Value) -> Result<Vec<KsNotebook>, String> {
        let arr = value
            .as_array()
            .ok_or_else(|| "list 方法应返回数组".to_string())?;
        arr.iter()
            .map(|item| {
                Ok(KsNotebook {
                    id: required_str(item, "id", "notebook")?,
                    name: required_str(item, "name", "notebook").unwrap_or_else(|_| {
                        item.get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("未命名")
                            .to_string()
                    }),
                    parent_id: item
                        .get("parentId")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                })
            })
            .collect()
    }

    fn parse_docs(&self, value: &serde_json::Value) -> Result<Vec<KsDocRef>, String> {
        let arr = value
            .as_array()
            .ok_or_else(|| "listDocuments 应返回数组".to_string())?;
        arr.iter()
            .map(|item| {
                Ok(KsDocRef {
                    id: required_str(item, "id", "document")?,
                    title: item
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    parent_id: item
                        .get("parentId")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    box_id: item
                        .get("notebookId")
                        .or_else(|| item.get("parentId"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    rel_path: item
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    fingerprint: item
                        .get("updatedAt")
                        .map(|v| v.to_string())
                        .unwrap_or_default(),
                    tags: Vec::new(),
                })
            })
            .collect()
    }
}

impl<C: MethodCaller> SourceAdapter for PluginAdapter<C> {
    fn namespace(&self) -> &str {
        &self.namespace
    }

    fn folder_entry_id(&self, box_id: &str) -> String {
        let prefix = self.options.id_prefix.as_deref().unwrap_or("ks");
        format!("{prefix}-box-{box_id}")
    }

    fn doc_entry_id(&self, doc_id: &str) -> String {
        let prefix = self.options.id_prefix.as_deref().unwrap_or("ks");
        format!("{prefix}-doc-{doc_id}")
    }

    fn archive_folder_id(&self, box_id: &str) -> String {
        let prefix = self.options.id_prefix.as_deref().unwrap_or("ks");
        format!("{prefix}-archive-{box_id}")
    }

    fn folder_source(&self, box_id: &str) -> String {
        match self.options.source_prefix.as_deref() {
            Some(prefix) => format!("{prefix}:box:{box_id}"),
            // 缺省与 trait 一致：命名空间限定，避免跨插件 source 碰撞。
            None => format!("import:ks:{}:box:{box_id}", self.namespace),
        }
    }

    fn doc_source(&self, box_id: &str, doc_id: &str) -> String {
        match self.options.source_prefix.as_deref() {
            Some(prefix) => format!("{prefix}:doc:{box_id}/{doc_id}"),
            None => format!("import:ks:{}:doc:{box_id}/{doc_id}", self.namespace),
        }
    }

    fn archive_source(&self, box_id: &str) -> String {
        match self.options.source_prefix.as_deref() {
            Some(prefix) => format!("{prefix}:archive:{box_id}"),
            None => format!("import:ks:{}:archive:{box_id}", self.namespace),
        }
    }

    fn tag(&self) -> String {
        self.options
            .tag
            .clone()
            .unwrap_or_else(|| self.namespace.clone())
    }

    fn list_notebooks(&self) -> Result<Vec<KsNotebook>, String> {
        let value = self.caller.call(
            &self.plugin_id,
            &self.list_method,
            self.merged_args(serde_json::json!({})),
        )?;
        let arr = value.get("notebooks").unwrap_or(&value);
        self.parse_notebooks(arr)
    }

    fn list_documents(&self) -> Result<Vec<KsDocRef>, String> {
        let value = self.caller.call(
            &self.plugin_id,
            &self.list_documents_method,
            self.merged_args(serde_json::json!({})),
        )?;
        let arr = value.get("documents").unwrap_or(&value);
        self.parse_docs(arr)
    }

    fn get_document(&self, doc: &KsDocRef) -> Result<KsDocContent, String> {
        let value = self.caller.call(
            &self.plugin_id,
            &self.get_method,
            self.merged_args(serde_json::json!({ "id": doc.id })),
        )?;
        let doc = value.get("document").unwrap_or(&value);
        Ok(KsDocContent {
            title: doc
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            markdown: doc
                .get("markdown")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            updated_at_ms: doc.get("updatedAt").and_then(|v| v.as_i64()),
        })
    }
}
