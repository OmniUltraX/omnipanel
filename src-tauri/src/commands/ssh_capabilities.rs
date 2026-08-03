//! 远端工具能力统一治理：声明式 ToolManifest + 批量探测 + 统一安装编排。
//!
//! 设计目标：
//! - 一处声明所有"依赖远端第三方命令"的功能（tmux / my2sql / mysqldump / docker / 压缩工具 …），
//!   未来新增工具只改 [`TOOLS`] 一处。
//! - 一次 SSH exec 批量探测核心工具（合并大脚本，1 次 RTT），结果按主机缓存（TTL）。
//! - 统一安装入口 [`install_remote_tool`]，按 manifest 声明的 install_method 分发到
//!   包管理器安装 / 二进制下载 / 手动指引。
//!
//! 不破坏既有功能：各业务模块（binlog / archive / docker detect …）仍可走自己的内联检测，
//! 本模块的探测结果作为"展示与跳转"用，渐进迁移。

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::SshSession;
use serde::Serialize;
use specta::Type;
use tauri::State;
use tokio::sync::Mutex;

use crate::state::AppState;

use super::ssh::pool_session;

/// 能力缓存 TTL：探测结果在内存中保留 5 分钟。
/// 探测失败（连接错误）时由调用方决定是否短 TTL 重试，这里不区分成功/失败 TTL，
/// 保持简单——前端有"重新探测"按钮强制刷新。
const CAPABILITY_CACHE_TTL: Duration = Duration::from_secs(300);

/// 工具分类，前端按分类分组展示。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ToolCategory {
    /// 终端复用与持久会话。
    Terminal,
    /// 数据库客户端与工具。
    Database,
    /// 压缩与归档。
    Archive,
    /// 文件传输。
    Transfer,
    /// 系统监控与进程。
    Monitoring,
    /// 系统基础命令。
    System,
}

/// 工具状态。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToolState {
    /// 已就绪：二进制存在且（如有版本要求）版本达标。
    Ready {
        version: Option<String>,
        path: Option<String>,
    },
    /// 待安装：二进制缺失，但 manifest 声明了可自动安装的方式。
    NeedInstall,
    /// 版本过低：已安装但低于最低要求。
    TooOld {
        version: String,
        required: String,
    },
    /// 不支持：缺失且无法自动安装（仅展示手动指引）。
    Unsupported {
        reason: String,
    },
}

/// 安装方式声明。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InstallMethod {
    /// 无需安装或不可安装。
    #[allow(dead_code)]
    None,
    /// 系统包管理器安装（apt/dnf/yum/apk/pacman/zypper）。
    PackageManager {
        /// 按包管理器映射包名，未列出的包管理器无法安装。
        packages: HashMap<String, String>,
    },
    /// 本机下载二进制 + SFTP 上传。
    DownloadBinary {
        url: String,
        remote_path: String,
    },
    /// 在远端执行 shell 脚本安装（如从源码编译，绕过老系统仓库版本过低）。
    ShellScript {
        script: String,
    },
    /// 仅展示手动安装指引（无法自动安装）。
    Manual {
        instructions: String,
    },
}

/// 单个工具的声明式描述。
#[derive(Debug, Clone)]
pub struct ToolSpec {
    /// 唯一 id，如 "tmux" / "my2sql"。
    pub id: &'static str,
    /// 展示名 i18n key 后缀，前端拼 `ssh.capabilities.tools.{id}`。
    pub label_key: &'static str,
    pub category: ToolCategory,
    /// 最低版本要求（major, minor），None 表示不校验版本。
    pub min_version: Option<(u32, u32)>,
    /// 最低版本的可读字符串，用于 TooOld 提示。
    pub min_version_label: Option<&'static str>,
    /// 安装方式。
    pub install: InstallMethod,
    /// 相关模块路径，前端用于"跳转"按钮。如 "database.binlog"。
    pub related_modules: &'static [&'static str],
}

/// 批量探测后单个工具的结果。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteToolCapability {
    pub id: String,
    pub label_key: String,
    pub category: ToolCategory,
    pub state: ToolState,
    /// 安装方式（前端展示"一键安装"按钮用）。
    pub install_method: InstallMethod,
    pub related_modules: Vec<String>,
}

/// 一次探测的完整结果。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityProbeResult {
    pub resource_id: String,
    pub tools: Vec<RemoteToolCapability>,
    /// 探测耗时（毫秒）。
    pub elapsed_ms: u64,
    /// 探测时间戳（Unix 毫秒）。
    pub probed_at: i64,
    /// 批量脚本未覆盖、需单独探测的工具 id（前端可懒查）。
    pub lazy_probe_ids: Vec<String>,
}

/// 安装结果。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InstallToolResult {
    pub tool_id: String,
    pub installed: bool,
    /// 安装输出或失败原因。
    pub message: String,
    /// 安装后重新探测的状态（成功时为 Ready）。
    pub state: Option<ToolState>,
}

// ============================================================================
// ToolManifest：所有远端工具的声明式注册表
// ============================================================================

/// tmux 三段式降级安装脚本。
///
/// 降级链：包管理器 → snap → 源码编译 → 手动指引。
/// - 包管理器最快，但老系统仓库版本可能不够（Ubuntu 18.04 是 2.6 < 3.2）。
/// - snap 装的是最新版（3.6a），原生编译无兼容问题，但需要 snapd。
/// - 源码编译兜底：补全 bison 依赖，日志全程可见。
///
/// 关键设计：
/// - `as_root`：root 直接执行；非 root 走 `sudo -n`（免密）；否则明确报错。
/// - 编译输出写到日志文件，失败时 `cat` 全量输出到 stderr（不吞任何错误）。
/// - 版本检查用 `version_ok`：装完后验证是否 >= 3.2，不够则继续降级。
const TMUX_BUILD_SCRIPT: &str = r#"set -e
TMUX_VERSION="3.4"
LOG_FILE="/tmp/omnipanel-tmux-build.log"

# root 权限执行：root 直接跑，非 root 走 sudo -n（免密），否则报错。
as_root() {
    if [ "$(id -u)" = "0" ]; then
        "$@"
    elif sudo -n true 2>/dev/null; then
        sudo -n "$@"
    else
        echo "ERROR: 需要 root 权限执行 [$*]，但当前用户非 root 且 sudo 需要密码。" >&2
        echo "       请用 root 用户连接 SSH，或为当前用户配置 sudo 免密（NOPASSWD）。" >&2
        return 126
    fi
}

# 获取 tmux 版本号（检查所有可能的路径）
get_tmux_version() {
    PATH="/snap/bin:/usr/local/bin:$HOME/.omnipanel/bin:$PATH" tmux -V 2>/dev/null | grep -oE '[0-9]+\.[0-9]+[a-z]?' | head -1
}

