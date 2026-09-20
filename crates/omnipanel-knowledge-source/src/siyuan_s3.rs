//! 思源 S3 知识源：dejavu 加密仓库读取（端到端解密后只读镜像）。
//!
//! 格式依据 `siyuan-note/dejavu` 的公开行为（AGPL 项目，洁净室实现，只复用格式事实）：
//! - 云端键：`repo/refs/latest`（40hex）→ `repo/indexes/<id>`（仅 zstd）→
//!   `repo/objects/<2hex>/<38hex>`（zstd + AES-256-GCM，nonce 前置 12B）。
//! - 密钥：32 字节 base64 口令直接当密钥；否则
//!   `scrypt(pass, hex(sha256(pass))[:16], N=32768, r=8, p=1)` 派生 32B。
//! - 文件字节 = File.chunks 顺序拼接各 chunk 明文；`.sy` 明文与本地盘格式一致，
//!   解析复用插件 `parseMethod`（与本地源同一 JS），宿主只负责拉取与解密。
//!
//! 限制：解密后仍是密文的加密笔记本（DEK 在思源内核）不在本层处理，原样跳过由
//! 解析器降级；S3 传输复用 `omnipanel-s3`（SigV4/厂商兼容）。

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Mutex;

use base64::Engine as _;
use omnipanel_s3::{S3Client, S3Config};
use sha2::Digest as _;

use super::adapter::{
    KsDocContent, KsDocRef, KsNotebook, MAX_ASSET_BYTES, MethodCaller, SourceAdapter,
};
use super::local::MAX_PARSE_BYTES;

/// S3 思源源配置（console 表单值 + Vault 密钥拼装，见 `knowledge_source::s3_config_of`）。
#[derive(Debug, Clone, Default)]
pub struct SiyuanS3Config {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub provider: String,
    pub access_key: String,
    pub secret_key: String,
    pub repo_password: String,
    pub prefix: String,
}

// ── dejavu 纯格式层（无 I/O，可单测） ─────────────────────────────────────────

/// 口令清洗：去首尾空白 + 不可见控制字符（与上游 RemoveInvisible+Trim 近似）。
fn clean_passphrase(raw: &str) -> String {
    raw.trim().chars().filter(|c| !c.is_control()).collect()
}

/// 由数据仓库口令派生 32 字节 AES 密钥。
pub fn derive_repo_key(passphrase: &str) -> Result<[u8; 32], String> {
    let clean = clean_passphrase(passphrase);
    if clean.is_empty() {
        return Err("请填写数据仓库密钥".to_string());
    }
    // 32 字节 base64 口令直接当密钥（上游 #6782 行为）。
    if let Ok(raw) = base64::engine::general_purpose::STANDARD
        .decode(clean.as_bytes())
        .as_deref()
        .map(<[u8]>::to_vec)
        .map_err(|_| ())
        .and_then(|v| if v.len() == 32 { Ok(v) } else { Err(()) })
    {
        let mut key = [0u8; 32];
        key.copy_from_slice(&raw);
        return Ok(key);
    }
    // 盐 = hex(sha256(口令)) 的前 16 个 ASCII 字符（注意是 hex 文本，不是原始 hash）。
    let hex_digest = hex::encode(sha2::Sha256::digest(clean.as_bytes()));
    let salt = &hex_digest.as_bytes()[..16];
    // scrypt 0.11 的 Params 含输出长度位（与 dkLen=32 一致）。
    let params = scrypt::Params::new(15, 8, 1, 32).map_err(|e| format!("scrypt 参数非法: {e}"))?;
    let mut key = [0u8; 32];
    scrypt::scrypt(clean.as_bytes(), salt, &params, &mut key)
        .map_err(|e| format!("密钥派生失败: {e}"))?;
    Ok(key)
}

