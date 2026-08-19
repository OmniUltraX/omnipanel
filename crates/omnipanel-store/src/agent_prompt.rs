//! 智能体提示词：
//! - 共享协议提示词：`~/.omnipd/prompts/system-prompt.md`（ACP Client Tools）
//! - 各 Agent 角色提示词：`~/.omnipd/prompts/agents/{id}.md`（设置页按模块编辑）
//!
//! 已存在的用户文件**不会**被覆盖，便于本地配置。

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

use omnipanel_error::OmniResult;

use crate::paths::{map_io, prompts_root};

/// 提示词文件名（位于 `~/.omnipd/prompts/`）。
pub mod files {
    /// ACP / Client Tools 协议层提示词（非模块角色）。
    pub const SYSTEM_PROMPT: &str = "system-prompt.md";
    /// 兼容旧版文件名（仅用于首次迁移读取）。
    pub const LEGACY_CLIENT_TOOLS_PREAMBLE: &str = "client-tools-preamble.md";
    /// 各 Agent 角色提示词目录。
    pub const AGENTS_DIR: &str = "agents";
}

/// 可配置的逻辑 Agent 提示词 id（与前端 `AgentId` 对齐）。
pub const AGENT_PROMPT_IDS: &[&str] = &[
    "plan", // AI 助手页 Plan：TodoList / 计划
    "run",  // AI 助手页 Run：全工具执行
    "terminal", // 含原 SSH（已并入终端模块）
    "database",
    "docker",
    "server",
    "files",
    "knowledge",
    "protocol",
    "workflow",
    "tasks",
];

const DEFAULT_SYSTEM_PROMPT: &str = include_str!("../resources/prompts/system-prompt.md");
const DEFAULT_ROUTING_POLICY: &str = include_str!("../resources/prompts/routing-policy.md");
const DEFAULT_SERVER_AGENT_PROMPT: &str = include_str!("../resources/prompts/agents/server.md");
const DEFAULT_KNOWLEDGE_AGENT_PROMPT: &str =
    include_str!("../resources/prompts/agents/knowledge.md");
const DEFAULT_PROTOCOL_AGENT_PROMPT: &str =
    include_str!("../resources/prompts/agents/protocol.md");
const DEFAULT_WORKFLOW_AGENT_PROMPT: &str =
    include_str!("../resources/prompts/agents/workflow.md");
const DEFAULT_TASKS_AGENT_PROMPT: &str = include_str!("../resources/prompts/agents/tasks.md");
const DEFAULT_PLAN_AGENT_PROMPT: &str = include_str!("../resources/prompts/agents/plan.md");
const DEFAULT_RUN_AGENT_PROMPT: &str = include_str!("../resources/prompts/agents/run.md");
const DEFAULT_TERMINAL_AGENT_PROMPT: &str =
    include_str!("../resources/prompts/agents/terminal.md");
const DEFAULT_DATABASE_AGENT_PROMPT: &str =
    include_str!("../resources/prompts/agents/database.md");
const DEFAULT_DOCKER_AGENT_PROMPT: &str =
    include_str!("../resources/prompts/agents/docker.md");
const DEFAULT_FILES_AGENT_PROMPT: &str =
    include_str!("../resources/prompts/agents/files.md");

/// 历史短版 / 旧 chat 命名默认文案：仍等于这些内容时，启动时可升级（不覆盖用户自定义）。
const LEGACY_PLAN_AGENT_PROMPTS: &[&str] = &[
    "你是 OmniPanel 的「聊天助手」Agent。你只负责对话、解释与建议，不能调用任何工具或执行操作。若用户需要操作终端/SSH/数据库/Docker 等，请说明应切换到对应模块 Agent。",
    "你是 OmniPanel 的「聊天助手」Agent。你只负责对话、解释与建议，不能调用任何工具或执行操作。若用户需要操作终端/数据库/Docker 等，请说明应切换到对应模块 Agent。",
    "你是 OmniPanel 的「聊天助手」Agent，主责创建可执行的 Markdown 待办清单（TodoList）。不能调用工具或执行操作；需要落地时提示切换模块 Agent。输出以 `- [ ]` 勾选列表为主，便于保存到知识库待办。",
];

