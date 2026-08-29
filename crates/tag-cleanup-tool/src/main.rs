//! 独立设备标签清理工具（无需运行 OmniPanel 应用）。
//!
//! 背景：旧版同步在上传时会给所有资源补当前设备名标签；应用启动会自动拉取云端快照，
//! 若云端仍是旧标签，手动删除的设备名标签会被还原。本工具在应用关闭时运行：
//!
//! 1. 迁移本地数据（全部团队 scope 的 SQLite 库 + 各自的数据库连接 JSON）中的
//!    设备名标签为 `creator:` 标签；
//! 2. 遍历账号下全部团队（个人 + 组织），拉取各自的云端模块快照，仅清洗其中各资源的
//!    tags 字段（布局 / 墓碑 / 凭据等原样保留，不会被本机数据覆盖），端到端加密后推回。
//!    此后应用启动拉取到的即是干净标签，不再出现「删了又回来」。
//!
//! 另支持删除指定标签（`--remove-tag`，精确匹配、可传多个）与查看标签清单（`--list-tags`）。
//!
//! 用法（请先关闭 OmniPanel，避免 SQLite 锁库）：
//! ```text
//! # 默认：设备名标签迁移 + 云端清洗（邮箱验证码登录，推荐）
//! cargo run -p tag-cleanup-tool --release -- --email <你的邮箱>
//!
//! # 删除指定标签（可重复传参，也可逗号分隔多个）
//! cargo run -p tag-cleanup-tool --release -- --email <邮箱> --remove-tag "废弃标签" --remove-tag "foo,bar"
//!
//! # 纯删除模式：不做设备名迁移，只删指定标签
//! cargo run -p tag-cleanup-tool --release -- --email <邮箱> --no-migrate --remove-tag "foo"
//!
//! # 查看标签清单（本地 + 云端；无登录凭证时仅本地）
//! cargo run -p tag-cleanup-tool --release -- --list-tags
//!
//! # 直接传 token（来源：前端 localStorage 键 omnipanel-auth.v1，或环境变量 OMNIPANEL_TOKEN）
//! cargo run -p tag-cleanup-tool --release -- --token <TOKEN> [--dry-run]
//! ```

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use omnipanel_assistant::{
    AuthContext, TEAM_MODULES_LATEST_LEAF, pull_team_sync_json, push_team_sync_json,
    validate_modules_bundle_json,
};
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_store::{
    Connection, DbConnectionConfig, HttpCollection, HttpEnvironment, KnowledgeEntry,
    SavedHttpRequest, SshKeyRecord, Storage, SYNC_KIND_MODULES, decode_sync_blob_with_sources,
    encrypt_sync_team_blob, get_or_create_sync_team_key, load_database_connections_from,
    load_sync_team_key, migrate_device_tags_to_creator, omnipd_root,
    save_database_connections_to,
};
use serde::{Deserialize, Serialize};

const AUTH_API_BASE: &str = "https://mp.99.protected.fun";
const CLIENT_APP_ID: &str = "omni-client";
const CLIENT_APP_ROLE: &str = "client";

// ---------- 与桌面端 ClientSyncModulesBundle 同构（serde 字段一致即可互相读写） ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tombstone {
    id: String,
    deleted_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionItem {
    connection: Connection,
    #[serde(default)]
    secret: Option<String>,
}

/// 兼容旧快照：数组元素曾是裸 `DbConnectionConfig`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseItem {
    connection: DbConnectionConfig,
    #[serde(default)]
    secret: Option<String>,
}