/// AES-256-GCM 解包：`rand12 || ct+tag`。
pub fn aes_gcm_open(key: &[u8; 32], obj: &[u8]) -> Result<Vec<u8>, String> {
    if obj.len() < 28 {
        return Err("加密对象过短（<28B），损坏或非 dejavu 对象".to_string());
    }
    use aes_gcm::aead::{Aead, KeyInit};
    let cipher = aes_gcm::Aes256Gcm::new(aes_gcm::Key::<aes_gcm::Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(aes_gcm::Nonce::from_slice(&obj[..12]), &obj[12..])
        .map_err(|_| "AES-GCM 解密失败：数据仓库密钥错误或对象损坏".to_string())
}

pub fn zstd_decompress(data: &[u8]) -> Result<Vec<u8>, String> {
    zstd::decode_all(data).map_err(|e| format!("zstd 解压失败（对象损坏？）: {e}"))
}

#[derive(Debug, serde::Deserialize)]
pub struct DejavuIndex {
    #[serde(default)]
    files: Vec<String>,
    #[serde(default, rename = "aesKeyVerifyVal")]
    aes_key_verify_val: String,
}

#[derive(Debug, serde::Deserialize, Clone)]
pub struct DejavuFile {
    #[serde(default)]
    id: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    size: i64,
    #[serde(default)]
    updated: i64,
    #[serde(default)]
    chunks: Vec<String>,
}

/// Index 对象：只压缩不加密。
pub fn decode_index_object(obj: &[u8]) -> Result<DejavuIndex, String> {
    let plain = zstd_decompress(obj)?;
    serde_json::from_slice(&plain).map_err(|e| format!("索引 JSON 解析失败: {e}"))
}

/// 密钥校验：解密 `aesKeyVerifyVal` 须得 "siyuan"；空值视为旧版直接通过。
pub fn verify_repo_key(index: &DejavuIndex, key: &[u8; 32]) -> Result<(), String> {
    let v = index.aes_key_verify_val.trim();
    if v.is_empty() {
        return Ok(());
    }
    let raw = base64::engine::general_purpose::STANDARD
        .decode(v)
        .map_err(|_| "索引校验值非法（仓库损坏？）".to_string())?;
    let plain = aes_gcm_open(key, &raw).map_err(|_| "数据仓库密钥错误".to_string())?;
    if plain != b"siyuan" {
        return Err("数据仓库密钥校验失败".to_string());
    }
    Ok(())
}

/// File 对象：AES 解密 → zstd 解压 → JSON。
pub fn decode_file_object(obj: &[u8], key: &[u8; 32]) -> Result<DejavuFile, String> {
    let compressed = aes_gcm_open(key, obj)?;
    let plain = zstd_decompress(&compressed)?;
    serde_json::from_slice(&plain).map_err(|e| format!("文件 JSON 解析失败: {e}"))
}

fn is_hex_id(s: &str) -> bool {
    s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// 云端键拼接（prefix 为 repo 所在目录，留空即桶根）。
pub fn repo_object_key(prefix: &str, rel: &str) -> String {
    let p = prefix.trim().trim_matches('/');
    if p.is_empty() {
        format!("repo/{rel}")
    } else {
        format!("{p}/repo/{rel}")
    }
}

pub fn chunk_object_key(chunk_id: &str) -> Result<String, String> {
    if !is_hex_id(chunk_id) {
        return Err(format!("chunk id 非法: {chunk_id}"));
    }
    Ok(format!("objects/{}/{}", &chunk_id[..2], &chunk_id[2..]))
}

pub fn parse_latest_ref(raw: &[u8]) -> Result<String, String> {
    let id = String::from_utf8(raw.to_vec()).map_err(|_| "refs/latest 非文本".to_string())?;
    let id = id.trim().to_string();
    if !is_hex_id(&id) {
        return Err("refs/latest 非法（非 40hex）：仓库未初始化或损坏".to_string());
    }
    Ok(id)
}

// ── S3 传输层 ────────────────────────────────────────────────────────────────

/// 在同步上下文中驱动异步 S3：已有运行时用 block_in_place，无运行时起临时的。
fn block_on_s3<F>(fut: F) -> F::Output
where
    F: Future,
{
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => tokio::task::block_in_place(|| handle.block_on(fut)),
        Err(_) => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("s3 临时运行时")
            .block_on(fut),
    }
}

struct SiyuanS3Store {
    client: S3Client,
    prefix: String,
}

impl SiyuanS3Store {
    fn new(cfg: &SiyuanS3Config) -> Result<Self, String> {
        if cfg.bucket.trim().is_empty() {
            return Err("请填写 Bucket".to_string());
        }
        if cfg.access_key.trim().is_empty() {
            return Err("请填写 AccessKey".to_string());
        }
        if cfg.secret_key.trim().is_empty() {
            return Err("请填写 SecretKey".to_string());
        }
        // S3Config.prefix 保持空（客户端内部语义），本模块自行拼 prefix。
        let s3cfg = S3Config {
            bucket: cfg.bucket.trim().to_string(),
            provider: cfg.provider.trim().to_string(),
            region: cfg.region.trim().to_string(),
            endpoint: cfg.endpoint.trim().to_string(),
            access_key: cfg.access_key.trim().to_string(),
            prefix: String::new(),
        };
        let client = S3Client::new(s3cfg, cfg.secret_key.clone()).map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            prefix: cfg.prefix.clone(),
        })
    }

    fn key(&self, rel: &str) -> String {
        repo_object_key(&self.prefix, rel)
    }

    async fn get(&self, rel: &str) -> Result<Vec<u8>, String> {
        let key = self.key(rel);
        self.client
            .get_object(&key)
            .await
            .map_err(|e| format!("S3 下载失败 {key}: {e}"))
    }
}