const LEGACY_TERMINAL_AGENT_PROMPTS: &[&str] = &[
    "你是 OmniPanel 的「终端」Agent，专注终端会话、命令与输出分析；仅使用终端相关工具。",
    "你是 OmniPanel 的「终端」Agent，覆盖本地终端与 SSH 远程会话、命令执行与主机相关操作；仅使用终端模块工具（含原 SSH 工具）。",
];

const LEGACY_DATABASE_AGENT_PROMPTS: &[&str] = &[
    "你是 OmniPanel 的「数据库」Agent，专注连接、Schema 与 SQL；仅使用数据库相关工具。",
];

const LEGACY_DOCKER_AGENT_PROMPTS: &[&str] = &[
    "你是 OmniPanel 的「Docker」Agent，专注容器/镜像/Compose；仅使用 Docker 相关工具。",
];

const LEGACY_FILES_AGENT_PROMPTS: &[&str] = &[
    "你是 OmniPanel 的「文件」Agent，专注文件浏览与读写；仅使用文件相关工具。",
];

struct CachedFile {
    mtime: Option<SystemTime>,
    content: String,
}

static SYSTEM_CACHE: Mutex<Option<CachedFile>> = Mutex::new(None);
static AGENT_CACHE: LazyLock<Mutex<HashMap<String, CachedFile>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn default_agent_prompt(id: &str) -> &'static str {
    match id {
        "plan" => DEFAULT_PLAN_AGENT_PROMPT,
        "run" => DEFAULT_RUN_AGENT_PROMPT,
        "terminal" => DEFAULT_TERMINAL_AGENT_PROMPT,
        "database" => DEFAULT_DATABASE_AGENT_PROMPT,
        "docker" => DEFAULT_DOCKER_AGENT_PROMPT,
        "files" => DEFAULT_FILES_AGENT_PROMPT,
        "server" => DEFAULT_SERVER_AGENT_PROMPT,
        "knowledge" => DEFAULT_KNOWLEDGE_AGENT_PROMPT,
        "protocol" => DEFAULT_PROTOCOL_AGENT_PROMPT,
        "workflow" => DEFAULT_WORKFLOW_AGENT_PROMPT,
        "tasks" => DEFAULT_TASKS_AGENT_PROMPT,
        _ => "你是 OmniPanel 的助手 Agent，请按用户意图协助完成任务。多步骤用 omni_plan_create；独立并行子任务用 omni_spawn_sub_conversations。",
    }
}

fn upgrade_legacy_agent_prompt_if_needed(
    id: &str,
    legacy: &[&str],
    next: &str,
) -> OmniResult<()> {
    let path = agent_prompt_path(id)?;
    if !path.exists() {
        return Ok(());
    }
    let Ok(current) = fs::read_to_string(&path) else {
        return Ok(());
    };
    let trimmed = current.trim();
    let should_upgrade = legacy.iter().any(|item| trimmed == *item)
        // 旧版 TodoList / 无工具版计划提示词
        || (id == "plan"
            && (trimmed.starts_with("# OmniPanel · 聊天助手")
                || trimmed.starts_with("# OmniPanel · 计划助手（TodoList）")))
        // 旧版终端提示词：有标准章节但未引导 omni_plan_*（仍是内置默认结构）
        || (id == "terminal"
            && trimmed.starts_with("# OmniPanel · 终端 Agent")
            && trimmed.contains("## 命令与工具习惯")
            && !trimmed.contains("omni_plan_create"));
    if !should_upgrade {
        return Ok(());
    }
    fs::write(&path, next).map_err(map_io)?;
    clear_prompt_cache();
    Ok(())
}