impl<'de> Deserialize<'de> for DatabaseItem {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        if value.get("connection").is_some() {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Wrapped {
                connection: DbConnectionConfig,
                #[serde(default)]
                secret: Option<String>,
            }
            let wrapped: Wrapped =
                serde_json::from_value(value).map_err(serde::de::Error::custom)?;
            Ok(Self {
                connection: wrapped.connection,
                secret: wrapped.secret.filter(|s| !s.is_empty()),
            })
        } else {
            let connection: DbConnectionConfig =
                serde_json::from_value(value).map_err(serde::de::Error::custom)?;
            Ok(Self {
                connection,
                secret: None,
            })
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInfo {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    window_form: Option<String>,
    #[serde(default)]
    updated_at: f64,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultSecret {
    reference: String,
    value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModulesBundle {
    schema_version: u32,
    kind: String,
    updated_at: f64,
    #[serde(default)]
    connections: Vec<ConnectionItem>,
    #[serde(default)]
    deleted_connections: Vec<Tombstone>,
    #[serde(default)]
    database_connections: Vec<DatabaseItem>,
    #[serde(default)]
    deleted_databases: Vec<Tombstone>,
    #[serde(default)]
    knowledge: Vec<KnowledgeEntry>,
    #[serde(default)]
    deleted_knowledge: Vec<Tombstone>,
    #[serde(default)]
    http_collections: Vec<HttpCollection>,
    #[serde(default)]
    http_environments: Vec<HttpEnvironment>,
    #[serde(default)]
    http_requests: Vec<SavedHttpRequest>,
    #[serde(default)]
    deleted_http_requests: Vec<Tombstone>,
    #[serde(default)]
    deleted_http_collections: Vec<Tombstone>,
    #[serde(default)]
    deleted_http_environments: Vec<Tombstone>,
    #[serde(default)]
    workspaces: Vec<WorkspaceInfo>,
    #[serde(default)]
    deleted_workspaces: Vec<Tombstone>,
    #[serde(default)]
    ssh_sidebar_tree_json: Option<String>,
    #[serde(default)]
    folder_trees_json: Option<String>,
    #[serde(default)]
    custom_panels_json: Option<String>,
    #[serde(default)]
    deleted_custom_panels: Vec<Tombstone>,
    #[serde(default)]
    vault_secrets: Vec<VaultSecret>,
    #[serde(default)]
    ssh_keys: Vec<SshKeyRecord>,
}

// ---------- 账号服务 API（复刻桌面端 auth.rs 的请求/解析逻辑） ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIdentityFile {
    device_id: String,
    device_name: String,
    #[serde(default)]
    os_type: String,
}

#[derive(Debug, Deserialize)]
struct ApiMeTeamItem {
    id: Option<i64>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default, alias = "teamOssKey")]
    team_oss_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiUserResponse {
    #[serde(default)]
    openid: Option<String>,
    #[serde(default)]
    teams: Option<Vec<ApiMeTeamItem>>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct TeamMembership {
    id: i64,
    name: String,
    kind: String,
    team_oss_key: String,
}

#[derive(Debug, Clone)]
struct AccountProfile {
    openid: String,
    teams: Vec<TeamMembership>,
}

#[derive(Debug, Deserialize)]
struct ApiEmailSendResponse {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    expire_in_sec: Option<u32>,
    #[serde(default)]
    hint: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiTokenLoginResponse {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiDeviceListResponse {
    #[serde(default)]
    items: Option<Vec<ApiDeviceView>>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiDeviceView {
    #[serde(default)]
    device_name: Option<String>,
}

// ---------- CLI ----------

#[derive(Debug, Default)]
struct Args {
    token: Option<String>,
    email: Option<String>,
    team_id: Option<i64>,
    db: Option<PathBuf>,
    /// 要删除的标签（精确匹配、区分大小写，忽略首尾空白）
    remove_tags: Vec<String>,
    /// 跳过设备名标签 → creator 迁移（纯删除模式）
    no_migrate: bool,
    /// 只列出本地/云端标签清单后退出，不做任何修改
    list_tags: bool,
    dry_run: bool,
    help: bool,
}

fn parse_args() -> Result<Args, String> {
    parse_args_from(std::env::args().skip(1))
}

fn parse_args_from<I: IntoIterator<Item = String>>(argv: I) -> Result<Args, String> {
    let mut args = Args::default();
    let mut it = argv.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--help" | "-h" => args.help = true,
            "--dry-run" => args.dry_run = true,
            "--no-migrate" => args.no_migrate = true,
            "--list-tags" => args.list_tags = true,
            "--token" => {
                args.token = Some(it.next().ok_or("--token 缺少参数值")?);
            }
            "--email" => {
                args.email = Some(it.next().ok_or("--email 缺少参数值")?);
            }
            "--remove-tag" => {
                let raw = it.next().ok_or("--remove-tag 缺少参数值")?;
                for part in raw.split(',') {
                    let tag = part.trim();
                    if !tag.is_empty() && !args.remove_tags.iter().any(|t| t == tag) {
                        args.remove_tags.push(tag.to_string());
                    }
                }
            }
            "--team-id" => {
                let raw = it.next().ok_or("--team-id 缺少参数值")?;
                args.team_id = Some(
                    raw.parse::<i64>()
                        .map_err(|_| format!("无效 team-id: {raw}"))?,
                );
            }
            "--db" => {
                args.db = Some(PathBuf::from(it.next().ok_or("--db 缺少参数值")?));
            }
            other => return Err(format!("未知参数: {other}")),
        }
    }
    Ok(args)
}

fn print_usage() {
    println!(
        "OmniPanel 标签清理工具（独立运行，请先关闭 OmniPanel 应用）\n\
         \n\
         用法:\n\
           # 默认：设备名标签迁移（移除设备名标签 + 补 creator 标签），本地 + 云端\n\
           tag-cleanup-tool --email <EMAIL> [选项]\n\
           tag-cleanup-tool --token <TOKEN> [选项]\n\
         \n\
           # 删除指定标签（精确匹配，可重复传参或逗号分隔多个）\n\
           tag-cleanup-tool --email <EMAIL> --remove-tag \"废弃标签\" --remove-tag \"foo,bar\"\n\
         \n\
           # 纯删除模式：不做设备名迁移，只删指定标签\n\
           tag-cleanup-tool --email <EMAIL> --no-migrate --remove-tag \"foo\"\n\
         \n\
           # 查看标签清单（本地 + 云端；无登录凭证时仅本地）\n\
           tag-cleanup-tool --list-tags [--db <PATH>]\n\
         \n\
         参数:\n\
           --email <EMAIL>      邮箱验证码登录（推荐，无需手动找 token）\n\
           --token <TOKEN>      直接使用登录 token（也可用环境变量 OMNIPANEL_TOKEN）\n\
           --remove-tag <TAGS>  要删除的标签，精确匹配、区分大小写；可重复传参，逗号分隔多个\n\
           --no-migrate         跳过设备名标签→creator 迁移（配合 --remove-tag 做纯删除）\n\
           --list-tags          列出本地/云端标签清单后退出，不做任何修改\n\
           --team-id <ID>       只处理指定团队（缺省处理账号下全部团队：个人 + 组织）\n\
           --db <PATH>          只处理指定 SQLite 库（缺省处理 ~/.omnipd/store/teams/*/ 全部 scope）\n\
           --dry-run            只分析待清理项，不写本地、不推送云端\n\
         \n\
         token 获取（使用 --token 方式时）:\n\
           1. debug 构建启动 OmniPanel（OMNIPANEL_OPEN_DEVTOOLS=1 cargo tauri dev）\n\
           2. DevTools Console 执行: copy(JSON.parse(localStorage.getItem('omnipanel-auth.v1')).state.token)\n\
         \n\
         迁移规则: 移除资源上与账号设备名相同的标签，并补 `creator: <设备名>` 标记创建设备；\n\
         已有 creator 标签的资源只移除设备名标签。指定标签删除在迁移之后执行（显式删除优先，\n\
         例如删除 creator 标签不会被迁移逻辑补回）。幂等，可重复执行。"
    );
}

/// 环境变量 OMNIPANEL_TOKEN 中的登录 token（空值视为未设置）。
fn env_token() -> Option<String> {
    let token = std::env::var("OMNIPANEL_TOKEN").ok()?;
    let token = token.trim().to_string();
    (!token.is_empty()).then_some(token)
}

/// 邮箱验证码登录：发送验证码 →（服务端回显则直接使用，否则等用户输入）→ 换取 token。
async fn login_email(
    http: &reqwest::Client,
    identity: &DeviceIdentityFile,
    email: &str,
) -> OmniResult<String> {
    let email = email.trim();
    if email.is_empty() || !email.contains('@') {
        return Err(OmniError::new(ErrorCode::InvalidInput, "请输入有效邮箱"));
    }

    let send_url = format!("{AUTH_API_BASE}/api/login/email/send");
    let resp = http
        .post(&send_url)
        .json(&serde_json::json!({ "email": email }))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "发送验证码失败").with_cause(e.to_string())
        })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取验证码响应失败").with_cause(e.to_string())
    })?;
    let parsed: ApiEmailSendResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析验证码响应失败")
            .with_cause(format!("{e}; body={body}"))
    })?;
    if let Some(error) = parsed.error.as_ref().filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Auth, error.clone()));
    }
    if !status.is_success() {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("发送验证码失败 (HTTP {status})"),
        )
        .with_cause(body));
    }

    let expire = parsed.expire_in_sec.unwrap_or(300).max(1);
    let code = match parsed.code.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(code) => {
            println!("验证码已回显: {code}（有效期 {expire} 秒，直接使用）");
            code.to_string()
        }
        None => {
            if let Some(hint) = parsed.hint.as_deref().filter(|s| !s.is_empty()) {
                println!("{hint}");
            }
            println!("已向 {email} 发送验证码（有效期 {expire} 秒），请查收并输入: ");
            let mut input = String::new();
            std::io::stdin()
                .read_line(&mut input)
                .map_err(|e| OmniError::new(ErrorCode::Io, "读取验证码输入失败").with_cause(e.to_string()))?;
            let input = input.trim().to_string();
            if input.is_empty() {
                return Err(OmniError::new(ErrorCode::InvalidInput, "验证码不能为空"));
            }
            input
        }
    };

    let login_url = format!("{AUTH_API_BASE}/api/login/email");
    let resp = http
        .post(&login_url)
        .header("X-App-Id", CLIENT_APP_ID)
        .header("X-App-Role", CLIENT_APP_ROLE)
        .header("X-Device-Id", &identity.device_id)
        .header("X-Device-Name", header_device_name(&identity.device_name))
        .header("X-Device-OS", header_ascii(&identity.os_type, "unknown"))
        .json(&serde_json::json!({ "email": email, "code": code }))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "邮箱登录失败").with_cause(e.to_string())
        })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取登录响应失败").with_cause(e.to_string())
    })?;
    let parsed: ApiTokenLoginResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析登录响应失败")
            .with_cause(format!("{e}; body={body}"))
    })?;
    if let Some(error) = parsed.error.as_ref().filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Auth, error.clone()));
    }
    if !status.is_success() {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("邮箱登录失败 (HTTP {status})"),
        )
        .with_cause(body));
    }
    parsed
        .token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| OmniError::new(ErrorCode::Internal, "登录响应缺少 token"))
}