// ── 适配器（SourceAdapter 同步签名；网络由 block_on_s3 桥接） ────────────────

struct S3CachedDoc {
    doc_ref: KsDocRef,
    content: KsDocContent,
}

struct S3Cache {
    done: bool,
    notebooks: Vec<(String, String, Option<String>)>,
    docs: HashMap<String, S3CachedDoc>,
    /// 全量 File 元数据（rel → meta；资源文件按需二次下载）。
    files: HashMap<String, DejavuFile>,
}

impl Default for S3Cache {
    fn default() -> Self {
        Self {
            done: false,
            notebooks: Vec::new(),
            docs: HashMap::new(),
            files: HashMap::new(),
        }
    }
}

/// 思源 S3 适配器：拉取 + 解密 + 组装 `.sy` 明文后，走插件 `parseMethod`
///（与本地源同一 JS 契约 `{ relPath, content }`），之后流程与本地源一致。
pub struct SiyuanS3Adapter<C> {
    plugin_id: String,
    namespace: String,
    id_prefix: String,
    source_prefix: String,
    tag: String,
    parse_method: String,
    cfg: SiyuanS3Config,
    caller: C,
    cache: Mutex<S3Cache>,
    skipped: Mutex<usize>,
}

impl<C> SiyuanS3Adapter<C> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        plugin_id: impl Into<String>,
        namespace: impl Into<String>,
        id_prefix: impl Into<String>,
        source_prefix: impl Into<String>,
        tag: impl Into<String>,
        parse_method: impl Into<String>,
        cfg: SiyuanS3Config,
        caller: C,
    ) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            namespace: namespace.into(),
            id_prefix: id_prefix.into(),
            source_prefix: source_prefix.into(),
            tag: tag.into(),
            parse_method: parse_method.into(),
            cfg,
            caller,
            cache: Mutex::new(S3Cache::default()),
            skipped: Mutex::new(0),
        }
    }

    /// 解密跳过计数（超大/损坏对象；ks_test 展示用）。
    pub fn skipped_large(&self) -> usize {
        *self.skipped.lock().unwrap()
    }

    fn top_dir(rel: &str) -> String {
        rel.split('/').next().unwrap_or("").to_string()
    }
}