# 版本是否 >= 3.2
version_ok() {
    local v="$1"
    local major="${v%%.*}"
    local rest="${v#*.}"
    local minor="${rest%%[a-z]*}"
    [ "$major" -gt 3 ] 2>/dev/null && return 0
    [ "$major" -eq 3 ] 2>/dev/null && [ "$minor" -ge 2 ] 2>/dev/null && return 0
    return 1
}

# ===== 第 1 步：包管理器 =====
try_package_manager() {
    echo ">>> [1/3] 尝试包管理器安装..."
    if command -v apt-get >/dev/null 2>&1; then
        as_root apt-get update -qq || true
        as_root apt-get install -y --no-install-recommends tmux || return 1
    elif command -v dnf >/dev/null 2>&1; then
        as_root dnf install -y tmux || return 1
    elif command -v yum >/dev/null 2>&1; then
        as_root yum install -y tmux || return 1
    elif command -v apk >/dev/null 2>&1; then
        as_root apk add --no-cache tmux || return 1
    elif command -v pacman >/dev/null 2>&1; then
        as_root pacman -Sy --noconfirm tmux || return 1
    elif command -v zypper >/dev/null 2>&1; then
        as_root zypper install -y tmux || return 1
    else
        echo "    不支持的包管理器"
        return 1
    fi
    local v
    v="$(get_tmux_version)"
    if [ -n "$v" ] && version_ok "$v"; then
        echo "    成功: tmux $v"
        return 0
    fi
    echo "    包管理器版本不够: ${v:-未安装}（需要 >= 3.2），继续降级"
    return 1
}

# ===== 第 2 步：snap =====
try_snap() {
    echo ">>> [2/3] 尝试 snap 安装..."
    if ! command -v snap >/dev/null 2>&1 && [ ! -x /usr/bin/snap ] && [ ! -x /snap/bin/snap ]; then
        echo "    snap 不可用，跳过"
        return 1
    fi
    if ! as_root snap install tmux --classic; then
        echo "    snap install 失败，继续降级"
        return 1
    fi
    local v
    v="$(get_tmux_version)"
    if [ -n "$v" ] && version_ok "$v"; then
        echo "    成功: tmux $v"
        return 0
    fi
    echo "    snap 安装后版本仍不够: ${v:-无}"
    return 1
}

# ===== 第 3 步：源码编译 =====
try_build_from_source() {
    echo ">>> [3/3] 尝试源码编译..."
    : > "$LOG_FILE"

    # 安装编译依赖（含 bison——tmux configure 需要 yacc）
    echo "    安装编译依赖（含 bison）..."
    if command -v apt-get >/dev/null 2>&1; then
        as_root apt-get update -qq >>"$LOG_FILE" 2>&1 || true
        as_root apt-get install -y --no-install-recommends gcc make autoconf automake pkg-config libevent-dev libncurses-dev bison >>"$LOG_FILE" 2>&1 || return 1
    elif command -v dnf >/dev/null 2>&1; then
        as_root dnf install -y gcc make autoconf automake pkg-config libevent-devel ncurses-devel bison >>"$LOG_FILE" 2>&1 || return 1
    elif command -v yum >/dev/null 2>&1; then
        as_root yum install -y gcc make autoconf automake pkg-config libevent-devel ncurses-devel bison >>"$LOG_FILE" 2>&1 || return 1
    elif command -v apk >/dev/null 2>&1; then
        as_root apk add --no-cache gcc make autoconf automake pkgconf libevent-dev ncurses-dev bison >>"$LOG_FILE" 2>&1 || return 1
    elif command -v pacman >/dev/null 2>&1; then
        as_root pacman -Sy --noconfirm gcc make autoconf automake pkgconf libevent ncurses bison >>"$LOG_FILE" 2>&1 || return 1
    elif command -v zypper >/dev/null 2>&1; then
        as_root zypper install -y gcc make autoconf automake pkg-config libevent-devel ncurses-devel bison >>"$LOG_FILE" 2>&1 || return 1
    else
        echo "    不支持的包管理器，无法安装编译依赖" >&2
        return 1
    fi

    # 下载源码（GitHub 直连 + 镜像兜底）
    echo "    下载 tmux ${TMUX_VERSION} 源码..."
    cd /tmp
    rm -rf "tmux-${TMUX_VERSION}" "tmux-${TMUX_VERSION}.tar.gz"
    URL="https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz"
    MIRRORS=("$URL" "https://ghfast.top/${URL}" "https://gh-proxy.com/${URL}")
    downloaded=0
    for u in "${MIRRORS[@]}"; do
        echo "      尝试: $u"
        if command -v curl >/dev/null 2>&1; then
            if curl -fsSL --connect-timeout 15 --max-time 120 "$u" -o "tmux-${TMUX_VERSION}.tar.gz"; then
                downloaded=1; break
            fi
        elif command -v wget >/dev/null 2>&1; then
            if wget -q --timeout=120 "$u" -O "tmux-${TMUX_VERSION}.tar.gz"; then
                downloaded=1; break
            fi
        else
            echo "    需要 curl 或 wget" >&2
            return 1
        fi
    done
    if [ "$downloaded" != "1" ]; then
        echo "    所有下载源均失败" >&2
        return 1
    fi
    tar xzf "tmux-${TMUX_VERSION}.tar.gz"

    # 编译安装（日志写文件，失败时 cat 全量输出——不吞任何错误）
    echo "    编译安装到 /usr/local ..."
    cd "/tmp/tmux-${TMUX_VERSION}"
    if ! ./configure --prefix=/usr/local >>"$LOG_FILE" 2>&1; then
        echo "    configure 失败，完整日志：" >&2
        cat "$LOG_FILE" >&2
        return 1
    fi
    if ! make -j"$(nproc 2>/dev/null || echo 2)" >>"$LOG_FILE" 2>&1; then
        echo "    make 失败，完整日志：" >&2
        cat "$LOG_FILE" >&2
        return 1
    fi
    if ! as_root make install >>"$LOG_FILE" 2>&1; then
        echo "    make install 失败，完整日志：" >&2
        cat "$LOG_FILE" >&2
        return 1
    fi

    # 验证
    local v
    v="$(get_tmux_version)"
    if [ -n "$v" ] && version_ok "$v"; then
        echo "    成功: tmux $v"
        return 0
    fi
    echo "    编译完成但版本异常: ${v:-无}" >&2
    return 1
}

# ===== 主流程：依次尝试三种方式 =====
try_package_manager && { rm -f "$LOG_FILE"; exit 0; }
try_snap && { rm -f "$LOG_FILE"; exit 0; }
try_build_from_source && { rm -f "$LOG_FILE"; exit 0; }