/// 将用户目录 `agents/chat.md` 迁移为 `agents/plan.md`（仅当 plan 尚不存在时）。
fn migrate_chat_agent_file_to_plan() -> OmniResult<()> {
    let dir = agents_dir()?;
    let legacy = dir.join("chat.md");
    let next = dir.join("plan.md");
    if !legacy.exists() {
        return Ok(());
    }
    if !next.exists() {
        fs::rename(&legacy, &next).map_err(map_io)?;
    } else {
        let _ = fs::remove_file(&legacy);
    }
    clear_prompt_cache();
    Ok(())
}

fn write_if_missing(path: &PathBuf, content: &str) -> OmniResult<()> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(map_io)?;
    }
    fs::write(path, content).map_err(map_io)?;
    Ok(())
}

fn agents_dir() -> OmniResult<PathBuf> {
    Ok(prompts_root()?.join(files::AGENTS_DIR))
}

fn agent_prompt_path(id: &str) -> OmniResult<PathBuf> {
    Ok(agents_dir()?.join(format!("{id}.md")))
}

fn is_known_agent_id(id: &str) -> bool {
    AGENT_PROMPT_IDS.contains(&id)
}

/// 首次将内置默认提示词写入用户目录（已存在则跳过）。
pub fn ensure_default_prompts() -> OmniResult<()> {
    let root = prompts_root()?;
    let path = root.join(files::SYSTEM_PROMPT);
    if !path.exists() {
        let legacy = root.join(files::LEGACY_CLIENT_TOOLS_PREAMBLE);
        if legacy.exists() {
            if let Ok(legacy_content) = fs::read_to_string(&legacy) {
                if !legacy_content.trim().is_empty() {
                    write_if_missing(&path, &legacy_content)?;
                } else {
                    write_if_missing(&path, DEFAULT_SYSTEM_PROMPT)?;
                }
            } else {
                write_if_missing(&path, DEFAULT_SYSTEM_PROMPT)?;
            }
        } else {
            write_if_missing(&path, DEFAULT_SYSTEM_PROMPT)?;
        }
    }

    let dir = agents_dir()?;
    fs::create_dir_all(&dir).map_err(map_io)?;
    // chat → plan：先搬迁用户目录旧文件，再补种默认
    let _ = migrate_chat_agent_file_to_plan();
    for id in AGENT_PROMPT_IDS {
        let agent_path = dir.join(format!("{id}.md"));
        write_if_missing(&agent_path, default_agent_prompt(id))?;
    }
    // 将历史短版默认提示词升级（用户自定义内容不覆盖）。
    let _ = upgrade_legacy_agent_prompt_if_needed(
        "plan",
        LEGACY_PLAN_AGENT_PROMPTS,
        DEFAULT_PLAN_AGENT_PROMPT,
    );
    let _ = upgrade_legacy_agent_prompt_if_needed(
        "terminal",
        LEGACY_TERMINAL_AGENT_PROMPTS,
        DEFAULT_TERMINAL_AGENT_PROMPT,
    );
    let _ = upgrade_legacy_agent_prompt_if_needed(
        "database",
        LEGACY_DATABASE_AGENT_PROMPTS,
        DEFAULT_DATABASE_AGENT_PROMPT,
    );
    let _ = upgrade_legacy_agent_prompt_if_needed(
        "docker",
        LEGACY_DOCKER_AGENT_PROMPTS,
        DEFAULT_DOCKER_AGENT_PROMPT,
    );
    let _ = upgrade_legacy_agent_prompt_if_needed(
        "files",
        LEGACY_FILES_AGENT_PROMPTS,
        DEFAULT_FILES_AGENT_PROMPT,
    );
    let _ = migrate_plan_todolist_tool_rename();
    let _ = migrate_ask_user_prompt_guidance();
    let _ = migrate_omni_terminal_tool_rename();
    let _ = migrate_terminal_web_search_guidance();

    Ok(())
}