impl<C: MethodCaller> SiyuanS3Adapter<C> {
    /// 组装单个文件字节（File 对象已解密出 meta，按 chunks 顺序拼 chunk 明文）。
    async fn assemble_file(
        store: &SiyuanS3Store,
        key: &[u8; 32],
        meta: &DejavuFile,
    ) -> Result<Vec<u8>, String> {
        let mut bytes = Vec::with_capacity(meta.size.max(0) as usize);
        for chunk_id in &meta.chunks {
            let chunk_obj = store.get(&chunk_object_key(chunk_id)?).await?;
            let plain = aes_gcm_open(key, &chunk_obj)?;
            bytes.extend_from_slice(&plain);
            if bytes.len() as u64 > MAX_ASSET_BYTES + MAX_PARSE_BYTES {
                return Err(format!("文件过大，跳过: {}", meta.path));
            }
        }
        Ok(bytes)
    }

    /// 并发拉取全部 File 元数据（小 JSON；单文件失败只计数不整体失败）。
    async fn fetch_all_metas(
        store: std::sync::Arc<SiyuanS3Store>,
        key: [u8; 32],
        file_ids: Vec<String>,
    ) -> (Vec<DejavuFile>, usize) {
        let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
        let mut set = tokio::task::JoinSet::new();
        for file_id in file_ids {
            if !is_hex_id(&file_id) {
                continue;
            }
            let store = store.clone();
            let sem = sem.clone();
            set.spawn(async move {
                let _permit = sem
                    .acquire_owned()
                    .await
                    .map_err(|_| "信号量关闭".to_string())?;
                let obj = store
                    .get(&format!("objects/{}/{}", &file_id[..2], &file_id[2..]))
                    .await?;
                decode_file_object(&obj, &key)
            });
        }
        let mut out = Vec::new();
        let mut skipped = 0usize;
        while let Some(res) = set.join_next().await {
            match res {
                Ok(Ok(meta)) => out.push(meta),
                _ => skipped += 1,
            }
        }
        (out, skipped)
    }