echo "ERROR: 所有自动安装方式均失败" >&2
echo "请手动安装 tmux >= 3.2：" >&2
echo "  Ubuntu/Debian: sudo snap install tmux --classic" >&2
echo "  或源码编译: wget https://github.com/tmux/tmux/releases/download/3.4/tmux-3.4.tar.gz && tar xzf tmux-3.4.tar.gz && cd tmux-3.4 && ./configure && make && sudo make install" >&2
rm -f "$LOG_FILE"
exit 1
"#;

/// 全局工具清单。新增工具只需在此追加一条。
///
/// 注意：`batch_probe_script` 只覆盖 `min_version` 不为 None 或常见工具，
/// 其余工具走 `lazy_probe_ids` 由前端按需单条探测。
pub static TOOLS: LazyLock<Vec<ToolSpec>> = LazyLock::new(|| vec![
    ToolSpec {
        id: "tmux",
        label_key: "tmux",
        category: ToolCategory::Terminal,
        min_version: Some((3, 2)),
        min_version_label: Some("3.2"),
        // 三段式降级：包管理器 → snap → 源码编译。
        // 覆盖所有场景：新系统走包管理器，Ubuntu 18.04 走 snap，CentOS 7/Alpine 走源码。
        install: InstallMethod::ShellScript {
            script: TMUX_BUILD_SCRIPT.to_string(),
        },
        related_modules: &["terminal"],
    },
    ToolSpec {
        id: "docker",
        label_key: "docker",
        category: ToolCategory::System,
        min_version: None,
        min_version_label: None,
        install: InstallMethod::Manual {
            instructions: "curl -fsSL https://get.docker.com | sh".to_string(),
        },
        related_modules: &["docker"],
    },
    // mysqldump / mysql / psql 已移除：
    // - MySQL/PostgreSQL 的 CLI tab 是客户端 sqlx 直连模拟提示符，不依赖远端 CLI
    // - 导入导出未来改造为客户端直连（纯 SQL / LOAD DATA），不依赖 mysqldump
    // - 在远端检测这些 CLI 属于多余：有数据库连接就够了，不需要服务器上的命令行客户端
    ToolSpec {
        id: "my2sql",
        label_key: "my2sql",
        category: ToolCategory::Database,
        min_version: None,
        min_version_label: None,
        install: InstallMethod::DownloadBinary {
            url: "https://raw.githubusercontent.com/liuhr/my2sql/master/releases/centOS_release_7.x/my2sql".to_string(),
            remote_path: "~/.omnipanel/bin/my2sql".to_string(),
        },
        related_modules: &["database.binlog"],
    },
    ToolSpec {
        id: "redis-cli",
        label_key: "redis-cli",
        category: ToolCategory::Database,
        min_version: None,
        min_version_label: None,
        install: InstallMethod::PackageManager {
            packages: [
                ("apt", "redis-tools"),
                ("dnf", "redis"),
                ("yum", "redis"),
                ("apk", "redis"),
                ("pacman", "redis"),
                ("zypper", "redis"),
            ]
            .iter()
            .cloned()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        },
        related_modules: &["database.cli"],
    },
    ToolSpec {
        id: "unzip",
        label_key: "unzip",
        category: ToolCategory::Archive,
        min_version: None,
        min_version_label: None,
        install: InstallMethod::PackageManager {
            packages: [
                ("apt", "unzip"),
                ("dnf", "unzip"),
                ("yum", "unzip"),
                ("apk", "unzip"),
                ("pacman", "unzip"),
                ("zypper", "unzip"),
            ]
            .iter()
            .cloned()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        },
        related_modules: &["files"],
    },
    ToolSpec {
        id: "tar",
        label_key: "tar",
        category: ToolCategory::Archive,
        min_version: None,
        min_version_label: None,
        install: InstallMethod::PackageManager {
            packages: [
                ("apt", "tar"),
                ("dnf", "tar"),
                ("yum", "tar"),
                ("apk", "tar"),
                ("pacman", "tar"),
                ("zypper", "tar"),
            ]
            .iter()
            .cloned()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        },
        related_modules: &["files"],
    },
    ToolSpec {
        id: "7z",
        label_key: "7z",
        category: ToolCategory::Archive,
        min_version: None,
        min_version_label: None,
        install: InstallMethod::PackageManager {
            packages: [
                ("apt", "p7zip-full"),
                ("dnf", "p7zip"),
                ("yum", "p7zip"),
                ("apk", "p7zip"),
                ("pacman", "p7zip"),
                ("zypper", "p7zip"),
            ]
            .iter()
            .cloned()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        },
        related_modules: &["files"],
    },
    ToolSpec {
        id: "unrar",
        label_key: "unrar",
        category: ToolCategory::Archive,
        min_version: None,
        min_version_label: None,
        install: InstallMethod::PackageManager {
            packages: [
                ("apt", "unrar"),
                ("dnf", "unrar"),
                ("yum", "unrar"),
                ("apk", "unrar"),
                ("pacman", "unrar"),
                ("zypper", "unrar"),
            ]
            .iter()
            .cloned()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        },
        related_modules: &["files"],
    },
    ToolSpec {
        id: "zstd",
        label_key: "zstd",
        category: ToolCategory::Archive,
        min_version: None,
        min_version_label: None,
        install: InstallMethod::PackageManager {
            packages: [
                ("apt", "zstd"),
                ("dnf", "zstd"),
                ("yum", "zstd"),
                ("apk", "zstd"),
                ("pacman", "zstd"),
                ("zypper", "zstd"),
            ]
            .iter()
            .cloned()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        },
        related_modules: &["files"],
    },
    ToolSpec {
        id: "rsync",
        label_key: "rsync",
        category: ToolCategory::Transfer,
        min_version: None,
        min_version_label: None,
        install: InstallMethod::PackageManager {
            packages: [
                ("apt", "rsync"),
                ("dnf", "rsync"),
                ("yum", "rsync"),
                ("apk", "rsync"),
                ("pacman", "rsync"),
                ("zypper", "rsync"),
            ]
            .iter()
            .cloned()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        },
        related_modules: &["files.transfer"],
    },
    ToolSpec {
        id: "jq",
        label_key: "jq",
        category: ToolCategory::System,
        min_version: None,
        min_version_label: None,
        install: InstallMethod::PackageManager {
            packages: [
                ("apt", "jq"),
                ("dnf", "jq"),
                ("yum", "jq"),
                ("apk", "jq"),
                ("pacman", "jq"),
                ("zypper", "jq"),
            ]
            .iter()
            .cloned()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        },
        related_modules: &[],
    },
    ToolSpec {
        id: "htop",
        label_key: "htop",
        category: ToolCategory::Monitoring,
        min_version: None,
        min_version_label: None,
        install: InstallMethod::PackageManager {
            packages: [
                ("apt", "htop"),
                ("dnf", "htop"),
                ("yum", "htop"),
                ("apk", "htop"),
                ("pacman", "htop"),
                ("zypper", "htop"),
            ]
            .iter()
            .cloned()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        },
        related_modules: &[],
    },
    ToolSpec {
        id: "nvidia-smi",
        label_key: "nvidia-smi",
        category: ToolCategory::Monitoring,
        min_version: None,
        min_version_label: None,
        install: InstallMethod::Manual {
            instructions: "安装 NVIDIA 驱动包（如 nvidia-driver / cuda-toolkit）".to_string(),
        },
        related_modules: &[],
    },
    ToolSpec {
        id: "ranger",
        label_key: "ranger",
        category: ToolCategory::System,
        min_version: None,
        min_version_label: None,
        install: InstallMethod::PackageManager {
            packages: [
                ("apt", "ranger"),
                ("dnf", "ranger"),
                ("yum", "ranger"),
                ("apk", "ranger"),
                ("pacman", "ranger"),
                ("zypper", "ranger"),
            ]
            .iter()
            .cloned()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        },
        related_modules: &[],
    },
]);