/// 将内置默认结构的 agent / system 提示词升级为引导使用 `omni_ask_user`。
/// 仅在仍像官方默认文案、且尚未提及该工具时替换/修补，避免覆盖用户深度自定义。
fn migrate_ask_user_prompt_guidance() -> OmniResult<()> {
    // run：旧版默认（含 omni_create_todolist / 「先问关键问题」）整篇替换
    {
        let path = agent_prompt_path("run")?;
        if path.exists() {
            if let Ok(current) = fs::read_to_string(&path) {
                let trimmed = current.trim();
                if trimmed.starts_with("# OmniPanel · 执行助手")
                    && !trimmed.contains("omni_ask_user")
                    && (trimmed.contains("先问关键问题")
                        || trimmed.contains("omni_create_todolist")
                        || trimmed.contains("先问 1～3 个关键问题"))
                {
                    fs::write(&path, DEFAULT_RUN_AGENT_PROMPT).map_err(map_io)?;
                    clear_prompt_cache();
                }
            }
        }
    }

    // terminal：官方默认结构且未引导 ask_user → 整篇替换
    {
        let path = agent_prompt_path("terminal")?;
        if path.exists() {
            if let Ok(current) = fs::read_to_string(&path) {
                let trimmed = current.trim();
                if trimmed.starts_with("# OmniPanel · 终端 Agent")
                    && !trimmed.contains("omni_ask_user")
                    && trimmed.contains("## 命令与工具习惯")
                {
                    fs::write(&path, DEFAULT_TERMINAL_AGENT_PROMPT).map_err(map_io)?;
                    clear_prompt_cache();
                }
            }
        }
    }

    // plan：缺 ask_user 且仍是官方 Plan 标题 → 整篇替换
    {
        let path = agent_prompt_path("plan")?;
        if path.exists() {
            if let Ok(current) = fs::read_to_string(&path) {
                let trimmed = current.trim();
                if trimmed.starts_with("# OmniPanel · 计划助手（Plan）")
                    && !trimmed.contains("omni_ask_user")
                {
                    fs::write(&path, DEFAULT_PLAN_AGENT_PROMPT).map_err(map_io)?;
                    clear_prompt_cache();
                }
            }
        }
    }

    // system-prompt：补协议第 9 条（仅当仍是官方 Client Tool API 文案且无 ask_user）
    {
        let path = prompts_root()?.join(files::SYSTEM_PROMPT);
        if path.exists() {
            if let Ok(current) = fs::read_to_string(&path) {
                let trimmed = current.trim();
                if trimmed.starts_with("[System — OmniPanel Client Tool API]")
                    && !trimmed.contains("omni_ask_user")
                {
                    fs::write(&path, DEFAULT_SYSTEM_PROMPT).map_err(map_io)?;
                    clear_prompt_cache();
                }
            }
        }
    }

    // system-prompt：修正「本地用 omni_terminal_*」误导（已拆回 omni_terminal_exec）
    {
        let path = prompts_root()?.join(files::SYSTEM_PROMPT);
        if path.exists() {
            if let Ok(current) = fs::read_to_string(&path) {
                let trimmed = current.trim();
                if trimmed.starts_with("[System — OmniPanel Client Tool API]")
                    && trimmed.contains("omni_terminal_*")
                    && !trimmed.contains("call `omni_terminal_exec`")
                {
                    fs::write(&path, DEFAULT_SYSTEM_PROMPT).map_err(map_io)?;
                    clear_prompt_cache();
                }
            }
        }
    }

    // system-prompt：把「本地也用 omni_ssh_exec」的合并文案拆回 omni_terminal_exec
    {
        let path = prompts_root()?.join(files::SYSTEM_PROMPT);
        if path.exists() {
            if let Ok(current) = fs::read_to_string(&path) {
                let trimmed = current.trim();
                if trimmed.starts_with("[System — OmniPanel Client Tool API]")
                    && trimmed.contains("call `omni_ssh_exec` (bound terminal session")
                    && !trimmed.contains("omni_terminal_exec")
                {
                    fs::write(&path, DEFAULT_SYSTEM_PROMPT).map_err(map_io)?;
                    clear_prompt_cache();
                }
            }
        }
    }

    // system-prompt：旧版把路由政策写进协议层 → 换成瘦身后的协议 + 独立 routing-policy
    {
        let path = prompts_root()?.join(files::SYSTEM_PROMPT);
        if path.exists() {
            if let Ok(current) = fs::read_to_string(&path) {
                let trimmed = current.trim();
                if trimmed.starts_with("[System — OmniPanel Client Tool API]")
                    && (trimmed.contains("Never claim you cannot run commands")
                        || trimmed.contains("Current terminal tab (local PowerShell"))
                {
                    fs::write(&path, DEFAULT_SYSTEM_PROMPT).map_err(map_io)?;
                    clear_prompt_cache();
                }
            }
        }
    }

    {
        let path = agent_prompt_path("terminal")?;
        if path.exists() {
            if let Ok(current) = fs::read_to_string(&path) {
                if current.trim().starts_with("# OmniPanel · 终端")
                    && current.contains("禁止凭记忆编造")
                {
                    fs::write(&path, DEFAULT_TERMINAL_AGENT_PROMPT).map_err(map_io)?;
                    clear_prompt_cache();
                }
            }
        }
    }

    Ok(())
}