    fn ensure_cache(&self) -> Result<(), String> {
        {
            let cache = self.cache.lock().unwrap();
            if cache.done {
                return Ok(());
            }
        }
        let key = derive_repo_key(&self.cfg.repo_password)?;
        let store = std::sync::Arc::new(SiyuanS3Store::new(&self.cfg)?);
        let (metas, mut skipped) = block_on_s3(async {
            let latest_raw = store.get("refs/latest").await?;
            let index_id = parse_latest_ref(&latest_raw)?;
            let index_raw = store.get(&format!("indexes/{index_id}")).await?;
            let index = decode_index_object(&index_raw)?;
            verify_repo_key(&index, &key)?;
            Ok::<_, String>(Self::fetch_all_metas(store.clone(), key, index.files).await)
        })?;
        // 全量 File 元数据留存（资源文件按需二次下载）；只组装 .sy/conf 进解析。
        let mut file_metas: HashMap<String, DejavuFile> = HashMap::new();
        for meta in &metas {
            let rel = meta.path.trim_start_matches('/').replace('\\', "/");
            if !rel.is_empty() {
                file_metas.entry(rel).or_insert_with(|| meta.clone());
            }
        }
        // 组装 .sy/conf 明文（并发；失败只计数）。
        let targets: Vec<DejavuFile> = metas
            .into_iter()
            .filter(|m| {
                let rel = m.path.trim_start_matches('/').replace('\\', "/");
                rel.ends_with(".sy") || rel.ends_with(".siyuan/conf.json")
            })
            .collect();
        let (files, skipped_assemble): (Vec<(DejavuFile, Vec<u8>)>, usize) =
            block_on_s3(async move {
                let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
                let mut set = tokio::task::JoinSet::new();
                for meta in targets {
                    let store = store.clone();
                    let sem = sem.clone();
                    set.spawn(async move {
                        let _permit = sem
                            .acquire_owned()
                            .await
                            .map_err(|_| "信号量关闭".to_string())?;
                        let bytes = Self::assemble_file(&store, &key, &meta).await?;
                        Ok::<_, String>((meta, bytes))
                    });
                }
                let mut out = Vec::new();
                let mut skipped = 0usize;
                while let Some(res) = set.join_next().await {
                    match res {
                        Ok(Ok(item)) => out.push(item),
                        _ => skipped += 1,
                    }
                }
                Ok::<_, String>((out, skipped))
            })?;
        skipped += skipped_assemble;
        // 顶层目录自动补文件夹在解析循环后统一做（与本地源一致）。
        let mut notebooks: Vec<(String, String, Option<String>)> = Vec::new();
        let mut seen_notebooks: HashSet<String> = HashSet::new();
        let mut docs: HashMap<String, S3CachedDoc> = HashMap::new();
        for (meta, bytes) in files {
            // dejavu 路径以 `/` 开头，去掉后与本地盘布局一致（engine 做嵌套推导）。
            let rel = meta.path.trim_start_matches('/').replace('\\', "/");
            if rel.is_empty() {
                skipped += 1;
                continue;
            }
            let is_sy = rel.ends_with(".sy");
            let is_conf = rel.ends_with(".siyuan/conf.json");
            if !is_sy && !is_conf {
                continue;
            }
            if bytes.len() as u64 > MAX_PARSE_BYTES {
                skipped += 1;
                continue;
            }
            let content = match String::from_utf8(bytes) {
                Ok(text) => text,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            let value = self.caller.call(
                &self.plugin_id,
                &self.parse_method,
                serde_json::json!({ "relPath": rel, "content": content }),
            )?;
            let kind = value
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            match kind {
                "notebook" => {
                    let id = value
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if id.is_empty() || !seen_notebooks.insert(id.clone()) {
                        continue;
                    }
                    let name = value
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    notebooks.push((
                        id,
                        if name.is_empty() {
                            Self::top_dir(&rel)
                        } else {
                            name
                        },
                        None,
                    ));
                }
                "doc" => {
                    let id = value
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if id.is_empty() || docs.contains_key(&id) {
                        continue;
                    }
                    let title = value
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let markdown = value
                        .get("markdown")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let box_id = Self::top_dir(&rel);
                    let tags = super::adapter::parse_doc_tags(&value);
                    docs.insert(
                        id.clone(),
                        S3CachedDoc {
                            doc_ref: KsDocRef {
                                id: id.clone(),
                                title: title.clone(),
                                parent_id: None,
                                box_id: box_id.clone(),
                                rel_path: rel.clone(),
                                fingerprint: meta.updated.to_string(),
                                tags,
                            },
                            content: KsDocContent {
                                title,
                                markdown,
                                updated_at_ms: Some(meta.updated),
                            },
                        },
                    );
                }
                _ => {} // "skip" 与未知均忽略
            }
        }
        // 顶层目录自动补文件夹（显式命名优先）。
        let mut auto: HashSet<String> = HashSet::new();
        for doc in docs.values() {
            if !doc.doc_ref.box_id.is_empty() {
                auto.insert(doc.doc_ref.box_id.clone());
            }
        }
        for box_id in auto {
            if seen_notebooks.contains(&box_id) {
                continue;
            }
            seen_notebooks.insert(box_id.clone());
            notebooks.push((box_id.clone(), box_id, None));
        }
        if notebooks.is_empty() && docs.is_empty() {
            return Err("仓库索引为空或无可解析文档（口令错会先报解密失败）".to_string());
        }
        let mut cache = self.cache.lock().unwrap();
        cache.notebooks = notebooks;
        cache.docs = docs;
        cache.files = file_metas;
        cache.done = true;
        *self.skipped.lock().unwrap() = skipped;
        Ok(())
    }
}

impl<C: MethodCaller> SourceAdapter for SiyuanS3Adapter<C> {
    fn namespace(&self) -> &str {
        &self.namespace
    }

    fn adapter_kind(&self) -> &'static str {
        "siyuan-s3"
    }

    fn folder_entry_id(&self, box_id: &str) -> String {
        format!("{}-box-{box_id}", self.id_prefix)
    }

    fn doc_entry_id(&self, doc_id: &str) -> String {
        format!("{}-doc-{doc_id}", self.id_prefix)
    }