/// 查找工具声明。
pub fn find_tool_spec(id: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|t| t.id == id)
}

// ============================================================================
// 批量探测脚本
// ============================================================================

/// 构造一次性探测多个工具的 shell 脚本。
///
/// 输出格式：每个工具一段，以 `@TOOL:<id>` 起始行，后续行是该工具的探测输出。
/// 解析端按段切分。只覆盖"轻量命令"工具（command -v / -V / --version），
/// 避免把重型命令（nvidia-smi 查询 GPU）塞进批量脚本。
fn build_batch_probe_script() -> String {
    // 每个工具一段：@TOOL:<id>\n<probe output>\n@END:<id>
    let mut segments = Vec::new();
    for tool in TOOLS.iter() {
        // 跳过重型工具，走懒探测
        if matches!(tool.id, "nvidia-smi") {
            continue;
        }
        let seg = match tool.id {
            "tmux" => format!(
                r#"echo "@TOOL:tmux"
# 优先级：~/.omnipanel/bin > /snap/bin > /usr/local/bin > PATH
if [ -x "$HOME/.omnipanel/bin/tmux" ]; then
    echo "found:$HOME/.omnipanel/bin/tmux"
    "$HOME/.omnipanel/bin/tmux" -V 2>/dev/null || true
elif [ -x "/snap/bin/tmux" ]; then
    echo "found:/snap/bin/tmux"
    /snap/bin/tmux -V 2>/dev/null || true
elif [ -x "/usr/local/bin/tmux" ]; then
    echo "found:/usr/local/bin/tmux"
    /usr/local/bin/tmux -V 2>/dev/null || true
elif command -v tmux >/dev/null 2>&1; then
    echo "found:$(command -v tmux)"
    tmux -V 2>/dev/null || true
else
    echo "missing"
fi
echo "@END:tmux""#
            ),
            "docker" => format!(
                r#"echo "@TOOL:docker"
docker version --format '{{{{.Server.Version}}}}' 2>/dev/null || command -v docker >/dev/null 2>&1 && echo "found:$(command -v docker)" || echo "missing"
echo "@END:docker""#
            ),
            "my2sql" => format!(
                r#"echo "@TOOL:my2sql"
if [ -x "$HOME/.omnipanel/bin/my2sql" ]; then echo "found:$HOME/.omnipanel/bin/my2sql"
elif command -v my2sql >/dev/null 2>&1; then echo "found:$(command -v my2sql)"
else echo "missing"; fi
echo "@END:my2sql""#
            ),
            // 通用：command -v + --version
            id => {
                let version_cmd = match id {
                    "mysqldump" | "mysql" => format!("{id} --version"),
                    "psql" => "psql --version".to_string(),
                    "redis-cli" => "redis-cli --version".to_string(),
                    "7z" => "7z 2>/dev/null | head -2".to_string(),
                    "jq" => "jq --version".to_string(),
                    "htop" => "htop --version 2>/dev/null || command -v htop".to_string(),
                    "ranger" => "ranger --version 2>/dev/null".to_string(),
                    _ => format!("{id} --version 2>/dev/null || true"),
                };
                format!(
                    r#"echo "@TOOL:{id}"
command -v {id} >/dev/null 2>&1 && echo "found:$(command -v {id})" && ({version_cmd}) || echo "missing"
echo "@END:{id}""#
                )
            }
        };
        segments.push(seg);
    }
    segments.join("\n")
}

/// 解析批量脚本输出，按工具切分。
fn parse_batch_output(output: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut current_id: Option<String> = None;
    let mut buf = String::new();
    for line in output.lines() {
        if let Some(id) = line.strip_prefix("@TOOL:") {
            current_id = Some(id.trim().to_string());
            buf.clear();
        } else if let Some(id) = line.strip_prefix("@END:") {
            if let Some(cid) = current_id.take() {
                if cid == id.trim() {
                    map.insert(cid, buf.trim().to_string());
                }
            }
        } else if current_id.is_some() {
            if !buf.is_empty() {
                buf.push('\n');
            }
            buf.push_str(line);
        }
    }
    map
}

/// 从探测输出解析单个工具的状态。
fn parse_tool_state(spec: &ToolSpec, raw: &str) -> ToolState {
    if raw.is_empty() || raw == "missing" {
        // 缺失时按安装方式区分：可自动安装的标记 NeedInstall，否则 Unsupported
        return match &spec.install {
            InstallMethod::PackageManager { .. }
            | InstallMethod::DownloadBinary { .. }
            | InstallMethod::ShellScript { .. } => ToolState::NeedInstall,
            InstallMethod::Manual { .. } | InstallMethod::None => ToolState::Unsupported {
                reason: "not_installed".to_string(),
            },
        };
    }

    // 提取路径
    let path = raw
        .lines()
        .find_map(|l| l.strip_prefix("found:").map(|s| s.trim().to_string()));

    // 提取版本
    let version = raw
        .lines()
        .skip(1) // 跳过 found: 行
        .find(|l| !l.is_empty())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // tmux 特殊版本解析（tmux 3.6）
    let parsed_version = version.as_deref().and_then(|v| {
        if spec.id == "tmux" {
            v.strip_prefix("tmux ").map(|s| s.trim().to_string())
        } else {
            Some(v.to_string())
        }
    });

    // 版本下限校验
    if let (Some((min_major, min_minor)), Some(ver)) = (spec.min_version, &parsed_version) {
        if let Some((major, minor)) = parse_version_pair(ver) {
            if (major, minor) < (min_major, min_minor) {
                return ToolState::TooOld {
                    version: ver.clone(),
                    required: spec
                        .min_version_label
                        .unwrap_or(&format!("{}.{}", min_major, min_minor))
                        .to_string(),
                };
            }
        }
    }

    ToolState::Ready {
        version: parsed_version,
        path,
    }
}