/// 将提示词中已废弃的 `omni_terminal_run_terminal_command` / 旧通配引用收敛到 `omni_terminal_exec`。
/// 仅改官方默认结构文案；深度自定义若完全不像默认标题则跳过整篇替换，仍做安全字符串替换。
fn migrate_omni_terminal_tool_rename() -> OmniResult<()> {
    // agents/terminal.md
    {
        let path = agent_prompt_path("terminal")?;
        if path.exists() {
            if let Ok(current) = fs::read_to_string(&path) {
                let looks_official = current.trim().starts_with("# OmniPanel · 终端");
                let needs_split = looks_official
                    && current.contains("omni_ssh_exec 同时覆盖")
                    && !current.contains("omni_terminal_exec");
                if needs_split {
                    fs::write(&path, DEFAULT_TERMINAL_AGENT_PROMPT).map_err(map_io)?;
                    clear_prompt_cache();
                } else if current.contains("omni_terminal_run_terminal_command")
                    || current.contains("`omni_terminal_*`")
                {
                    let next = rewrite_omni_terminal_refs(&current);
                    if next != current {
                        fs::write(&path, next).map_err(map_io)?;
                        clear_prompt_cache();
                    }
                }
            }
        }
    }

    // agents/run.md
    {
        let path = agent_prompt_path("run")?;
        if path.exists() {
            if let Ok(current) = fs::read_to_string(&path) {
                let looks_official = current.trim().starts_with("# OmniPanel · 执行助手");
                let needs_split = looks_official
                    && current.contains("均用 `omni_ssh_exec`")
                    && !current.contains("omni_terminal_exec");
                if needs_split {
                    fs::write(&path, DEFAULT_RUN_AGENT_PROMPT).map_err(map_io)?;
                    clear_prompt_cache();
                } else if current.contains("omni_terminal_run_terminal_command")
                    || current.contains("`omni_terminal_*`")
                {
                    let next = rewrite_omni_terminal_refs(&current);
                    if next != current {
                        fs::write(&path, next).map_err(map_io)?;
                        clear_prompt_cache();
                    }
                }
            }
        }
    }

    // agents/plan.md：禁止列表里去掉已不存在的旧通配
    {
        let path = agent_prompt_path("plan")?;
        if path.exists() {
            if let Ok(current) = fs::read_to_string(&path) {
                if current.contains("`omni_terminal_*`")
                    || current.contains("omni_terminal_run_terminal_command")
                {
                    let next = rewrite_omni_terminal_refs(&current);
                    if next != current {
                        fs::write(&path, next).map_err(map_io)?;
                        clear_prompt_cache();
                    }
                }
            }
        }
    }

    Ok(())
}