    fn archive_folder_id(&self, box_id: &str) -> String {
        format!("{}-archive-{box_id}", self.id_prefix)
    }

    fn folder_source(&self, box_id: &str) -> String {
        format!("{}:box:{box_id}", self.source_prefix)
    }

    fn doc_source(&self, box_id: &str, doc_id: &str) -> String {
        format!("{}:doc:{box_id}/{doc_id}", self.source_prefix)
    }

    fn archive_source(&self, box_id: &str) -> String {
        format!("{}:archive:{box_id}", self.source_prefix)
    }

    fn tag(&self) -> String {
        self.tag.clone()
    }

    fn archive_tag(&self) -> String {
        format!("{}:archived", self.tag)
    }

    fn file_key(&self, doc: &KsDocRef) -> String {
        format!("s3:{}:{}", doc.box_id, doc.rel_path)
    }

    fn asset_managed(&self) -> bool {
        true
    }

    fn fetch_asset(&self, doc: &KsDocRef, rel: &str) -> Result<Option<(String, Vec<u8>)>, String> {
        // 禁锢：只允许 assets/ 下文件。
        let clean = rel.replace('\\', "/");
        let clean = clean.trim().trim_start_matches('/');
        if clean.is_empty() || clean.contains("..") || !clean.starts_with("assets/") {
            return Ok(None);
        }
        self.ensure_cache()?;
        let key = derive_repo_key(&self.cfg.repo_password)?;
        let store = SiyuanS3Store::new(&self.cfg)?;
        // 盒内优先，找不到回落仓库根共享 assets/（与本地源一致）。
        let candidates = [format!("{}/{}", doc.box_id, clean), clean.to_string()];
        for full_rel in &candidates {
            let meta = {
                let cache = self.cache.lock().unwrap();
                match cache.files.get(full_rel).cloned() {
                    Some(meta) => meta,
                    None => continue,
                }
            };
            let bytes = block_on_s3(Self::assemble_file(&store, &key, &meta))?;
            if bytes.len() as u64 > MAX_ASSET_BYTES {
                return Ok(None);
            }
            return Ok(Some((clean.replace('/', "__"), bytes)));
        }
        tracing::warn!("思源 S3 镜像资源缺失（同步跳过）: {}/{}", doc.box_id, clean);
        Ok(None)
    }

    fn list_notebooks(&self) -> Result<Vec<KsNotebook>, String> {
        self.ensure_cache()?;
        let cache = self.cache.lock().unwrap();
        Ok(cache
            .notebooks
            .iter()
            .map(|(id, name, parent)| KsNotebook {
                id: id.clone(),
                name: name.clone(),
                parent_id: parent.clone(),
            })
            .collect())
    }

    fn list_documents(&self) -> Result<Vec<KsDocRef>, String> {
        self.ensure_cache()?;
        let cache = self.cache.lock().unwrap();
        Ok(cache.docs.values().map(|d| d.doc_ref.clone()).collect())
    }