/// 解析 "3.6" / "10.6.12" 这种版本号，取前两段。
fn parse_version_pair(s: &str) -> Option<(u32, u32)> {
    let s = s.trim().trim_start_matches('v');
    let mut parts = s.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next()?.parse::<u32>().ok().unwrap_or(0);
    Some((major, minor))
}

// ============================================================================
// 单条懒探测（重型工具）
// ============================================================================

/// 单独探测一个工具（批量脚本未覆盖的，如 nvidia-smi）。
async fn probe_single_tool(session: &SshSession, spec: &ToolSpec) -> ToolState {
    let cmd = match spec.id {
        "nvidia-smi" => "command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo missing",
        _ => return ToolState::Unsupported {
            reason: "no_probe".to_string(),
        },
    };
    match session.exec_capture(cmd).await {
        Ok(out) => {
            let raw = out.stdout.trim();
            if raw.is_empty() || raw == "missing" {
                // nvidia-smi 的 install 方式是 Manual，走 Unsupported
                ToolState::Unsupported {
                    reason: "not_installed".to_string(),
                }
            } else {
                ToolState::Ready {
                    version: None,
                    path: Some(format!("nvidia-smi: {}", raw.lines().next().unwrap_or(""))) ,
                }
            }
        }
        Err(_) => ToolState::Unsupported {
            reason: "probe_failed".to_string(),
        },
    }
}

// ============================================================================
// 能力缓存
// ============================================================================

#[derive(Clone)]
struct CachedProbe {
    result: CapabilityProbeResult,
    probed_at: Instant,
}

/// 按主机缓存的能力探测结果。
#[derive(Default)]
pub struct CapabilityCache {
    entries: Mutex<HashMap<String, CachedProbe>>,
}

impl CapabilityCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn get(&self, resource_id: &str) -> Option<CapabilityProbeResult> {
        let entries = self.entries.lock().await;
        let cached = entries.get(resource_id)?;
        if cached.probed_at.elapsed() > CAPABILITY_CACHE_TTL {
            return None;
        }
        Some(cached.result.clone())
    }

    pub async fn set(&self, resource_id: &str, result: CapabilityProbeResult) {
        let mut entries = self.entries.lock().await;
        entries.insert(
            resource_id.to_string(),
            CachedProbe {
                result: result.clone(),
                probed_at: Instant::now(),
            },
        );
    }

    pub async fn invalidate(&self, resource_id: &str) {
        self.entries.lock().await.remove(resource_id);
    }
}

// ============================================================================
// Tauri 命令
// ============================================================================

/// 探测远端主机的能力（批量脚本 + 懒探测标记）。
///
/// 返回缓存（若未过期），否则执行批量探测脚本。
/// `force` 为 true 时跳过缓存。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_probe_capabilities(
    state: State<'_, AppState>,
    resource_id: String,
    force: Option<bool>,
) -> Result<CapabilityProbeResult, OmniError> {
    if !force.unwrap_or(false) {
        if let Some(cached) = state.capability_cache.get(&resource_id).await {
            return Ok(cached);
        }
    }

    let session = pool_session(&state, &resource_id).await?;
    let start = Instant::now();

    let script = build_batch_probe_script();
    let output = session.exec_capture(&script).await?;
    let parsed = parse_batch_output(&output.stdout);

    let mut tools = Vec::with_capacity(TOOLS.len());
    let mut lazy_probe_ids = Vec::new();

    for spec in TOOLS.iter() {
        // 重型工具走懒探测标记
        if matches!(spec.id, "nvidia-smi") {
            lazy_probe_ids.push(spec.id.to_string());
            // 仍尝试探测一次，失败也不阻塞
            let state = probe_single_tool(&session, spec).await;
            tools.push(RemoteToolCapability {
                id: spec.id.to_string(),
                label_key: spec.label_key.to_string(),
                category: spec.category,
                state,
                install_method: spec.install.clone(),
                related_modules: spec.related_modules.iter().map(|s| s.to_string()).collect(),
            });
            continue;
        }

        let raw = parsed.get(spec.id).map(|s| s.as_str()).unwrap_or("missing");
        let state = parse_tool_state(spec, raw);
        tools.push(RemoteToolCapability {
            id: spec.id.to_string(),
            label_key: spec.label_key.to_string(),
            category: spec.category,
            state,
            install_method: spec.install.clone(),
            related_modules: spec.related_modules.iter().map(|s| s.to_string()).collect(),
        });
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let probed_at = chrono::Utc::now().timestamp_millis();

    let result = CapabilityProbeResult {
        resource_id: resource_id.clone(),
        tools,
        elapsed_ms,
        probed_at,
        lazy_probe_ids,
    };

    state
        .capability_cache
        .set(&resource_id, result.clone())
        .await;

    Ok(result)
}

/// 失效某主机的能力缓存（安装后或手动触发时调用）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_invalidate_capabilities(
    state: State<'_, AppState>,
    resource_id: String,
) -> Result<(), OmniError> {
    state.capability_cache.invalidate(&resource_id).await;
    // 联动清除 tmux unsupported 缓存：用户刷新能力探测通常是因为装/升了 tmux，
    // 不清则本进程内新 Tab 仍会因旧标记降级直连。
    state.tmux.invalidate_all().await;
    Ok(())
}

/// 统一安装远端工具。
///
/// 按 manifest 声明的 install_method 分发：
/// - `PackageManager`：检测包管理器后调 `ssh_pool_install_archive_tool` 的内部逻辑
/// - `DownloadBinary`：调 `ssh_pool_download_install_binary` 的内部逻辑
/// - `Manual`：返回安装指引文本
/// - `None`：不支持安装
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_install_tool(
    state: State<'_, AppState>,
    resource_id: String,
    tool_id: String,
) -> Result<InstallToolResult, OmniError> {
    let spec = find_tool_spec(&tool_id).ok_or_else(|| {
        OmniError::new(
            ErrorCode::InvalidInput,
            format!("未知工具 id: {tool_id}"),
        )
    })?;

    let session = pool_session(&state, &resource_id).await?;

    let (installed, message) = match &spec.install {
        InstallMethod::None => (false, "该工具不支持自动安装".to_string()),
        InstallMethod::Manual { instructions } => (
            false,
            format!("需手动安装：\n{instructions}"),
        ),
        InstallMethod::PackageManager { packages } => {
            install_via_package_manager(&session, spec.id, packages).await?
        }
        InstallMethod::DownloadBinary { url, remote_path } => {
            install_via_download_binary(&state, &resource_id, url, remote_path).await?
        }
        InstallMethod::ShellScript { script } => {
            install_via_shell_script(&session, spec.id, script).await?
        }
    };

    // 安装后重新探测该工具状态
    let new_state = if installed {
        // 失效缓存，重新探测单工具
        state.capability_cache.invalidate(&resource_id).await;
        // 若装的是 tmux，联动清除 tmux unsupported 缓存，让新 Tab 能走 control mode
        if spec.id == "tmux" {
            state.tmux.invalidate_all().await;
        }
        let probe_script = build_batch_probe_script();
        let output = session.exec_capture(&probe_script).await.ok();
        if let Some(out) = output {
            let parsed = parse_batch_output(&out.stdout);
            let raw = parsed.get(spec.id).map(|s| s.as_str()).unwrap_or("missing");
            Some(parse_tool_state(spec, raw))
        } else {
            None
        }
    } else {
        None
    };

    Ok(InstallToolResult {
        tool_id: tool_id.clone(),
        installed,
        message,
        state: new_state,
    })
}