/// 官方终端 Agent 提示词：补上联网检索工具，避免模型误以为只能 curl。
fn migrate_terminal_web_search_guidance() -> OmniResult<()> {
    let path = agent_prompt_path("terminal")?;
    if !path.exists() {
        return Ok(());
    }
    let Ok(current) = fs::read_to_string(&path) else {
        return Ok(());
    };
    let trimmed = current.trim();
    if trimmed.starts_with("# OmniPanel · 终端 Agent")
        && trimmed.contains("你只使用终端模块工具")
        && !trimmed.contains("omni_web_search")
    {
        fs::write(&path, DEFAULT_TERMINAL_AGENT_PROMPT).map_err(map_io)?;
        clear_prompt_cache();
    }
    Ok(())
}

fn rewrite_omni_terminal_refs(src: &str) -> String {
    let mut next = src.to_string();
    next = next.replace(
        "`omni_terminal_*`、`omni_ssh_*`",
        "`omni_terminal_exec`、`omni_ssh_*`",
    );
    next = next.replace("`omni_ssh_*`、`omni_terminal_*`、", "`omni_ssh_*`、");
    next = next.replace("、`omni_terminal_*`", "");
    next = next.replace("`omni_terminal_*`、", "`omni_terminal_exec`、");
    next = next.replace("`omni_terminal_*`", "`omni_terminal_exec`");
    next = next.replace("omni_terminal_run_terminal_command", "omni_terminal_exec");
    next
}

/// 将 plan.md 从「强制 save_todolist」迁移为「交付知识库 Plan 文档」。
fn migrate_plan_todolist_tool_rename() -> OmniResult<()> {
    let path = agent_prompt_path("plan")?;
    if !path.exists() {
        return Ok(());
    }
    let Ok(current) = fs::read_to_string(&path) else {
        return Ok(());
    };
    let trimmed = current.trim();
    // 旧版默认/窄工具面：整篇替换为内置新版
    if trimmed.starts_with("# OmniPanel · 计划助手（TodoList）")
        || trimmed.contains("最终交付物必须是一份待办清单")
        || (trimmed.starts_with("# OmniPanel · 计划助手（Plan）")
            && trimmed.contains("omni_knowledge_save_todolist")
            && trimmed.contains("必须调用"))
    {
        fs::write(&path, DEFAULT_PLAN_AGENT_PROMPT).map_err(map_io)?;
        clear_prompt_cache();
        return Ok(());
    }

    let mut next = current.clone();
    next = next.replace("omni_knowledge_create_todolist", "omni_knowledge_create_document");
    next = next.replace("omni_create_todolist", "omni_knowledge_create_document");
    next = next.replace(
        "最终交付物必须是 `omni_knowledge_save_todolist` 创建的执行计划。",
        "最终交付物必须是 `omni_knowledge_create_document` 创建的 Plan 文档。",
    );
    next = next.replace(
        "- `omni_knowledge_save_todolist`：落库执行计划 / 待办（**必须调用**，除非用户明确只要口头讨论）",
        "- `omni_knowledge_create_document`：创建知识库 Plan 文档（**必须调用**，除非用户明确只要口头讨论）",
    );
    if next == current {
        return Ok(());
    }
    fs::write(&path, next).map_err(map_io)?;
    clear_prompt_cache();
    Ok(())
}

/// 清空内存缓存（保存/重置后调用）。
pub fn clear_prompt_cache() {
    if let Ok(mut cache) = SYSTEM_CACHE.lock() {
        *cache = None;
    }
    if let Ok(mut cache) = AGENT_CACHE.lock() {
        cache.clear();
    }
}