// ---------- 工具函数 ----------

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// 设备名写入 HTTP Header：纯 ASCII 原样；含非 ASCII（如中文电脑名）则百分号编码。
fn header_device_name(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "OmniPanel".to_string();
    }
    if trimmed.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return trimmed.to_string();
    }
    urlencoding::encode(trimmed).into_owned()
}

fn header_ascii(raw: &str, fallback: &str) -> String {
    let trimmed = raw.trim();
    if !trimmed.is_empty() && trimmed.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return trimmed.to_string();
    }
    fallback.to_string()
}

fn load_device_identity() -> OmniResult<DeviceIdentityFile> {
    let path = omnipd_root()?.join("auth").join("device.json");
    if !path.is_file() {
        return Err(OmniError::new(
            ErrorCode::NotFound,
            format!(
                "未找到设备身份文件 {}，请先在 OmniPanel 中登录一次再运行本工具",
                path.display()
            ),
        ));
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| OmniError::new(ErrorCode::Io, "读取设备身份失败").with_cause(e.to_string()))?;
    serde_json::from_str(&raw).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析设备身份失败").with_cause(e.to_string())
    })
}

async fn fetch_me(http: &reqwest::Client, token: &str) -> OmniResult<AccountProfile> {
    let url = format!("{AUTH_API_BASE}/api/me");
    let resp = http
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "获取用户信息失败").with_cause(e.to_string())
        })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取用户信息响应失败").with_cause(e.to_string())
    })?;
    if status.as_u16() == 401 {
        return Err(OmniError::new(ErrorCode::Auth, "登录已失效，请更新 token 后重试"));
    }
    let parsed: ApiUserResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析用户信息失败")
            .with_cause(format!("{e}; body={body}"))
    })?;
    if let Some(error) = parsed.error.as_ref().filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Internal, error.clone()));
    }
    if !status.is_success() {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("获取用户信息失败 (HTTP {status})"),
        )
        .with_cause(body));
    }
    let teams = parsed
        .teams
        .unwrap_or_default()
        .into_iter()
        .map(|t| TeamMembership {
            id: t.id.unwrap_or(0),
            name: t.name.unwrap_or_default(),
            kind: t.kind.unwrap_or_default(),
            team_oss_key: t.team_oss_key.unwrap_or_default(),
        })
        .collect();
    Ok(AccountProfile {
        openid: parsed.openid.unwrap_or_default(),
        teams,
    })
}

async fn fetch_device_names(
    http: &reqwest::Client,
    token: &str,
    identity: &DeviceIdentityFile,
) -> OmniResult<Vec<String>> {
    let url = format!("{AUTH_API_BASE}/api/devices");
    let resp = http
        .get(&url)
        .bearer_auth(token)
        .header("X-App-Id", CLIENT_APP_ID)
        .header("X-App-Role", CLIENT_APP_ROLE)
        .header("X-Device-Id", &identity.device_id)
        .header("X-Device-Name", header_device_name(&identity.device_name))
        .header("X-Device-OS", header_ascii(&identity.os_type, "unknown"))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "获取设备列表失败").with_cause(e.to_string())
        })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取设备列表响应失败").with_cause(e.to_string())
    })?;
    if status.as_u16() == 401 {
        return Err(OmniError::new(ErrorCode::Auth, "登录已失效，请更新 token 后重试"));
    }
    let parsed: ApiDeviceListResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析设备列表失败")
            .with_cause(format!("{e}; body={body}"))
    })?;
    if let Some(error) = parsed.error.as_ref().filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Internal, error.clone()));
    }
    if !status.is_success() {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("获取设备列表失败 (HTTP {status})"),
        )
        .with_cause(body));
    }
    Ok(parsed
        .items
        .unwrap_or_default()
        .into_iter()
        .filter_map(|d| {
            d.device_name
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty())
        })
        .collect())
}