/// 包管理器安装：复用 ssh.rs 的检测逻辑（这里内联一份，避免循环依赖）。
async fn install_via_package_manager(
    session: &Arc<SshSession>,
    tool_id: &str,
    packages: &HashMap<String, String>,
) -> Result<(bool, String), OmniError> {
    let detect_pm = r#"command -v apt-get >/dev/null 2>&1 && echo apt || \
(command -v dnf >/dev/null 2>&1 && echo dnf || \
(command -v yum >/dev/null 2>&1 && echo yum || \
(command -v apk >/dev/null 2>&1 && echo apk || \
(command -v pacman >/dev/null 2>&1 && echo pacman || \
(command -v zypper >/dev/null 2>&1 && echo zypper || \
echo UNKNOWN)))))"#;
    let pm_output = session.exec_capture(detect_pm).await?;
    let pm = pm_output.stdout.trim().to_string();
    if pm == "UNKNOWN" || pm.is_empty() {
        return Ok((
            false,
            "未检测到支持的包管理器（apt/dnf/yum/apk/pacman/zypper）".to_string(),
        ));
    }

    let pkg = packages.get(&pm).ok_or_else(|| {
        OmniError::new(
            ErrorCode::Internal,
            format!("包管理器 {pm} 无 {tool_id} 的包名映射"),
        )
    })?;

    let install_cmd = match pm.as_str() {
        "apt" => format!(
            "sudo -n apt-get install -y {pkg} 2>/dev/null || apt-get install -y {pkg} 2>&1"
        ),
        "dnf" => format!("sudo -n dnf install -y {pkg} 2>/dev/null || dnf install -y {pkg} 2>&1"),
        "yum" => format!("sudo -n yum install -y {pkg} 2>/dev/null || yum install -y {pkg} 2>&1"),
        "apk" => format!("apk add --no-progress {pkg} 2>&1 || sudo -n apk add --no-progress {pkg} 2>&1"),
        "pacman" => format!(
            "sudo -n pacman -S --noconfirm --needed {pkg} 2>/dev/null || pacman -S --noconfirm --needed {pkg} 2>&1"
        ),
        "zypper" => format!("sudo -n zypper -n install {pkg} 2>/dev/null || zypper -n install {pkg} 2>&1"),
        _ => {
            return Ok((false, format!("不支持的包管理器: {pm}")));
        }
    };

    let output = match tokio::time::timeout(Duration::from_secs(120), session.exec_capture(&install_cmd)).await {
        Ok(r) => r?,
        Err(_) => {
            return Ok((false, "安装超时（>120s）".to_string()));
        }
    };

    // 校验
    let verify_cmd = format!("command -v {tool_id} >/dev/null 2>&1 && echo OK || echo FAIL");
    let verify_output = session.exec_capture(&verify_cmd).await?;
    let installed = verify_output.stdout.trim() == "OK";

    let combined = if !output.stderr.trim().is_empty() {
        format!("{}\n{}", output.stdout.trim(), output.stderr.trim())
    } else {
        output.stdout.trim().to_string()
    };
    let message = if installed {
        if combined.is_empty() {
            format!("已安装 {pkg}（{pm}）")
        } else {
            format!("已安装 {pkg}（{pm}）\n{}", combined.chars().take(500).collect::<String>())
        }
    } else if combined.is_empty() {
        format!("安装失败（{pm} install {pkg}）")
    } else {
        combined.chars().take(500).collect()
    };

    Ok((installed, message))
}

/// 二进制下载安装：复用 ssh.rs 的 download_install_binary_inner。
///
/// URL 白名单校验——这里把白名单扩成"manifest 声明的 URL 集合"，
/// 即只允许 manifest 中 DownloadBinary 声明的 URL。
async fn install_via_download_binary(
    state: &AppState,
    resource_id: &str,
    url: &str,
    remote_path: &str,
) -> Result<(bool, String), OmniError> {
    // 白名单：必须是 manifest 中声明的 URL
    let allowed = TOOLS.iter().any(|t| match &t.install {
        InstallMethod::DownloadBinary { url: u, .. } => u == url,
        _ => false,
    });
    if !allowed {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "该 URL 未在工具清单中声明，不允许下载",
        ));
    }

    let abs_path = super::ssh::download_install_binary_inner(
        state,
        resource_id,
        url,
        remote_path,
        false, // 已由上面的 manifest 白名单校验
    )
    .await?;

    Ok((true, format!("已安装到 {abs_path}")))
}

/// 在远端执行 shell 脚本安装工具（如从源码编译 tmux，绕过老系统仓库版本过低）。
///
/// 实现：用单引号 here-doc 把脚本写到 `/tmp/omnipanel-install-<tool>.sh`（单引号定界
/// 符防 `$`/反引号被远端 shell 展开），chmod 后用 `bash` 执行。源码编译耗时较长，给
/// 10 分钟超时；结束后清理临时文件。
async fn install_via_shell_script(
    session: &Arc<SshSession>,
    tool_id: &str,
    script: &str,
) -> Result<(bool, String), OmniError> {
    const SCRIPT_TIMEOUT: Duration = Duration::from_secs(600);
    // 一个不会出现在脚本里的定界符；单引号包裹防止远端 shell 展开 $ 和反引号。
    const DELIMITER: &str = "OMNIPANEL_INSTALL_SCRIPT_EOF_9f2c";

    let remote_script = format!("/tmp/omnipanel-install-{tool_id}.sh");
    let write_cmd = format!(
        "cat <<'{delimiter}' > '{path}' && chmod +x '{path}'\n{script}\n{delimiter}",
        delimiter = DELIMITER,
        path = remote_script,
        script = script,
    );

    let write_out = session.exec_capture(&write_cmd).await?;
    if write_out.exit_code != 0 {
        return Ok((
            false,
            format!(
                "写入安装脚本失败 (exit {}):\n{}",
                write_out.exit_code,
                write_out.stderr.trim()
            ),
        ));
    }

    // 用 bash 显式执行，避免远端默认 shell（如 sh/dash）对脚本语法兼容性问题。
    let run_cmd = format!("bash '{}'", remote_script);
    let run_result = tokio::time::timeout(SCRIPT_TIMEOUT, session.exec_capture(&run_cmd)).await;

    // 无论成功失败都清理临时文件
    let _ = session
        .exec_capture(&format!("rm -f '{}'", remote_script))
        .await;

    let output = match run_result {
        Ok(r) => r?,
        Err(_) => {
            return Ok((false, format!("安装超时（>{}s）", SCRIPT_TIMEOUT.as_secs())));
        }
    };

    let installed = output.exit_code == 0;
    let message = if installed {
        let stdout = output.stdout.trim();
        if stdout.is_empty() {
            "安装成功".to_string()
        } else {
            stdout.chars().take(1000).collect()
        }
    } else {
        format!(
            "安装失败 (exit {}):\n--- stdout ---\n{}\n--- stderr ---\n{}",
            output.exit_code,
            output.stdout.trim(),
            output.stderr.trim()
        )
        .chars()
        .take(1500)
        .collect()
    };

    Ok((installed, message))
}