    fn get_document(&self, doc: &KsDocRef) -> Result<KsDocContent, String> {
        self.ensure_cache()?;
        let cache = self.cache.lock().unwrap();
        cache
            .docs
            .get(&doc.id)
            .map(|d| d.content.clone())
            .ok_or_else(|| format!("文档不在缓存: {}", doc.id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::{Aead, KeyInit};

    fn test_key() -> [u8; 32] {
        *b"0123456789abcdef0123456789abcdef"
    }

    /// 与上游同顺序组装测试包：明文 → zstd → AES-GCM（nonce 前置）。
    fn encrypt_object(plain: &[u8], key: &[u8; 32]) -> Vec<u8> {
        let compressed = zstd::encode_all(&plain[..], 0).expect("zstd 压缩");
        let cipher = aes_gcm::Aes256Gcm::new(aes_gcm::Key::<aes_gcm::Aes256Gcm>::from_slice(key));
        let nonce = [7u8; 12]; // 固定 nonce 仅测试用
        let mut out = nonce.to_vec();
        out.extend_from_slice(
            &cipher
                .encrypt(aes_gcm::Nonce::from_slice(&nonce), &compressed[..])
                .expect("加密"),
        );
        out
    }

    #[test]
    fn key_derivation_stable_and_rejects_empty() {
        let a = derive_repo_key("siyuan-test-pass").unwrap();
        let b = derive_repo_key("  siyuan-test-pass  ").unwrap();
        assert_eq!(a, b);
        assert!(derive_repo_key("   ").is_err());
        // 32 字节 base64 直通密钥
        let raw = vec![9u8; 32];
        let b64 = base64::engine::general_purpose::STANDARD.encode(&raw);
        assert_eq!(&derive_repo_key(&b64).unwrap()[..], &raw[..]);
    }

    #[test]
    fn file_object_roundtrip() {
        let key = test_key();
        let file_json = r#"{"id":"abc","path":"/box1/doc.sy","size":5,"updated":1712345678901,"chunks":["c1"]}"#;
        let obj = encrypt_object(file_json.as_bytes(), &key);
        let file = decode_file_object(&obj, &key).unwrap();
        assert_eq!(file.id, "abc");
        assert_eq!(file.path, "/box1/doc.sy");
        assert_eq!(file.updated, 1712345678901);
        assert_eq!(file.chunks, vec!["c1".to_string()]);
    }

    #[test]
    fn index_object_and_key_verify() {
        let key = test_key();
        let cipher = aes_gcm::Aes256Gcm::new(aes_gcm::Key::<aes_gcm::Aes256Gcm>::from_slice(&key));
        let nonce = [3u8; 12];
        let mut enveloped = nonce.to_vec();
        enveloped.extend_from_slice(
            &cipher
                .encrypt(aes_gcm::Nonce::from_slice(&nonce), b"siyuan".as_slice())
                .expect("加密"),
        );
        let val = base64::engine::general_purpose::STANDARD.encode(&enveloped);
        let index_json = format!(
            r#"{{"id":"{}","files":[],"aesKeyVerifyVal":"{}"}}"#,
            "a".repeat(40),
            val
        );
        let obj = zstd::encode_all(&index_json.as_bytes()[..], 0).expect("zstd 压缩");
        let index = decode_index_object(&obj).unwrap();
        assert!(index.files.is_empty());
        verify_repo_key(&index, &key).unwrap();
        // 错口令必须失败
        let wrong = derive_repo_key("wrong-pass").unwrap();
        assert!(verify_repo_key(&index, &wrong).is_err());
        // 无校验值的旧版直接通过
        let legacy_raw = zstd::encode_all(&b"{\"id\":\"x\",\"files\":[]}"[..], 0).expect("zstd");
        let legacy = decode_index_object(&legacy_raw).unwrap();
        verify_repo_key(&legacy, &wrong).unwrap();
    }

    #[test]
    fn rejects_short_object_and_wrong_password() {
        let key = test_key();
        assert!(aes_gcm_open(&key, &[0u8; 10]).is_err());
        let obj = encrypt_object(b"hello", &key);
        let wrong = derive_repo_key("another-pass").unwrap();
        assert!(aes_gcm_open(&wrong, &obj).is_err());
        // GCM 过了但 zstd 层坏：错误应来自解压层
        let mut tampered = obj.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xff;
        assert!(decode_file_object(&tampered, &key).is_err());
    }

    #[test]
    fn key_templates_and_latest_ref() {
        assert_eq!(repo_object_key("", "refs/latest"), "repo/refs/latest");
        assert_eq!(
            repo_object_key("/bk/", "refs/latest"),
            "bk/repo/refs/latest"
        );
        let cid = "ab".repeat(20);
        assert_eq!(
            chunk_object_key(&cid).unwrap(),
            format!("objects/ab/{}", "ab".repeat(19))
        );
        assert!(chunk_object_key("zz").is_err());
        let forty = "1e".repeat(20);
        let raw = format!("  {forty}\n");
        assert_eq!(parse_latest_ref(raw.as_bytes()).unwrap(), forty);
        assert!(parse_latest_ref(b"short").is_err());
    }
}