/// 解析同步目标团队：缺省个人团队；显式 `team_id` 必须存在于账号团队列表。
fn resolve_sync_team<'a>(
    request_team_id: Option<i64>,
    me: &'a AccountProfile,
) -> OmniResult<&'a TeamMembership> {
    let id = match request_team_id {
        Some(id) if id > 0 => id,
        _ => me
            .teams
            .iter()
            .find(|t| t.kind.eq_ignore_ascii_case("personal") && t.id > 0)
            .or_else(|| me.teams.iter().find(|t| t.id > 0))
            .map(|t| t.id)
            .ok_or_else(|| {
                OmniError::new(ErrorCode::NotFound, "当前账号没有可用团队，无法同步快照")
            })?,
    };
    me.teams
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| OmniError::new(ErrorCode::Auth, "无权访问该团队同步数据"))
}

/// v1 兼容密钥材料（解密旧快照时作为回退来源）。
fn sync_blob_key_material(me: &AccountProfile, team: &TeamMembership) -> Option<String> {
    if team.kind.eq_ignore_ascii_case("personal") {
        let openid = me.openid.trim();
        if openid.is_empty() {
            return None;
        }
        Some(format!("omnipanel.sync.v1.personal:{openid}"))
    } else {
        let oss = team.team_oss_key.trim();
        if oss.is_empty() {
            return None;
        }
        Some(format!(
            "omnipanel.sync.v1.team:{}:{}:omnipanel-client-sync-e2e-v1",
            team.id, oss
        ))
    }
}

// ---------- 标签清理 ----------

/// 单个资源的标签变更结果。
#[derive(Debug, Clone, Copy, Default)]
struct TagChange {
    /// 设备名标签 → creator 迁移发生
    migrated: bool,
    /// 指定标签删除发生
    removed: bool,
}

impl TagChange {
    fn changed(&self) -> bool {
        self.migrated || self.removed
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResKind {
    Connection,
    Database,
    Knowledge,
    HttpRequest,
    HttpCollection,
    HttpEnvironment,
    Workspace,
}

impl ResKind {
    fn label(self) -> &'static str {
        match self {
            Self::Connection => "连接",
            Self::Database => "数据库连接",
            Self::Knowledge => "知识条目",
            Self::HttpRequest => "HTTP 请求",
            Self::HttpCollection => "HTTP 集合",
            Self::HttpEnvironment => "HTTP 环境",
            Self::Workspace => "工作区",
        }
    }
}

const RES_KINDS: [ResKind; 7] = [
    ResKind::Connection,
    ResKind::Database,
    ResKind::Knowledge,
    ResKind::HttpRequest,
    ResKind::HttpCollection,
    ResKind::HttpEnvironment,
    ResKind::Workspace,
];

#[derive(Debug, Default)]
struct TypeCounts {
    counts: [usize; RES_KINDS.len()],
}

impl TypeCounts {
    fn count(&mut self, kind: ResKind) {
        self.counts[kind as usize] += 1;
    }

    fn get(&self, kind: ResKind) -> usize {
        self.counts[kind as usize]
    }

    fn total(&self) -> usize {
        self.counts.iter().sum()
    }

    fn print(&self, title: &str) {
        if self.total() == 0 {
            println!("{title}: 无需变更");
            return;
        }
        println!("{title}: {} 条资源", self.total());
        for kind in RES_KINDS {
            let count = self.get(kind);
            if count > 0 {
                println!("    {}: {count} 条", kind.label());
            }
        }
    }
}

#[derive(Debug, Default)]
struct CleanupReport {
    migrated: TypeCounts,
    removed: TypeCounts,
}

impl CleanupReport {
    fn record(&mut self, kind: ResKind, change: TagChange) {
        if change.migrated {
            self.migrated.count(kind);
        }
        if change.removed {
            self.removed.count(kind);
        }
    }

    fn changed(&self) -> bool {
        self.migrated.total() + self.removed.total() > 0
    }

    fn print(&self, scope: &str, removal_requested: bool) {
        println!("{scope}:");
        self.migrated.print("  设备标签迁移");
        if removal_requested {
            self.removed.print("  指定标签删除");
        }
    }
}

/// 一次运行的清理动作集合。
struct TagCleanup {
    /// 是否执行设备名标签 → creator 迁移
    migrate: bool,
    device_names: Vec<String>,
    current: String,
    /// 要删除的指定标签
    remove: Vec<String>,
}

impl TagCleanup {
    fn removal_requested(&self) -> bool {
        !self.remove.is_empty()
    }