// ============================================================================
// 面板探测（宝塔 / 1Panel）：独立于 ToolManifest，返回结构化结果
// ============================================================================

/// 单个面板的探测结果。
///
/// `api_key` 字段仅当面板 API 已开启且能从配置文件读到时才非空。
/// 该字段属于敏感凭据，前端拿到后应直接写入 Vault，不应日志输出或传给 AI。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PanelProbeItem {
    /// 面板类型：bt（宝塔） / 1panel
    pub kind: String,
    /// 是否已安装
    pub installed: bool,
    /// 面板访问地址（含协议和端口，如 http://192.168.1.10:8888）；未安装时为空
    pub address: String,
    /// 面板端口；未安装时为 0
    pub port: u16,
    /// 1Panel 安全入口（如 /abc123）；宝塔无此概念时为空
    pub entrance: String,
    /// API 是否已开启
    pub api_enabled: bool,
    /// 从面板配置文件读到的 API Key（仅当 api_enabled=true 且能读到时）；
    /// 读不到时为空字符串。敏感字段，前端不得传给 AI 或日志输出。
    pub api_key: String,
    /// 额外提示信息（如版本号、读取失败原因等）
    pub note: String,
}

/// 面板探测完整结果。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PanelProbeResult {
    pub resource_id: String,
    pub panels: Vec<PanelProbeItem>,
    /// 探测耗时（毫秒）
    pub elapsed_ms: u64,
    /// 探测时间戳（Unix 毫秒）
    pub probed_at: i64,
}

/// 一次 SSH exec 同时探测宝塔和 1Panel 面板。
///
/// 输出格式（每个面板一段）：
/// ```text
/// @PANEL:bt
/// installed:1
/// port:8888
/// address:http://127.0.0.1:8888
/// api_enabled:1
/// api_key:xxxxxx
/// note:v7.9.0
/// @ENDPANEL:bt
/// @PANEL:1panel
/// installed:0
/// @ENDPANEL:1panel
/// ```
///
/// 设计要点：
/// - 一次 RTT 同时探测两类面板，降低延迟
/// - 宝塔：检查 `/www/server/panel` 目录 + `data/default.db` 或 `data/api.json`
/// - 1Panel：检查 `/opt/1panel` 目录 + `db/1panel.db` 或 `conf/app.yaml`
/// - api_key 仅在 API 已开启时尝试读取，读不到不报错（返回空串）
/// - 非 root 用户可能无权读面板配置文件，此时 api_key 为空但 installed 仍为 true
fn build_panel_probe_script() -> String {
    r#"#!/bin/bash
set +e

# ===== 宝塔面板 =====
probe_bt() {
    echo "@PANEL:bt"
    if [ ! -d /www/server/panel ]; then
        echo "installed:0"
        echo "@ENDPANEL:bt"
        return
    fi
    echo "installed:1"

    # 端口：优先 port.pl，回退 8888
    port=""
    if [ -f /www/server/panel/data/port.pl ]; then
        port=$(cat /www/server/panel/data/port.pl 2>/dev/null | tr -dc '0-9')
    fi
    [ -z "$port" ] && port=8888
    echo "port:$port"

    # 协议：ssl.pl 存在则 https
    proto="http"
    [ -f /www/server/panel/data/ssl.pl ] && proto="https"
    echo "address:${proto}://127.0.0.1:${port}"

    # 版本
    version=""
    if [ -f /www/server/panel/config/config.json ]; then
        version=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]*"' /www/server/panel/config/config.json 2>/dev/null | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"//;s/"//')
    fi

    # API 状态与 key
    api_enabled=0
    api_key=""
    # 新版（v7+）：default.db 的 config 表
    if command -v sqlite3 >/dev/null 2>&1 && [ -f /www/server/panel/data/default.db ]; then
        api_open=$(sqlite3 /www/server/panel/data/default.db "SELECT value FROM config WHERE key='api_open'" 2>/dev/null | head -1)
        if [ "$api_open" = "1" ] || [ "$api_open" = "true" ]; then
            api_enabled=1
            api_key=$(sqlite3 /www/server/panel/data/default.db "SELECT value FROM config WHERE key='api_sk'" 2>/dev/null | head -1)
        fi
    fi
    # 旧版（5.x）：data/api.json
    if [ "$api_enabled" = "0" ] && [ -f /www/server/panel/data/api.json ]; then
        api_open=$(grep -oE '"open"[[:space:]]*:[[:space:]]*[^,}]*' /www/server/panel/data/api.json 2>/dev/null | head -1)
        case "$api_open" in
            *true*|*1*) api_enabled=1 ;;
        esac
        if [ "$api_enabled" = "1" ]; then
            # 旧版字段为 secret
            api_key=$(grep -oE '"secret"[[:space:]]*:[[:space:]]*"[^"]*"' /www/server/panel/data/api.json 2>/dev/null | head -1 | sed 's/.*"secret"[[:space:]]*:[[:space:]]*"//;s/"//')
            [ -z "$api_key" ] && api_key=$(grep -oE '"key"[[:space:]]*:[[:space:]]*"[^"]*"' /www/server/panel/data/api.json 2>/dev/null | head -1 | sed 's/.*"key"[[:space:]]*:[[:space:]]*"//;s/"//')
        fi
    fi

    echo "api_enabled:$api_enabled"
    # api_key 可能含特殊字符，用 base64 包裹避免污染分段协议
    if [ -n "$api_key" ]; then
        echo "api_key:$(printf '%s' "$api_key" | base64 2>/dev/null || echo '')"
    else
        echo "api_key:"
    fi
    echo "note:${version}"
    echo "@ENDPANEL:bt"
}