fn read_file_or_default(path: &PathBuf, default: &str) -> String {
    match fs::read_to_string(path) {
        Ok(s) if !s.trim().is_empty() => s,
        _ => default.to_string(),
    }
}

fn load_cached(
    cache: &Mutex<Option<CachedFile>>,
    path: &PathBuf,
    default: &str,
) -> String {
    let meta_mtime = fs::metadata(path).ok().and_then(|m| m.modified().ok());
    if let Ok(guard) = cache.lock() {
        if let Some(cached) = guard.as_ref() {
            if cached.mtime == meta_mtime && !cached.content.trim().is_empty() {
                return cached.content.clone();
            }
        }
    }
    let content = read_file_or_default(path, default);
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(CachedFile {
            mtime: meta_mtime,
            content: content.clone(),
        });
    }
    content
}

fn load_system_prompt() -> String {
    let _ = ensure_default_prompts();
    let path = match prompts_root() {
        Ok(root) => root.join(files::SYSTEM_PROMPT),
        Err(_) => return DEFAULT_SYSTEM_PROMPT.to_string(),
    };
    load_cached(&SYSTEM_CACHE, &path, DEFAULT_SYSTEM_PROMPT)
}

fn load_agent_prompt_file(id: &str) -> String {
    let _ = ensure_default_prompts();
    let default = default_agent_prompt(id);
    let path = match agent_prompt_path(id) {
        Ok(p) => p,
        Err(_) => return default.to_string(),
    };
    let meta_mtime = fs::metadata(&path).ok().and_then(|m| m.modified().ok());
    if let Ok(cache) = AGENT_CACHE.lock() {
        if let Some(cached) = cache.get(id) {
            if cached.mtime == meta_mtime && !cached.content.trim().is_empty() {
                return cached.content.clone();
            }
        }
    }
    let content = read_file_or_default(&path, default);
    if let Ok(mut cache) = AGENT_CACHE.lock() {
        cache.insert(
            id.to_string(),
            CachedFile {
                mtime: meta_mtime,
                content: content.clone(),
            },
        );
    }
    content
}

/// 提示词条目（设置页编辑）。
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPromptEntry {
    /// Agent id，如 `plan` / `terminal`；协议层为 `system-prompt.md`
    pub id: String,
    pub content: String,
    /// 用户目录绝对路径
    pub path: String,
}

/// 列出各模块 Agent 角色提示词（不含协议层 system-prompt）。
pub fn list_prompt_entries() -> OmniResult<Vec<AgentPromptEntry>> {
    ensure_default_prompts()?;
    let mut entries = Vec::with_capacity(AGENT_PROMPT_IDS.len());
    for id in AGENT_PROMPT_IDS {
        let path = agent_prompt_path(id)?;
        entries.push(AgentPromptEntry {
            id: (*id).to_string(),
            content: load_agent_prompt_file(id),
            path: path.to_string_lossy().into_owned(),
        });
    }
    Ok(entries)
}

/// 保存 Agent 角色提示词。
pub fn save_prompt(id: &str, content: &str) -> OmniResult<AgentPromptEntry> {
    let id = id.trim();
    if !is_known_agent_id(id) {
        return Err(omnipanel_error::OmniError::new(
            omnipanel_error::ErrorCode::InvalidInput,
            format!("未知 Agent 提示词: {id}"),
        ));
    }
    let path = agent_prompt_path(id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(map_io)?;
    }
    fs::write(&path, content).map_err(map_io)?;
    clear_prompt_cache();
    Ok(AgentPromptEntry {
        id: id.to_string(),
        content: content.to_string(),
        path: path.to_string_lossy().into_owned(),
    })
}