    /// 先迁移后删除：显式删除优先，例如删除 creator 标签后不会被迁移逻辑补回。
    fn apply(&self, tags: &mut Vec<String>) -> TagChange {
        let mut change = TagChange::default();
        if self.migrate
            && migrate_device_tags_to_creator(tags, &self.device_names, &self.current)
        {
            change.migrated = true;
        }
        if self.removal_requested() && remove_specified_tags(tags, &self.remove) {
            change.removed = true;
        }
        change
    }
}

/// 精确匹配（区分大小写、忽略标签首尾空白）删除指定标签；返回是否发生删除。
fn remove_specified_tags(tags: &mut Vec<String>, to_remove: &[String]) -> bool {
    let before = tags.len();
    tags.retain(|t| !to_remove.iter().any(|r| r == t.trim()));
    tags.len() != before
}

// ---------- 标签清单 ----------

fn bump_tags(map: &mut BTreeMap<String, usize>, tags: &[String]) {
    let mut seen = HashSet::new();
    for tag in tags {
        let key = tag.trim().to_string();
        if key.is_empty() || !seen.insert(key.clone()) {
            continue;
        }
        *map.entry(key).or_insert(0) += 1;
    }
}

/// 统计指定 scope（SQLite 库 + 数据库连接 JSON）各标签覆盖的资源数。
fn collect_local_tags(db_path: &Path, connections_path: &Path) -> OmniResult<BTreeMap<String, usize>> {
    let storage = Storage::open(db_path, None)?;
    let mut map = BTreeMap::new();
    for conn in storage.list_connections()? {
        bump_tags(&mut map, &conn.tags);
    }
    for entry in storage.list_knowledge(None, None)? {
        bump_tags(&mut map, &entry.tags);
    }
    for req in storage.http_list_requests(None)? {
        bump_tags(&mut map, &req.tags);
    }
    for col in storage.http_list_collections()? {
        bump_tags(&mut map, &col.tags);
    }
    for env in storage.http_list_environments()? {
        bump_tags(&mut map, &env.tags);
    }
    for db in load_database_connections_from(connections_path)? {
        bump_tags(&mut map, &db.tags);
    }
    Ok(map)
}

/// 统计云端快照 bundle 中各标签覆盖的资源数。
fn collect_bundle_tags(bundle: &ModulesBundle) -> BTreeMap<String, usize> {
    let mut map = BTreeMap::new();
    for item in &bundle.connections {
        bump_tags(&mut map, &item.connection.tags);
    }
    for item in &bundle.database_connections {
        bump_tags(&mut map, &item.connection.tags);
    }
    for entry in &bundle.knowledge {
        bump_tags(&mut map, &entry.tags);
    }
    for col in &bundle.http_collections {
        bump_tags(&mut map, &col.tags);
    }
    for env in &bundle.http_environments {
        bump_tags(&mut map, &env.tags);
    }
    for req in &bundle.http_requests {
        bump_tags(&mut map, &req.tags);
    }
    for ws in &bundle.workspaces {
        bump_tags(&mut map, &ws.tags);
    }
    map
}

fn print_tag_inventory(tags: &BTreeMap<String, usize>) {
    if tags.is_empty() {
        println!("  未发现任何标签");
        return;
    }
    println!("  标签 | 资源数:");
    for (key, count) in tags {
        println!("    {key} | {count}");
    }
}

// ---------- 本地团队 scope 发现 ----------

#[derive(Debug, Deserialize)]
struct ActiveTeamFile {
    #[serde(default)]
    scope: String,
}

/// 本地一个团队 scope 的数据位置。
struct LocalScope {
    scope: String,
    db_path: PathBuf,
    connections_path: PathBuf,
    active: bool,
}

/// 读取 `store/active-team.json` 的 scope 字段（容错：缺失/非法 → `local`）。
fn read_active_scope(store_root: &Path) -> String {
    let Ok(raw) = std::fs::read_to_string(store_root.join("active-team.json")) else {
        return "local".to_string();
    };
    let scope = serde_json::from_str::<ActiveTeamFile>(&raw)
        .map(|f| f.scope.trim().to_string())
        .unwrap_or_default();
    if scope.is_empty() || scope == "0" {
        "local".to_string()
    } else {
        scope
    }
}

/// 枚举 `teams/` 下所有含主库的 scope 目录（`teams/{scope}/omnipanel.db`），按名称排序。
fn discover_local_scopes(teams_root: &Path, active_scope: &str) -> OmniResult<Vec<LocalScope>> {
    let mut scopes = Vec::new();
    let entries = match std::fs::read_dir(teams_root) {
        Ok(entries) => entries,
        Err(_) => return Ok(scopes),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let db_path = path.join("omnipanel.db");
        if !db_path.is_file() {
            continue;
        }
        let connections_path = path.join("database").join("connections.json");
        scopes.push(LocalScope {
            active: name == active_scope,
            scope: name,
            db_path,
            connections_path,
        });
    }
    scopes.sort_by(|a, b| a.scope.cmp(&b.scope));
    Ok(scopes)
}

// ---------- 清理执行 ----------

/// 清洗云端快照 bundle 中各资源的标签（其余字段原样保留）。
fn migrate_bundle(bundle: &mut ModulesBundle, cleanup: &TagCleanup) -> CleanupReport {
    let mut report = CleanupReport::default();
    for item in &mut bundle.connections {
        let change = cleanup.apply(&mut item.connection.tags);
        if change.changed() {
            report.record(ResKind::Connection, change);
        }
    }
    for item in &mut bundle.database_connections {
        let change = cleanup.apply(&mut item.connection.tags);
        if change.changed() {
            report.record(ResKind::Database, change);
        }
    }
    for entry in &mut bundle.knowledge {
        let change = cleanup.apply(&mut entry.tags);
        if change.changed() {
            report.record(ResKind::Knowledge, change);
        }
    }
    for col in &mut bundle.http_collections {
        let change = cleanup.apply(&mut col.tags);
        if change.changed() {
            report.record(ResKind::HttpCollection, change);
        }
    }
    for env in &mut bundle.http_environments {
        let change = cleanup.apply(&mut env.tags);
        if change.changed() {
            report.record(ResKind::HttpEnvironment, change);
        }
    }
    for req in &mut bundle.http_requests {
        let change = cleanup.apply(&mut req.tags);
        if change.changed() {
            report.record(ResKind::HttpRequest, change);
        }
    }
    for ws in &mut bundle.workspaces {
        let change = cleanup.apply(&mut ws.tags);
        if change.changed() {
            report.record(ResKind::Workspace, change);
        }
    }
    report
}

/// 清理本地数据：SQLite 库内资源 + 数据库连接配置 JSON。
fn migrate_local_scope(
    scope: &LocalScope,
    cleanup: &TagCleanup,
    dry_run: bool,
) -> OmniResult<CleanupReport> {
    let storage = Storage::open(&scope.db_path, None)?;
    let mut report = CleanupReport::default();

    for mut conn in storage.list_connections()? {
        let change = cleanup.apply(&mut conn.tags);
        if change.changed() {
            if !dry_run {
                storage.save_connection(&conn)?;
            }
            report.record(ResKind::Connection, change);
        }
    }
    for mut entry in storage.list_knowledge(None, None)? {
        let change = cleanup.apply(&mut entry.tags);
        if change.changed() {
            if !dry_run {
                storage.save_knowledge(&entry)?;
            }
            report.record(ResKind::Knowledge, change);
        }
    }
    for mut req in storage.http_list_requests(None)? {
        let change = cleanup.apply(&mut req.tags);
        if change.changed() {
            if !dry_run {
                storage.http_save_request(&req)?;
            }
            report.record(ResKind::HttpRequest, change);
        }
    }
    for mut col in storage.http_list_collections()? {
        let change = cleanup.apply(&mut col.tags);
        if change.changed() {
            if !dry_run {
                storage.http_save_collection(&col)?;
            }
            report.record(ResKind::HttpCollection, change);
        }
    }
    for mut env in storage.http_list_environments()? {
        let change = cleanup.apply(&mut env.tags);
        if change.changed() {
            if !dry_run {
                storage.http_save_environment(&env)?;
            }
            report.record(ResKind::HttpEnvironment, change);
        }
    }

    // 数据库连接存于 connections.json，不在 SQLite 库中
    let mut dbs = load_database_connections_from(&scope.connections_path)?;
    let mut dbs_changed = false;
    for db in dbs.iter_mut() {
        let change = cleanup.apply(&mut db.tags);
        if change.changed() {
            dbs_changed = true;
            report.record(ResKind::Database, change);
        }
    }
    if !dry_run && dbs_changed {
        save_database_connections_to(&scope.connections_path, &dbs)?;
    }
    Ok(report)
}

/// 拉取并解密单个团队的云端模块快照（无快照时为 None）。
async fn pull_team_bundle(
    auth: &AuthContext,
    me: &AccountProfile,
    team: &TeamMembership,
) -> OmniResult<Option<ModulesBundle>> {
    let pulled = pull_team_sync_json(auth, team.id, TEAM_MODULES_LATEST_LEAF).await?;
    let Some((_object_key, bytes)) = pulled else {
        return Ok(None);
    };
    println!("已拉取云端快照 ({} 字节)", bytes.len());

    let team_key = load_sync_team_key(team.id)?;
    let legacy = sync_blob_key_material(me, team);
    let plaintext = decode_sync_blob_with_sources(
        team_key.as_ref(),
        team.id,
        legacy.as_deref(),
        SYNC_KIND_MODULES,
        &bytes,
    )?;
    let bundle: ModulesBundle = serde_json::from_slice(&plaintext).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析云端模块快照失败").with_cause(e.to_string())
    })?;
    Ok(Some(bundle))
}