# ===== 1Panel =====
probe_1panel() {
    echo "@PANEL:1panel"
    # v1: /opt/1panel  v2: /opt/1panel  数据目录可能在 /opt/1panel 或 /var/lib/1panel
    panel_dir=""
    for d in /opt/1panel /usr/local/1panel; do
        if [ -d "$d" ]; then panel_dir="$d"; break; fi
    done
    if [ -z "$panel_dir" ]; then
        echo "installed:0"
        echo "@ENDPANEL:1panel"
        return
    fi
    echo "installed:1"

    # 端口与安全入口：从 app.yaml 读
    port=""
    entrance=""
    entrance_path=""
    # app.yaml 可能位置
    for f in "$panel_dir/conf/app.yaml" "$panel_dir/app.yaml" /etc/1panel/app.yaml; do
        if [ -f "$f" ]; then entrance_path="$f"; break; fi
    done
    if [ -n "$entrance_path" ]; then
        port=$(grep -E '^[[:space:]]*port:' "$entrance_path" 2>/dev/null | head -1 | sed 's/.*port:[[:space:]]*//;s/#.*//;s/[[:space:]]*$//;s/"//g' | tr -dc '0-9')
        entrance=$(grep -E '^[[:space:]]*entrance:' "$entrance_path" 2>/dev/null | head -1 | sed 's/.*entrance:[[:space:]]*//;s/#.*//;s/[[:space:]]*$//;s/"//g')
        [ -z "$port" ] && port=$(grep -E '^[[:space:]]*port[[:space:]]*=' "$entrance_path" 2>/dev/null | head -1 | sed 's/.*port[[:space:]]*=[[:space:]]*//;s/#.*//;s/[[:space:]]*$//;s/"//g' | tr -dc '0-9')
    fi
    [ -z "$port" ] && port=10086
    echo "port:$port"

    proto="http"
    # 1panel 默认 https（9443/10086 通常配 ssl）
    if grep -qE '^[[:space:]]*(ssl|https)[[:space:]]*:' "$entrance_path" 2>/dev/null; then
        proto="https"
    fi
    echo "address:${proto}://127.0.0.1:${port}"
    [ -n "$entrance" ] && echo "entrance:/${entrance}"

    # API key：1panel v1/v2 存在 sqlite settings 表，字段 key='ServerKey' 或类似
    # 也可能从 1pctl 命令读取，但 1pctl 不暴露 api key，只能读数据库
    api_enabled=0
    api_key=""
    db_path=""
    for db in "$panel_dir/db/1panel.db" /var/lib/1panel/db/1panel.db /opt/1panel/db/1Panel.db; do
        if [ -f "$db" ]; then db_path="$db"; break; fi
    done
    if [ -n "$db_path" ] && command -v sqlite3 >/dev/null 2>&1; then
        # 1Panel 的 API key 在 settings 表，key 名为 'ServerKey' 或类似
        # 尝试多种可能的 key 名
        for k in ServerKey ApiKey PanelKey api_key server_key; do
            val=$(sqlite3 "$db_path" "SELECT value FROM settings WHERE key='$k'" 2>/dev/null | head -1)
            if [ -n "$val" ]; then
                api_key="$val"
                api_enabled=1
                break
            fi
        done
    fi

    echo "api_enabled:$api_enabled"
    if [ -n "$api_key" ]; then
        echo "api_key:$(printf '%s' "$api_key" | base64 2>/dev/null || echo '')"
    else
        echo "api_key:"
    fi
    version=""
    if command -v 1pctl >/dev/null 2>&1; then
        version=$(1pctl version 2>/dev/null | head -1)
    fi
    echo "note:${version}"
    echo "@ENDPANEL:1panel"
}

probe_bt
probe_1panel
"#.to_string()
}

/// 解析面板探测输出。
fn parse_panel_probe_output(output: &str) -> Vec<PanelProbeItem> {
    let mut panels = Vec::new();
    let mut current_kind: Option<String> = None;
    let mut fields: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for line in output.lines() {
        if let Some(kind) = line.strip_prefix("@PANEL:") {
            current_kind = Some(kind.trim().to_string());
            fields.clear();
        } else if let Some(kind) = line.strip_prefix("@ENDPANEL:") {
            if let Some(k) = current_kind.take() {
                if k == kind.trim() {
                    let installed = fields.get("installed").map(|v| v == "1").unwrap_or(false);
                    let port: u16 = fields
                        .get("port")
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0);
                    let address = fields.get("address").cloned().unwrap_or_default();
                    let entrance = fields.get("entrance").cloned().unwrap_or_default();
                    let api_enabled = fields.get("api_enabled").map(|v| v == "1").unwrap_or(false);
                    // api_key 是 base64 编码的，需解码
                    let api_key_b64 = fields.get("api_key").map(|v| v.as_str()).unwrap_or("");
                    let api_key = if api_key_b64.is_empty() {
                        String::new()
                    } else {
                        use base64::Engine;
                        base64::engine::general_purpose::STANDARD
                            .decode(api_key_b64)
                            .ok()
                            .and_then(|bytes| String::from_utf8(bytes).ok())
                            .unwrap_or_default()
                    };
                    let note = fields.get("note").cloned().unwrap_or_default();
                    panels.push(PanelProbeItem {
                        kind: k,
                        installed,
                        address,
                        port,
                        entrance,
                        api_enabled,
                        api_key,
                        note,
                    });
                }
            }
        } else if current_kind.is_some() {
            if let Some(idx) = line.find(':') {
                let key = line[..idx].trim().to_string();
                let value = line[idx + 1..].to_string();
                fields.insert(key, value);
            }
        }
    }
    panels
}

/// 探测远端主机上已安装的面板（宝塔 / 1Panel）。
///
/// 返回每个面板的安装状态、访问地址、端口、安全入口、API 开启状态及（如能读到的）API Key。
/// API Key 属敏感凭据，前端应直接写入 Vault，不得传给 AI 或日志输出。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_probe_panels(
    state: State<'_, AppState>,
    resource_id: String,
) -> Result<PanelProbeResult, OmniError> {
    let session = pool_session(&state, &resource_id).await?;
    let start = Instant::now();

    let script = build_panel_probe_script();
    let output = session.exec_capture(&script).await?;
    let panels = parse_panel_probe_output(&output.stdout);

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let probed_at = chrono::Utc::now().timestamp_millis();

    Ok(PanelProbeResult {
        resource_id,
        panels,
        elapsed_ms,
        probed_at,
    })
}

// ============================================================================
// 辅助：AppState 需要 capability_cache 字段
// ============================================================================