/// 恢复内置默认并写回磁盘。
pub fn reset_prompt(id: &str) -> OmniResult<AgentPromptEntry> {
    let id = id.trim();
    if !is_known_agent_id(id) {
        return Err(omnipanel_error::OmniError::new(
            omnipanel_error::ErrorCode::InvalidInput,
            format!("未知 Agent 提示词: {id}"),
        ));
    }
    save_prompt(id, default_agent_prompt(id))
}

/// 按 Agent id 读取角色提示词（运行时注入）。
pub fn agent_prompt(agent_id: &str) -> String {
    let id = agent_id.trim();
    if !is_known_agent_id(id) {
        return default_agent_prompt("plan").to_string();
    }
    load_agent_prompt_file(id)
}

/// ACP / HTTP 共用的工具路由片段。
pub fn routing_policy() -> &'static str {
    DEFAULT_ROUTING_POLICY
}

/// ACP Client Tools 协议层提示词。
pub fn system_prompt() -> String {
    load_system_prompt()
}

/// 兼容旧调用名。
pub fn client_tools_preamble() -> String {
    system_prompt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_non_empty() {
        assert!(!DEFAULT_SYSTEM_PROMPT.trim().is_empty());
        assert!(DEFAULT_SYSTEM_PROMPT.contains("OmniPanel Client Tool API"));
        assert!(DEFAULT_ROUTING_POLICY.contains("omni_terminal_exec"));
        assert!(DEFAULT_ROUTING_POLICY.contains("omni_ssh_exec"));
        assert!(!DEFAULT_SYSTEM_PROMPT.contains("omni_terminal_*"));
        for id in AGENT_PROMPT_IDS {
            assert!(!default_agent_prompt(id).trim().is_empty(), "{id}");
        }
    }

    #[test]
    fn ensure_and_load_roundtrip() {
        ensure_default_prompts().expect("seed prompts");
        let preamble = system_prompt();
        assert!(preamble.contains("tool_calls") || preamble.contains("OmniPanel"));
        let plan = default_agent_prompt("plan");
        assert!(plan.contains("omni_knowledge_create_document"));
        assert!(!plan.contains("最终交付物必须是一份待办清单"));
        assert!(plan.contains("执行计划") || plan.contains("计划助手") || plan.contains("Plan"));
        assert!(plan.contains("omni_terminal_exec"));
        assert!(!plan.contains("omni_terminal_run"));
        let terminal = default_agent_prompt("terminal");
        assert!(terminal.contains("服务与健康检查"));
        assert!(terminal.contains("资源占用"));
        assert!(terminal.contains("环境安装"));
        assert!(terminal.contains("omni_terminal_exec"));
        assert!(terminal.contains("omni_ssh_exec"));
        assert!(!terminal.contains("omni_terminal_run"));
        let run = default_agent_prompt("run");
        assert!(run.contains("执行助手") || run.contains("全部"));
        assert!(run.contains("omni_terminal_exec"));
        assert!(run.contains("omni_ssh_"));
        assert!(!run.contains("omni_terminal_run"));
        let list = list_prompt_entries().expect("list");
        assert_eq!(list.len(), AGENT_PROMPT_IDS.len());
        assert!(list.iter().any(|e| e.id == "terminal"));
        assert!(list.iter().any(|e| e.id == "run"));
    }

    #[test]
    fn rewrite_omni_terminal_refs_collapses_aliases() {
        let src = "可用：`omni_terminal_*`、`omni_ssh_*`；禁止：`omni_ssh_*`、`omni_terminal_*`、`omni_docker_*`；旧名 omni_terminal_run_terminal_command";
        let next = rewrite_omni_terminal_refs(src);
        assert!(next.contains("omni_terminal_exec"));
        assert!(!next.contains("omni_terminal_run_terminal_command"));
        assert!(!next.contains("`omni_terminal_*`"));
        assert!(next.contains("omni_ssh_*"));
        assert!(next.contains("omni_docker_*"));
    }
}