/// 序列化、校验、加密并推送单个团队的快照。
async fn push_team_bundle(
    auth: &AuthContext,
    team: &TeamMembership,
    mut bundle: ModulesBundle,
) -> OmniResult<()> {
    bundle.updated_at = now_ms();
    let plaintext = serde_json::to_vec(&bundle).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化模块同步数据失败").with_cause(e.to_string())
    })?;
    validate_modules_bundle_json(&plaintext)?;
    let (team_key, _) = get_or_create_sync_team_key(team.id)?;
    let body = encrypt_sync_team_blob(&team_key, team.id, SYNC_KIND_MODULES, &plaintext)?;
    let uploaded = push_team_sync_json(auth, team.id, TEAM_MODULES_LATEST_LEAF, &body).await?;
    println!("已推送清洗后的快照: {} ({} 字节)", uploaded.object_key, uploaded.bytes);
    Ok(())
}

/// 确定要处理的团队列表：显式 --team-id 取单个，否则取账号下全部有效团队（个人 + 组织）。
fn target_teams(team_id: Option<i64>, me: &AccountProfile) -> OmniResult<Vec<TeamMembership>> {
    match team_id {
        Some(id) if id > 0 => Ok(vec![resolve_sync_team(Some(id), me)?.clone()]),
        _ => Ok(me.teams.iter().filter(|t| t.id > 0).cloned().collect()),
    }
}

/// 列出各本地 scope 与各云端团队的标签清单后退出（无凭证时仅本地）。
async fn run_list_tags(
    http: &reqwest::Client,
    identity: &DeviceIdentityFile,
    token: Option<String>,
    scopes: &[LocalScope],
    team_id: Option<i64>,
) -> OmniResult<()> {
    for scope in scopes {
        let title = if scope.active {
            format!("本地 [scope={}（当前）]", scope.scope)
        } else {
            format!("本地 [scope={}]", scope.scope)
        };
        println!("\n{title}");
        match collect_local_tags(&scope.db_path, &scope.connections_path) {
            Ok(tags) => print_tag_inventory(&tags),
            Err(e) => println!("  读取失败: {e:?}"),
        }
    }
    let Some(token) = token else {
        println!("\n（未提供登录凭证，仅统计本地；加 --email 或 --token 可同时统计云端各团队）");
        return Ok(());
    };
    let me = fetch_me(http, &token).await?;
    let auth = AuthContext {
        api_base: AUTH_API_BASE.to_string(),
        access_token: token,
        app_id: CLIENT_APP_ID.to_string(),
        device_id: identity.device_id.clone(),
        device_public_key: String::new(),
        http: http.clone(),
    };
    for team in target_teams(team_id, &me)? {
        let title = format!("\n云端 [团队 {} · id={} · {}]", team.name, team.id, team.kind);
        match pull_team_bundle(&auth, &me, &team).await {
            Ok(Some(bundle)) => {
                println!("{title}");
                print_tag_inventory(&collect_bundle_tags(&bundle));
            }
            Ok(None) => println!("{title}: 无快照"),
            Err(e) => println!("{title}: 拉取失败 {e:?}"),
        }
    }
    Ok(())
}

// ---------- 主流程 ----------

async fn run(args: &Args) -> OmniResult<()> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e.to_string())
        })?;

    let identity = load_device_identity()?;
    println!("本机设备: {} ({})", identity.device_name, identity.device_id);

    // 凭证优先级：--token > --email 登录 > 环境变量（--list-tags 允许无凭证）
    let token = match args
        .token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(token) => Some(token.to_string()),
        None => match args
            .email
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(email) => Some(login_email(&http, &identity, email).await?),
            None => env_token(),
        },
    };

    // 本地数据范围：--db 指定单个库，否则枚举全部团队 scope
    let store_root = omnipd_root()?.join("store");
    let scopes = match &args.db {
        Some(db) => {
            let connections = db
                .parent()
                .map(|p| p.join("database").join("connections.json"))
                .unwrap_or_else(|| db.with_file_name("connections.json"));
            vec![LocalScope {
                scope: "指定".to_string(),
                db_path: db.clone(),
                connections_path: connections,
                active: false,
            }]
        }
        None => {
            let active = read_active_scope(&store_root);
            let found = discover_local_scopes(&store_root.join("teams"), &active)?;
            if found.is_empty() {
                return Err(OmniError::new(
                    ErrorCode::NotFound,
                    format!(
                        "{} 下未找到任何团队数据目录（teams/*/omnipanel.db）",
                        store_root.join("teams").display()
                    ),
                ));
            }
            found
        }
    };
    println!("本地数据范围（{} 个 scope）:", scopes.len());
    for scope in &scopes {
        let mark = if scope.active { "（当前团队）" } else { "" };
        println!("  scope={} {mark}: {}", scope.scope, scope.db_path.display());
    }

    if args.list_tags {
        return run_list_tags(&http, &identity, token, &scopes, args.team_id).await;
    }

    let Some(token) = token else {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "缺少登录凭证：传入 --email <邮箱> 走验证码登录，或 --token / 环境变量 OMNIPANEL_TOKEN",
        ));
    };

    if args.no_migrate && args.remove_tags.is_empty() {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "--no-migrate 需配合 --remove-tag 使用，否则没有任何清理动作",
        ));
    }

    let mut cleanup = TagCleanup {
        migrate: !args.no_migrate,
        device_names: Vec::new(),
        current: identity.device_name.trim().to_string(),
        remove: args.remove_tags.clone(),
    };
    if cleanup.migrate {
        let mut device_names = fetch_device_names(&http, &token, &identity).await?;
        if !cleanup.current.is_empty() && !device_names.contains(&cleanup.current) {
            device_names.push(cleanup.current.clone());
        }
        println!(
            "账号设备 ({} 台): {}",
            device_names.len(),
            device_names.join("、")
        );
        cleanup.device_names = device_names;
    } else {
        println!("已跳过设备名标签迁移（--no-migrate）");
    }
    if cleanup.removal_requested() {
        println!(
            "待删除标签 ({} 个): {}",
            cleanup.remove.len(),
            cleanup.remove.join("、")
        );
    }

    // 本地：逐 scope 清理，单个失败不影响其他 scope
    let mut failures: Vec<String> = Vec::new();
    for scope in &scopes {
        let title = format!("本地数据 [scope={}]", scope.scope);
        match migrate_local_scope(scope, &cleanup, args.dry_run) {
            Ok(report) => report.print(&title, cleanup.removal_requested()),
            Err(e) => {
                let msg = format!("{title}: {e:?}");
                println!("警告: {msg}");
                failures.push(msg);
            }
        }
    }

    // 云端：遍历账号下全部团队（个人 + 组织），逐团队清洗快照
    let me = fetch_me(&http, &token).await?;
    let teams = target_teams(args.team_id, &me)?;
    let auth = AuthContext {
        api_base: AUTH_API_BASE.to_string(),
        access_token: token,
        app_id: CLIENT_APP_ID.to_string(),
        device_id: identity.device_id.clone(),
        device_public_key: String::new(),
        http: http.clone(),
    };
    if teams.is_empty() {
        println!("\n账号没有可用团队，跳过云端清理");
    }
    let mut pushed = 0usize;
    for team in &teams {
        println!(
            "\n云端团队: {} (id={}, kind={})",
            team.name, team.id, team.kind
        );
        let bundle = match pull_team_bundle(&auth, &me, team).await {
            Ok(Some(bundle)) => bundle,
            Ok(None) => {
                println!("云端无模块快照，跳过");
                continue;
            }
            Err(e) => {
                let msg = format!("团队 {} (id={}) 快照拉取/解密失败: {e:?}", team.name, team.id);
                println!("警告: {msg}");
                failures.push(msg);
                continue;
            }
        };
        let mut bundle = bundle;
        let report = migrate_bundle(&mut bundle, &cleanup);
        report.print("云端快照", cleanup.removal_requested());
        if args.dry_run || !report.changed() {
            if !args.dry_run {
                println!("云端标签已是干净状态，无需推送");
            }
            continue;
        }
        match push_team_bundle(&auth, team, bundle).await {
            Ok(()) => pushed += 1,
            Err(e) => {
                let msg = format!("团队 {} (id={}) 推送失败: {e:?}", team.name, team.id);
                println!("警告: {msg}");
                failures.push(msg);
            }
        }
    }

    if args.dry_run {
        println!("\n[dry-run] 未写入本地、未推送云端");
    } else {
        println!(
            "\n完成：本地 {} 个 scope 已处理，云端 {} 个团队快照已更新",
            scopes.len(),
            pushed
        );
        println!("下次启动 OmniPanel 拉取到的将是干净标签，删除的标签不会再被还原");
    }
    summarize(failures)
}

/// 全部工作完成后汇总失败项（部分失败不阻断其他目标）。
fn summarize(failures: Vec<String>) -> OmniResult<()> {
    if failures.is_empty() {
        return Ok(());
    }
    Err(OmniError::new(
        ErrorCode::Internal,
        format!(
            "部分目标处理失败（{} 项，其余已完成）:\n{}",
            failures.len(),
            failures.join("\n")
        ),
    ))
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("参数错误: {message}\n");
            print_usage();
            return ExitCode::from(2);
        }
    };
    if args.help {
        print_usage();
        return ExitCode::SUCCESS;
    }
    match run(&args).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("\n执行失败: {err:?}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cleanup_with(remove: &[&str], migrate: bool) -> TagCleanup {
        TagCleanup {
            migrate,
            device_names: vec!["pc1".to_string(), "pc2".to_string()],
            current: "pc2".to_string(),
            remove: remove.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn str_vec(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn remove_specified_tags_removes_exact_matches_only() {
        let mut tags = str_vec(&["foo", "bar", "Foo"]);
        assert!(remove_specified_tags(&mut tags, &["foo".to_string()]));
        assert_eq!(tags, str_vec(&["bar", "Foo"]));
    }

    #[test]
    fn remove_specified_tags_no_match_returns_false() {
        let mut tags = str_vec(&["foo"]);
        assert!(!remove_specified_tags(&mut tags, &["baz".to_string()]));
        assert_eq!(tags, str_vec(&["foo"]));
    }

    #[test]
    fn remove_specified_tags_trims_resource_tag_whitespace() {
        let mut tags = str_vec(&["  foo  ", "keep"]);
        assert!(remove_specified_tags(&mut tags, &["foo".to_string()]));
        assert_eq!(tags, str_vec(&["keep"]));
    }

    #[test]
    fn remove_specified_tags_handles_multiple() {
        let mut tags = str_vec(&["a", "b", "c"]);
        assert!(remove_specified_tags(&mut tags, &["a".to_string(), "c".to_string()]));
        assert_eq!(tags, str_vec(&["b"]));
    }

    #[test]
    fn apply_runs_removal_after_migration() {
        // pc1 迁移为 creator:pc1 后，显式删除 creator:pc1 生效（不被迁移逻辑补回）
        let cleanup = cleanup_with(&["creator:pc1"], true);
        let mut tags = str_vec(&["pc1", "keep"]);
        let change = cleanup.apply(&mut tags);
        assert!(change.migrated);
        assert!(change.removed);
        assert_eq!(tags, str_vec(&["keep"]));
    }

    #[test]
    fn apply_no_migrate_leaves_device_and_creator_tags_alone() {
        let cleanup = cleanup_with(&["foo"], false);
        let mut tags = str_vec(&["pc1", "foo", "keep"]);
        let change = cleanup.apply(&mut tags);
        assert!(!change.migrated);
        assert!(change.removed);
        assert_eq!(tags, str_vec(&["pc1", "keep"]));
    }

    #[test]
    fn apply_combined_migration_and_removal() {
        let cleanup = cleanup_with(&["a", "b"], true);
        let mut tags = str_vec(&["a", "b", "c", "pc1"]);
        let change = cleanup.apply(&mut tags);
        assert!(change.migrated);
        assert!(change.removed);
        assert_eq!(tags, str_vec(&["c", "creator:pc1"]));
    }

    #[test]
    fn apply_nothing_to_do_reports_no_change() {
        // 已有 creator 且无设备名标签的资源：迁移与删除均无动作
        let cleanup = cleanup_with(&["zzz"], true);
        let mut tags = str_vec(&["creator:pc1", "keep"]);
        let change = cleanup.apply(&mut tags);
        assert!(!change.changed());
        assert_eq!(tags, str_vec(&["creator:pc1", "keep"]));
    }

    #[test]
    fn apply_migration_backfills_creator_when_missing() {
        // 迁移语义：无 creator 的资源即使没有设备名标签也会补 creator:<当前设备>
        let cleanup = cleanup_with(&[], true);
        let mut tags = str_vec(&["keep"]);
        let change = cleanup.apply(&mut tags);
        assert!(change.migrated);
        assert!(!change.removed);
        assert_eq!(tags, str_vec(&["keep", "creator:pc2"]));
    }

    #[test]
    fn parse_args_supports_repeated_and_comma_separated_remove_tags() {
        let args = parse_args_from([
            "--remove-tag".to_string(),
            "foo, bar ".to_string(),
            "--remove-tag".to_string(),
            "baz".to_string(),
            "--remove-tag".to_string(),
            "foo".to_string(),
        ])
        .unwrap();
        assert_eq!(args.remove_tags, vec!["foo", "bar", "baz"]);
    }

    #[test]
    fn parse_args_rejects_remove_tag_without_value() {
        assert!(parse_args_from(["--remove-tag".to_string()]).is_err());
    }

    #[test]
    fn parse_args_flags_without_value() {
        let args = parse_args_from(["--no-migrate".to_string(), "--list-tags".to_string(), "--dry-run".to_string()]).unwrap();
        assert!(args.no_migrate);
        assert!(args.list_tags);
        assert!(args.dry_run);
    }

    #[test]
    fn discover_local_scopes_only_picks_dirs_with_db_and_marks_active() {
        let root = std::env::temp_dir().join(format!("tct-scopes-{}-{}", std::process::id(), line!()));
        let _ = std::fs::remove_dir_all(&root);
        for scope in ["1", "2", "local", "no-db"] {
            std::fs::create_dir_all(root.join(scope)).unwrap();
            if scope != "no-db" {
                std::fs::write(root.join(scope).join("omnipanel.db"), b"stub").unwrap();
            }
        }
        std::fs::write(root.join("stray.txt"), b"").unwrap();

        let scopes = discover_local_scopes(&root, "2").unwrap();
        let names: Vec<&str> = scopes.iter().map(|s| s.scope.as_str()).collect();
        assert_eq!(names, vec!["1", "2", "local"]);
        assert!(scopes.iter().find(|s| s.scope == "2").unwrap().active);
        assert!(!scopes.iter().find(|s| s.scope == "1").unwrap().active);
        assert_eq!(
            scopes[0].connections_path,
            root.join("1").join("database").join("connections.json")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_active_scope_defaults_and_parses() {
        let root = std::env::temp_dir().join(format!("tct-active-{}-{}", std::process::id(), line!()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        assert_eq!(read_active_scope(&root), "local");
        std::fs::write(root.join("active-team.json"), r#"{ "scope": "3" }"#).unwrap();
        assert_eq!(read_active_scope(&root), "3");
        std::fs::write(root.join("active-team.json"), r#"{ "scope": "0" }"#).unwrap();
        assert_eq!(read_active_scope(&root), "local");
        std::fs::write(root.join("active-team.json"), "not json").unwrap();
        assert_eq!(read_active_scope(&root), "local");
        let _ = std::fs::remove_dir_all(&root);
    }
}
