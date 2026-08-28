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
use serde::Serialize;
use specta::Type;
use tokio::sync::Mutex;

use crate::{SshSession, shell_single_quote};

fn unix_timestamp_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

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
    TooOld { version: String, required: String },
    /// 不支持：缺失且无法自动安装（仅展示手动指引）。
    Unsupported { reason: String },
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
    DownloadBinary { url: String, remote_path: String },
    /// 在远端执行 shell 脚本安装（如从源码编译，绕过老系统仓库版本过低）。
    ShellScript { script: String },
    /// 仅展示手动安装指引（无法自动安装）。
    Manual { instructions: String },
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
pub static TOOLS: LazyLock<Vec<ToolSpec>> = LazyLock::new(|| {
    vec![
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
    ToolSpec {
        id: "nginx",
        label_key: "nginx",
        category: ToolCategory::System,
        min_version: None,
        min_version_label: None,
        install: InstallMethod::PackageManager {
            packages: [
                ("apt", "nginx"),
                ("dnf", "nginx"),
                ("yum", "nginx"),
                ("apk", "nginx"),
                ("pacman", "nginx"),
                ("zypper", "nginx"),
            ]
            .iter()
            .cloned()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        },
        related_modules: &[],
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
]
});

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
            "nginx" => format!(
                r#"echo "@TOOL:nginx"
if command -v openresty >/dev/null 2>&1; then
    echo "found:$(command -v openresty)"
    openresty -v 2>&1 | head -1 || true
elif [ -x /usr/local/openresty/nginx/sbin/nginx ]; then
    echo "found:/usr/local/openresty/nginx/sbin/nginx"
    /usr/local/openresty/nginx/sbin/nginx -v 2>&1 | head -1 || true
elif command -v nginx >/dev/null 2>&1; then
    echo "found:$(command -v nginx)"
    nginx -v 2>&1 | head -1 || true
else
    echo "missing"
fi
echo "@END:nginx""#
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
        } else if spec.id == "nginx" {
            Some(
                v.strip_prefix("nginx version:")
                    .unwrap_or(v)
                    .trim()
                    .to_string(),
            )
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
        "nvidia-smi" => {
            "command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo missing"
        }
        _ => {
            return ToolState::Unsupported {
                reason: "no_probe".to_string(),
            };
        }
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
                    path: Some(format!("nvidia-smi: {}", raw.lines().next().unwrap_or(""))),
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
// 公共 API（桌面 / Server 共用）
// ============================================================================

/// 探测远端主机的能力（批量脚本 + 懒探测标记）。
pub async fn probe_capabilities(
    session: &SshSession,
    resource_id: &str,
) -> Result<CapabilityProbeResult, OmniError> {
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
            let state = probe_single_tool(session, spec).await;
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
    let probed_at = unix_timestamp_millis();

    Ok(CapabilityProbeResult {
        resource_id: resource_id.to_string(),
        tools,
        elapsed_ms,
        probed_at,
        lazy_probe_ids,
    })
}

/// 统一安装远端工具（不含缓存失效；由调用方处理）。
pub async fn install_remote_tool(
    session: &Arc<SshSession>,
    tool_id: &str,
) -> Result<InstallToolResult, OmniError> {
    let spec = find_tool_spec(tool_id).ok_or_else(|| {
        OmniError::new(ErrorCode::InvalidInput, format!("未知工具 id: {tool_id}"))
    })?;

    let (installed, message) = match &spec.install {
        InstallMethod::None => (false, "该工具不支持自动安装".to_string()),
        InstallMethod::Manual { instructions } => (false, format!("需手动安装：\n{instructions}")),
        InstallMethod::PackageManager { packages } => {
            install_via_package_manager(session, spec.id, packages).await?
        }
        InstallMethod::DownloadBinary { url, remote_path } => {
            install_via_download_binary(session, url, remote_path).await?
        }
        InstallMethod::ShellScript { script } => {
            install_via_shell_script(session, spec.id, script).await?
        }
    };

    // 安装后重新探测该工具状态
    let new_state = if installed {
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
        tool_id: tool_id.to_string(),
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
        "apt" => {
            format!("sudo -n apt-get install -y {pkg} 2>/dev/null || apt-get install -y {pkg} 2>&1")
        }
        "dnf" => format!("sudo -n dnf install -y {pkg} 2>/dev/null || dnf install -y {pkg} 2>&1"),
        "yum" => format!("sudo -n yum install -y {pkg} 2>/dev/null || yum install -y {pkg} 2>&1"),
        "apk" => {
            format!("apk add --no-progress {pkg} 2>&1 || sudo -n apk add --no-progress {pkg} 2>&1")
        }
        "pacman" => format!(
            "sudo -n pacman -S --noconfirm --needed {pkg} 2>/dev/null || pacman -S --noconfirm --needed {pkg} 2>&1"
        ),
        "zypper" => {
            format!("sudo -n zypper -n install {pkg} 2>/dev/null || zypper -n install {pkg} 2>&1")
        }
        _ => {
            return Ok((false, format!("不支持的包管理器: {pm}")));
        }
    };

    let output =
        match tokio::time::timeout(Duration::from_secs(120), session.exec_capture(&install_cmd))
            .await
        {
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
            format!(
                "已安装 {pkg}（{pm}）\n{}",
                combined.chars().take(500).collect::<String>()
            )
        }
    } else if combined.is_empty() {
        format!("安装失败（{pm} install {pkg}）")
    } else {
        combined.chars().take(500).collect()
    };

    Ok((installed, message))
}

/// 二进制下载安装：本机 reqwest 下载 + SFTP 上传。
///
/// URL 白名单：仅允许 manifest 中 DownloadBinary 声明的 URL。
async fn install_via_download_binary(
    session: &Arc<SshSession>,
    url: &str,
    remote_path: &str,
) -> Result<(bool, String), OmniError> {
    if !is_manifest_download_url(url) {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "该 URL 未在工具清单中声明，不允许下载",
        ));
    }

    let abs_path = download_install_binary(session, url, remote_path).await?;

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
/// 探测安装状态、访问地址、安全入口；`api_key` 仅供「一键管理」表单预填，卡片不展示。
/// 开启 API 仍走独立命令 `ssh_pool_enable_panel_api`（例如从 SSH 导入 Docker 时）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PanelProbeItem {
    /// 面板类型：bt（宝塔） / 1panel
    pub kind: String,
    /// 是否已安装
    pub installed: bool,
    /// 面板 API origin（含协议和端口，如 http://192.168.1.10:8888，不含安全入口）；未安装时为空
    pub address: String,
    /// 面板端口；未安装时为 0
    pub port: u16,
    /// 安全入口路径（宝塔 admin_path / 1Panel SecurityEntrance），如 /baota
    pub entrance: String,
    /// API 是否已开启（探测自配置文件；卡片不展示）
    pub api_enabled: bool,
    /// 从面板配置读到的 API Key（表单预填用）；卡片不展示。敏感字段，前端不得传给 AI 或日志输出。
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
/// entrance:/baota
/// api_enabled:1
/// api_key:<base64>
/// note:v11.7.0
/// @ENDPANEL:bt
/// ```
///
/// 设计要点：
/// - 一次 RTT 同时探测两类面板，降低延迟
/// - 宝塔：`/www/server/panel` + `config/api.json`（含 open/key）+ `data/admin_path.pl`
/// - 1Panel：优先 `1pctl user-info` 解析真实端口/入口（例：`http://$LOCAL_IP:7777/777777`）
/// - 1Panel 次要：core.db 端口 / 入口 / SSL / 版本 / ApiKey；v1 回退 app.yaml；禁止静默默认 10086
/// - api_key 有则读取，供「一键管理」表单预填；卡片不展示
/// - 非 root 可能读不到配置：installed 仍可为 true，api_key 为空
fn build_panel_probe_script() -> String {
    r#"#!/bin/bash
set +e

b64() {
    if [ -n "$1" ]; then
        printf '%s' "$1" | base64 2>/dev/null | tr -d '\n'
    fi
}

# 从简单 JSON 抽 "key":"value"（不依赖 jq/python）
json_str() {
    # $1=file $2=field
    grep -oE "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$1" 2>/dev/null | head -1 \
        | sed "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"//;s/\"[[:space:]]*$//"
}

json_bool_true() {
    # $1=file $2=field → 0/1
    local line
    line=$(grep -oE "\"$2\"[[:space:]]*:[[:space:]]*(true|false|1|0)" "$1" 2>/dev/null | head -1)
    case "$line" in
        *true*|*:1) echo 1 ;;
        *) echo 0 ;;
    esac
}

# ===== 宝塔面板 =====
probe_bt() {
    echo "@PANEL:bt"
    if [ ! -d /www/server/panel ]; then
        echo "installed:0"
        echo "@ENDPANEL:bt"
        return
    fi
    echo "installed:1"

    port=""
    if [ -f /www/server/panel/data/port.pl ]; then
        port=$(tr -dc '0-9' < /www/server/panel/data/port.pl 2>/dev/null)
    fi
    [ -z "$port" ] && port=8888
    echo "port:$port"

    proto="http"
    [ -f /www/server/panel/data/ssl.pl ] && proto="https"
    echo "address:${proto}://127.0.0.1:${port}"

    # 安全入口（后台路径），如 /baota
    if [ -f /www/server/panel/data/admin_path.pl ]; then
        ap=$(tr -d '\r\n' < /www/server/panel/data/admin_path.pl 2>/dev/null)
        case "$ap" in
            /*) echo "entrance:$ap" ;;
            "") ;;
            *) echo "entrance:/$ap" ;;
        esac
    fi

    version=""
    # common.py: g.version = '11.7.0'
    if [ -f /www/server/panel/class/common.py ]; then
        version=$(grep -oE "version *= *'[0-9.]+'" /www/server/panel/class/common.py 2>/dev/null | head -1 | tr -dc '0-9.')
    fi
    if [ -z "$version" ] && [ -f /www/server/panel/data/version.pl ]; then
        version=$(tr -dc '0-9.' < /www/server/panel/data/version.pl 2>/dev/null)
    fi
    # 仅接受数字版本，过滤噪声
    case "$version" in
        [0-9]*.*) ;;
        *) version="" ;;
    esac

    api_enabled=0
    api_key=""
    api_file=""
    for f in /www/server/panel/config/api.json /www/server/panel/data/api.json; do
        if [ -f "$f" ]; then api_file="$f"; break; fi
    done
    if [ -n "$api_file" ]; then
        api_enabled=$(json_bool_true "$api_file" open)
        # 仅读 key：token 是 md5(key)，不能当作 API 密钥回填
        api_key=$(json_str "$api_file" key)
        [ -z "$api_key" ] && api_key=$(json_str "$api_file" secret)
    fi

    echo "api_enabled:$api_enabled"
    echo "api_key:$(b64 "$api_key")"
    echo "note:${version}"
    echo "@ENDPANEL:bt"
}

# ===== 1Panel =====
probe_1panel() {
    echo "@PANEL:1panel"
    panel_dir=""
    for d in /opt/1panel /usr/local/1panel /var/lib/1panel; do
        if [ -d "$d" ]; then panel_dir="$d"; break; fi
    done
    if [ -z "$panel_dir" ] && { command -v 1pctl >/dev/null 2>&1 || [ -d /etc/1panel ]; }; then
        panel_dir="/opt/1panel"
    fi
    if [ -z "$panel_dir" ] || { [ ! -d "$panel_dir" ] && ! command -v 1pctl >/dev/null 2>&1; }; then
        echo "installed:0"
        echo "@ENDPANEL:1panel"
        return
    fi
    echo "installed:1"

    port=""
    entrance=""
    api_enabled=0
    api_key=""
    api_status=""
    version=""
    proto="http"

    # ★ 权威来源：1pctl user-info（与面板实际监听一致，勿猜默认 10086）
    # 示例：面板地址: http://$LOCAL_IP:7777/777777
    if command -v 1pctl >/dev/null 2>&1; then
        ui=$(1pctl user-info 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g')
        addr_line=$(printf '%s\n' "$ui" | grep -E '面板地址|Panel address' | head -1)
        panel_url=$(printf '%s\n' "$addr_line" | grep -oE 'https?://[^[:space:]]+' | head -1)
        if [ -n "$panel_url" ]; then
            case "$panel_url" in
                https://*) proto="https" ;;
                http://*) proto="http" ;;
            esac
            # 取 host:port/path 段
            rest=${panel_url#*://}
            hostport=${rest%%/*}
            path_part=${rest#"$hostport"}
            case "$hostport" in
                *:*)
                    ui_port=${hostport##*:}
                    ui_port=$(printf '%s' "$ui_port" | tr -dc '0-9')
                    [ -n "$ui_port" ] && port="$ui_port"
                    ;;
            esac
            if [ -n "$path_part" ] && [ "$path_part" != "/" ]; then
                entrance=$(printf '%s' "$path_part" | sed 's#^/##;s#/.*##')
            fi
        fi
        # 1pctl 脚本里的 ORIGINAL_PORT 作补充（user-info 未解析出端口时）
        if [ -z "$port" ]; then
            for ctl in "$(command -v 1pctl 2>/dev/null)" /usr/bin/1pctl /usr/local/bin/1pctl; do
                [ -n "$ctl" ] && [ -f "$ctl" ] || continue
                op=$(grep -E '^ORIGINAL_PORT=' "$ctl" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -dc '0-9')
                [ -n "$op" ] && port="$op" && break
            done
        fi
        if [ -z "$entrance" ]; then
            for ctl in "$(command -v 1pctl 2>/dev/null)" /usr/bin/1pctl /usr/local/bin/1pctl; do
                [ -n "$ctl" ] && [ -f "$ctl" ] || continue
                oe=$(grep -E '^ORIGINAL_ENTRANCE=' "$ctl" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
                [ -n "$oe" ] && entrance="$oe" && break
            done
        fi
    fi

    # 次要：core.db / 1panel.db（补端口 / 入口 / ssl / 版本 / api_key；端口以 user-info 为准）
    db_candidates=""
    for ctl in /usr/bin/1pctl /usr/local/bin/1pctl "$(command -v 1pctl 2>/dev/null)"; do
        [ -n "$ctl" ] && [ -f "$ctl" ] || continue
        base=$(grep -E '^BASE_DIR=' "$ctl" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
        [ -n "$base" ] || continue
        db_candidates="$db_candidates $base/1panel/db/core.db $base/db/core.db $base/1panel/db/1panel.db $base/1panel/db/1Panel.db"
    done
    db_candidates="$db_candidates $panel_dir/db/core.db /opt/1panel/db/core.db /var/lib/1panel/db/core.db /usr/local/1panel/db/core.db /data/1panel/db/core.db"
    db_candidates="$db_candidates $panel_dir/db/1panel.db $panel_dir/db/1Panel.db /var/lib/1panel/db/1panel.db /opt/1panel/db/1panel.db /opt/1panel/db/1Panel.db"
    # 读 settings：优先 sqlite3 CLI；很多精简机只有 python3（ali99 即此）
    read_1panel_settings() {
        _db="$1"
        [ -f "$_db" ] || return 1
        if command -v sqlite3 >/dev/null 2>&1; then
            if [ -z "$port" ]; then
                sp=$(sqlite3 "$_db" "SELECT value FROM settings WHERE key='ServerPort' LIMIT 1;" 2>/dev/null | head -1)
                [ -z "$sp" ] && sp=$(sqlite3 "$_db" "SELECT value FROM settings WHERE key='SystemPort' LIMIT 1;" 2>/dev/null | head -1)
                [ -n "$sp" ] && port=$(printf '%s' "$sp" | tr -dc '0-9')
            fi
            if [ -z "$entrance" ]; then
                se=$(sqlite3 "$_db" "SELECT value FROM settings WHERE key='SecurityEntrance' LIMIT 1;" 2>/dev/null | head -1)
                [ -n "$se" ] && entrance="$se"
            fi
            ssl=$(sqlite3 "$_db" "SELECT value FROM settings WHERE key='SSL' LIMIT 1;" 2>/dev/null | head -1)
            case "$ssl" in Enable|enable|true|1|TRUE) proto="https" ;; esac
            ak=$(sqlite3 "$_db" "SELECT value FROM settings WHERE key='ApiKey' LIMIT 1;" 2>/dev/null | head -1)
            [ -z "$ak" ] && ak=$(sqlite3 "$_db" "SELECT value FROM settings WHERE key='ServerKey' LIMIT 1;" 2>/dev/null | head -1)
            [ -n "$ak" ] && api_key="$ak"
            api_status=$(sqlite3 "$_db" "SELECT value FROM settings WHERE key='ApiInterfaceStatus' LIMIT 1;" 2>/dev/null | head -1)
            sv=$(sqlite3 "$_db" "SELECT value FROM settings WHERE key='SystemVersion' LIMIT 1;" 2>/dev/null | head -1)
            [ -n "$sv" ] && version="$sv"
            return 0
        fi
        PY=
        for c in python3 /usr/bin/python3 /usr/local/bin/python3 python; do
            if command -v "$c" >/dev/null 2>&1; then PY=$(command -v "$c"); break; fi
        done
        [ -n "$PY" ] || return 1
        # 输出: port|entrance|ssl|api_key|api_status|version （字段内不含 |）
        _line=$("$PY" - "$_db" <<'PY' 2>/dev/null
import sqlite3, sys
db = sys.argv[1]
def g(cur, k):
    r = cur.execute("SELECT value FROM settings WHERE key=? LIMIT 1", (k,)).fetchone()
    return (r[0] if r and r[0] is not None else "") or ""
try:
    conn = sqlite3.connect(db)
    cur = conn.cursor()
    port = g(cur, "ServerPort") or g(cur, "SystemPort")
    entrance = g(cur, "SecurityEntrance")
    ssl = g(cur, "SSL")
    api_key = g(cur, "ApiKey") or g(cur, "ServerKey")
    api_status = g(cur, "ApiInterfaceStatus")
    version = g(cur, "SystemVersion")
    conn.close()
    def clean(s):
        return str(s).replace("|", " ").replace("\\n", " ").replace("\\r", "")
    print("|".join(clean(x) for x in (port, entrance, ssl, api_key, api_status, version)))
except Exception:
    pass
PY
)
        [ -n "$_line" ] || return 1
        IFS='|' read -r _sp _se _ssl _ak _as _sv <<EOF
$_line
EOF
        if [ -z "$port" ] && [ -n "$_sp" ]; then port=$(printf '%s' "$_sp" | tr -dc '0-9'); fi
        if [ -z "$entrance" ] && [ -n "$_se" ]; then entrance="$_se"; fi
        case "$_ssl" in Enable|enable|true|1|TRUE) proto="https" ;; esac
        [ -n "$_ak" ] && api_key="$_ak"
        [ -n "$_as" ] && api_status="$_as"
        [ -n "$_sv" ] && version="$_sv"
        return 0
    }
    for db in $db_candidates; do
        [ -f "$db" ] || continue
        read_1panel_settings "$db" || continue
        if [ -n "$api_key" ] || [ -n "$api_status" ] || [ -n "$version" ]; then
            break
        fi
    done

    # 再次：app.yaml（仅在仍缺端口/入口时）
    if [ -z "$port" ] || [ -z "$entrance" ]; then
        yaml=""
        for f in "$panel_dir/conf/app.yaml" "$panel_dir/app.yaml" /etc/1panel/app.yaml; do
            if [ -f "$f" ]; then yaml="$f"; break; fi
        done
        if [ -n "$yaml" ]; then
            [ -z "$port" ] && port=$(grep -E '^[[:space:]]*port:' "$yaml" 2>/dev/null | head -1 | sed 's/.*port:[[:space:]]*//;s/#.*//;s/[[:space:]]*$//;s/"//g' | tr -dc '0-9')
            if [ -z "$entrance" ]; then
                entrance=$(grep -E '^[[:space:]]*entrance:' "$yaml" 2>/dev/null | head -1 | sed 's/.*entrance:[[:space:]]*//;s/#.*//;s/[[:space:]]*$//;s/"//g')
            fi
            if grep -qiE '^[[:space:]]*(ssl|https)[[:space:]]*:[[:space:]]*(true|enable|1)' "$yaml" 2>/dev/null; then
                proto="https"
            fi
        fi
    fi

    case "$api_status" in
        Enable|enable|true|1|TRUE) api_enabled=1 ;;
        Disable|disable|false|0|FALSE) api_enabled=0 ;;
        *)
            [ -n "$api_key" ] && api_enabled=1
            ;;
    esac

    # 禁止静默落默认 10086：读不到端口就报空，让前端提示探测失败
    if [ -z "$port" ]; then
        echo "port:0"
        echo "address:"
        echo "note:无法解析面板端口（请检查 1pctl user-info）"
        echo "api_enabled:0"
        echo "api_key:"
        echo "@ENDPANEL:1panel"
        return
    fi
    echo "port:$port"

    # settings 未标明 SSL 时，用本机 curl/openssl 判断是否 TLS-only
    if [ "$proto" = "http" ] && [ -n "$port" ]; then
        if command -v curl >/dev/null 2>&1; then
            https_code=$(curl -sk -o /dev/null -w '%{http_code}' --connect-timeout 2 "https://127.0.0.1:${port}/" 2>/dev/null || true)
            http_code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 "http://127.0.0.1:${port}/" 2>/dev/null || true)
            [ -z "$https_code" ] && https_code=000
            [ -z "$http_code" ] && http_code=000
            if [ "$https_code" != "000" ] && [ "$http_code" = "000" ]; then
                proto="https"
            fi
        elif command -v openssl >/dev/null 2>&1; then
            if echo | openssl s_client -connect "127.0.0.1:${port}" -servername 127.0.0.1 </dev/null 2>/dev/null | grep -q 'BEGIN CERTIFICATE'; then
                proto="https"
            fi
        fi
    fi

    echo "address:${proto}://127.0.0.1:${port}"
    if [ -n "$entrance" ]; then
        case "$entrance" in
            /*) echo "entrance:$entrance" ;;
            *) echo "entrance:/$entrance" ;;
        esac
    fi

    echo "api_enabled:$api_enabled"
    echo "api_key:$(b64 "$api_key")"

    if [ -z "$version" ] && command -v 1pctl >/dev/null 2>&1; then
        version=$(1pctl version 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | grep -oE 'v?[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)
    fi
    echo "note:${version}"
    echo "@ENDPANEL:1panel"
}

probe_bt
probe_1panel
"#.to_string()
}

/// 去掉 ANSI 转义与首尾空白（1pctl 输出常带颜色码）。
fn scrub_probe_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(n) = chars.next() {
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        if c != '\r' {
            out.push(c);
        }
    }
    out.trim().to_string()
}

/// 去掉路径，只保留 scheme://host:port（API 不含安全入口）。
fn panel_address_origin(address: &str) -> String {
    let address = address.trim();
    if address.is_empty() {
        return String::new();
    }
    let lower = address.to_ascii_lowercase();
    let path_start = if let Some(idx) = lower.find("://") {
        address[idx + 3..]
            .find('/')
            .map(|i| idx + 3 + i)
            .unwrap_or(address.len())
    } else {
        address.find('/').unwrap_or(address.len())
    };
    address[..path_start].trim_end_matches('/').to_string()
}

/// 解析面板探测输出。
fn parse_panel_probe_output(output: &str) -> Vec<PanelProbeItem> {
    let mut panels = Vec::new();
    let mut current_kind: Option<String> = None;
    let mut fields: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for line in output.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(kind) = line.strip_prefix("@PANEL:") {
            current_kind = Some(kind.trim().to_string());
            fields.clear();
        } else if let Some(kind) = line.strip_prefix("@ENDPANEL:") {
            if let Some(k) = current_kind.take() {
                if k == kind.trim() {
                    let installed = fields
                        .get("installed")
                        .map(|v| v.trim() == "1")
                        .unwrap_or(false);
                    let port: u16 = fields
                        .get("port")
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    let entrance = fields
                        .get("entrance")
                        .map(|v| scrub_probe_text(v))
                        .unwrap_or_default();
                    let raw_address = fields
                        .get("address")
                        .map(|v| scrub_probe_text(v))
                        .unwrap_or_default();
                    let address = panel_address_origin(&raw_address);
                    let api_enabled = fields
                        .get("api_enabled")
                        .map(|v| v.trim() == "1")
                        .unwrap_or(false);
                    // api_key 是 base64 编码的，需解码
                    let api_key_b64 = fields.get("api_key").map(|v| v.trim()).unwrap_or("");
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
                    let note = fields
                        .get("note")
                        .map(|v| scrub_probe_text(v))
                        .unwrap_or_default();
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
                if !key.is_empty() {
                    fields.insert(key, value);
                }
            }
        }
    }
    panels
}

/// 探测远端主机上已安装的面板（宝塔 / 1Panel）。
pub async fn probe_panels(
    session: &SshSession,
    resource_id: &str,
) -> Result<PanelProbeResult, OmniError> {
    let start = Instant::now();

    let script = build_panel_probe_script();
    let output = session.exec_capture(&script).await?;
    // 部分环境 stdout/stderr 混写；合并后再解析
    let combined = if output.stderr.trim().is_empty() {
        output.stdout
    } else {
        format!("{}\n{}", output.stdout, output.stderr)
    };
    let panels = parse_panel_probe_output(&combined);

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let probed_at = unix_timestamp_millis();

    Ok(PanelProbeResult {
        resource_id: resource_id.to_string(),
        panels,
        elapsed_ms,
        probed_at,
    })
}

/// 开启面板 API 的结果。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EnablePanelApiResult {
    pub kind: String,
    /// 是否已成功开启（或原本已开启）
    pub enabled: bool,
    /// 当前 API Key（敏感；前端写入 Vault，勿日志/勿传 AI）
    pub api_key: String,
    /// 人类可读说明（含白名单策略提示）
    pub message: String,
    /// 是否执行了服务重启（1Panel 为刷缓存常需重启 core）
    pub restarted: bool,
}

/// 通过 SSH 在远端开启宝塔 / 1Panel 的 API 接口。
pub async fn enable_panel_api(
    session: &SshSession,
    kind: &str,
    allow_all: bool,
) -> Result<EnablePanelApiResult, OmniError> {
    let kind = kind.trim().to_ascii_lowercase();
    if kind != "bt" && kind != "1panel" {
        return Err(OmniError::invalid_input("kind 须为 bt 或 1panel"));
    }

    let script = build_enable_panel_api_script(&kind, allow_all);
    let output = session.exec_capture(&script).await?;
    let combined = if output.stderr.trim().is_empty() {
        output.stdout
    } else {
        format!("{}\n{}", output.stdout, output.stderr)
    };

    parse_enable_panel_api_output(&kind, &combined)
}

fn build_enable_panel_api_script(kind: &str, allow_all: bool) -> String {
    let allow = if allow_all { "1" } else { "0" };
    // KIND / ALLOW_ALL 经环境变量传入，避免嵌入 Python 字符串转义问题
    format!(
        r#"#!/bin/bash
set +e
export OMNI_PANEL_KIND='{kind}'
export OMNI_ALLOW_ALL='{allow}'

PY=
for c in \
    /www/server/panel/pyenv/bin/python3 \
    /www/server/panel/pyenv/bin/python \
    python3 \
    /usr/bin/python3 \
    /usr/local/bin/python3 \
    python; do
    if [ -x "$c" ]; then PY="$c"; break; fi
    if command -v "$c" >/dev/null 2>&1; then PY=$(command -v "$c"); break; fi
done
# 1Panel：无 Python 时可用 sqlite3 CLI 回退
if [ -z "$PY" ] && [ "$OMNI_PANEL_KIND" = "1panel" ] && command -v sqlite3 >/dev/null 2>&1; then
    db=""
    # 优先从 1pctl BASE_DIR 推导
    for ctl in /usr/bin/1pctl /usr/local/bin/1pctl "$(command -v 1pctl 2>/dev/null)"; do
        [ -n "$ctl" ] && [ -f "$ctl" ] || continue
        base=$(grep -E '^BASE_DIR=' "$ctl" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
        [ -n "$base" ] || continue
        for p in "$base/1panel/db/core.db" "$base/db/core.db" "$base/1panel/db/1panel.db" "$base/1panel/db/1Panel.db"; do
            [ -f "$p" ] && db="$p" && break
        done
        [ -n "$db" ] && break
    done
    if [ -z "$db" ]; then
        for p in /opt/1panel/db/core.db /var/lib/1panel/db/core.db /usr/local/1panel/db/core.db \
                 /data/1panel/db/core.db /opt/1panel/db/1panel.db /opt/1panel/db/1Panel.db; do
            [ -f "$p" ] && db="$p" && break
        done
    fi
    if [ -z "$db" ]; then
        db=$(find /opt /var/lib /usr/local /data /home -maxdepth 5 \
            \( -name core.db -o -name 1panel.db -o -name 1Panel.db \) \
            -path '*1panel*' 2>/dev/null | head -1)
    fi
    if [ -n "$db" ]; then
        key=$(sqlite3 "$db" "SELECT value FROM settings WHERE key='ApiKey' LIMIT 1;" 2>/dev/null)
        [ -z "$key" ] && key=$(sqlite3 "$db" "SELECT value FROM settings WHERE key='ServerKey' LIMIT 1;" 2>/dev/null)
        if [ -z "$key" ]; then
            key=$(tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 32)
            now=$(date '+%Y-%m-%d %H:%M:%S')
            sqlite3 "$db" "INSERT INTO settings (created_at,updated_at,key,value,about) VALUES ('$now','$now','ApiKey','$key','');" 2>/dev/null
        fi
        now=$(date '+%Y-%m-%d %H:%M:%S')
        # v1 要小写 enable，v2 要 Enable；按版本/库名选择
        ver=$(sqlite3 "$db" "SELECT value FROM settings WHERE key='SystemVersion' LIMIT 1;" 2>/dev/null | head -1 | tr 'A-Z' 'a-z')
        base=$(basename "$db" | tr 'A-Z' 'a-z')
        api_status=Enable
        case "$ver" in v1*|1.*) api_status=enable ;; esac
        case "$base" in 1panel.db) api_status=enable ;; esac
        sqlite3 "$db" "UPDATE settings SET value='$api_status', updated_at='$now' WHERE key='ApiInterfaceStatus';" 2>/dev/null
        sqlite3 "$db" "UPDATE settings SET value='0', updated_at='$now' WHERE key='ApiKeyValidityTime';" 2>/dev/null
        if [ "$OMNI_ALLOW_ALL" = "1" ]; then
            sqlite3 "$db" "UPDATE settings SET value='0.0.0.0/0', updated_at='$now' WHERE key='IpWhiteList';" 2>/dev/null
        fi
        restarted=0
        systemctl restart 1panel-core >/dev/null 2>&1 && restarted=1
        [ "$restarted" = "0" ] && systemctl restart 1panel >/dev/null 2>&1 && restarted=1
        [ "$restarted" = "0" ] && 1pctl restart core >/dev/null 2>&1 && restarted=1
        [ "$restarted" = "0" ] && 1pctl restart >/dev/null 2>&1 && restarted=1
        echo "@RESULT:ok"
        echo "api_key:$(printf '%s' "$key" | base64 2>/dev/null | tr -d '\n')"
        echo "message:1Panel API 已开启（sqlite3 回退；库=$db；status=$api_status）"
        echo "restarted:$restarted"
        echo "@END"
        exit 0
    fi
fi
if [ -z "$PY" ]; then
    echo "@RESULT:err"
    echo "api_key:"
    echo "message:远端未找到可用的 Python（已尝试 panel/pyenv 与 python3）"
    echo "restarted:0"
    echo "@END"
    exit 0
fi

"$PY" - <<'PY'
import base64, hashlib, json, os, secrets, sqlite3, string, time

kind = os.environ.get("OMNI_PANEL_KIND", "").strip().lower()
allow_all = os.environ.get("OMNI_ALLOW_ALL", "1") == "1"

def emit(ok: bool, api_key: str = "", message: str = "", restarted: bool = False):
    print("@RESULT:ok" if ok else "@RESULT:err")
    if api_key:
        print("api_key:" + base64.b64encode(api_key.encode()).decode())
    else:
        print("api_key:")
    print("message:" + (message or "").replace("\n", " "))
    print("restarted:1" if restarted else "restarted:0")
    print("@END")

def gen_key(n: int) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))

def enable_bt():
    path = "/www/server/panel/config/api.json"
    if not os.path.isdir("/www/server/panel"):
        emit(False, message="未安装宝塔面板")
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = {{}}
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f) or {{}}
        except Exception as e:
            emit(False, message=f"读取 api.json 失败: {{e}}")
            return
        try:
            bak = path + ".omni.bak." + str(int(time.time()))
            with open(bak, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
        except Exception:
            pass
    # 只用 key；token 是面板侧 md5(key)，绝不能当密钥复用
    key = (data.get("key") or "").strip()
    if not key:
        key = gen_key(16)
    data["open"] = True
    data["key"] = key
    # 新版宝塔校验：request_token = md5(request_time + token)，其中 token 必须为 md5(key)
    data["token"] = hashlib.md5(key.encode("utf-8")).hexdigest()
    if allow_all:
        data["limit_addr"] = ["*"]
    else:
        addrs = data.get("limit_addr") or []
        if not isinstance(addrs, list):
            addrs = []
        if not addrs:
            addrs = ["127.0.0.1"]
        data["limit_addr"] = addrs
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.chmod(path, 0o600)
    except Exception as e:
        emit(False, message=f"写入 api.json 失败: {{e}}")
        return
    wl = "全部 IP (*)" if allow_all else "保留原白名单（可能不含本机公网 IP）"
    emit(True, api_key=key, message=f"宝塔 API 已开启；白名单: {{wl}}", restarted=False)

def find_1panel_db():
    candidates = []
    # 官方推荐：从 1pctl 读 BASE_DIR（可能是 /opt，也可能是自定义路径）
    for ctl in (
        "/usr/bin/1pctl",
        "/usr/local/bin/1pctl",
        "/usr/local/bin/1panel",
    ):
        if not os.path.isfile(ctl):
            continue
        try:
            with open(ctl, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if not line.startswith("BASE_DIR="):
                        continue
                    base = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if not base:
                        continue
                    candidates.extend([
                        os.path.join(base, "1panel", "db", "core.db"),
                        os.path.join(base, "db", "core.db"),
                        os.path.join(base, "1panel", "db", "1panel.db"),
                        os.path.join(base, "1panel", "db", "1Panel.db"),
                        os.path.join(base, "db", "1panel.db"),
                        os.path.join(base, "db", "1Panel.db"),
                    ])
        except Exception:
            pass
    # which 1pctl 解析（脚本可能不在固定路径）
    try:
        import shutil
        which = shutil.which("1pctl")
        if which and which not in (
            "/usr/bin/1pctl",
            "/usr/local/bin/1pctl",
        ):
            with open(which, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("BASE_DIR="):
                        base = line.split("=", 1)[1].strip().strip('"').strip("'")
                        if base:
                            candidates.extend([
                                os.path.join(base, "1panel", "db", "core.db"),
                                os.path.join(base, "db", "core.db"),
                                os.path.join(base, "1panel", "db", "1panel.db"),
                                os.path.join(base, "1panel", "db", "1Panel.db"),
                            ])
    except Exception:
        pass
    # 常见默认路径
    candidates.extend([
        "/opt/1panel/db/core.db",
        "/var/lib/1panel/db/core.db",
        "/usr/local/1panel/db/core.db",
        "/data/1panel/db/core.db",
        "/home/1panel/db/core.db",
        "/opt/1panel/db/1panel.db",
        "/opt/1panel/db/1Panel.db",
        "/var/lib/1panel/db/1panel.db",
        "/var/lib/1panel/db/1Panel.db",
    ])
    seen = set()
    for p in candidates:
        if not p or p in seen:
            continue
        seen.add(p)
        if os.path.isfile(p):
            return p
    # 浅层查找（限制深度，避免全盘扫描）
    try:
        import subprocess
        out = subprocess.check_output(
            "find /opt /var/lib /usr/local /data /home -maxdepth 5 "
            "\\( -name core.db -o -name 1panel.db -o -name 1Panel.db \\) "
            "-path '*1panel*' 2>/dev/null | head -20",
            shell=True,
            text=True,
            timeout=8,
        )
        for line in out.splitlines():
            p = line.strip()
            if p and os.path.isfile(p):
                return p
    except Exception:
        pass
    return None

def set_setting(conn, key, value):
    cur = conn.execute("SELECT id FROM settings WHERE key=? LIMIT 1", (key,))
    row = cur.fetchone()
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    if row:
        conn.execute(
            "UPDATE settings SET value=?, updated_at=? WHERE key=?",
            (value, now, key),
        )
    else:
        conn.execute(
            "INSERT INTO settings (created_at, updated_at, key, value, about) VALUES (?,?,?,?,?)",
            (now, now, key, value, ""),
        )

def enable_1panel():
    has_ctl = False
    try:
        import shutil
        has_ctl = shutil.which("1pctl") is not None
    except Exception:
        has_ctl = False
    if not (
        os.path.isdir("/opt/1panel")
        or os.path.isdir("/etc/1panel")
        or os.path.isdir("/var/lib/1panel")
        or os.path.isdir("/usr/local/1panel")
        or os.path.isfile("/usr/local/bin/1pctl")
        or os.path.isfile("/usr/bin/1pctl")
        or has_ctl
        or find_1panel_db()
    ):
        emit(False, message="未安装 1Panel")
        return
    db = find_1panel_db()
    if not db:
        emit(False, message="未找到 1Panel 数据库 (core.db)。请确认 1pctl BASE_DIR 或数据目录可访问")
        return
    try:
        conn = sqlite3.connect(db, timeout=10)
        conn.execute("PRAGMA busy_timeout=5000")
        cur = conn.execute("SELECT value FROM settings WHERE key='ApiKey' LIMIT 1")
        row = cur.fetchone()
        key = (row[0] if row and row[0] else "").strip()
        if not key:
            cur = conn.execute("SELECT value FROM settings WHERE key='ServerKey' LIMIT 1")
            row = cur.fetchone()
            key = (row[0] if row and row[0] else "").strip()
        if not key:
            key = gen_key(32)
            set_setting(conn, "ApiKey", key)
        # v1 认 enable，v2 认 Enable（大小写敏感，写错会「API 接口禁止访问」）
        ver = ""
        try:
            cur = conn.execute("SELECT value FROM settings WHERE key='SystemVersion' LIMIT 1")
            row = cur.fetchone()
            ver = ((row[0] if row and row[0] else "") or "").strip().lower()
        except Exception:
            ver = ""
        db_base = os.path.basename(db).lower()
        api_status = "enable" if (ver.startswith("v1") or ver.startswith("1.") or db_base == "1panel.db") else "Enable"
        set_setting(conn, "ApiInterfaceStatus", api_status)
        set_setting(conn, "ApiKeyValidityTime", "0")
        if allow_all:
            set_setting(conn, "IpWhiteList", "0.0.0.0/0")
        conn.commit()
        conn.close()
    except Exception as e:
        emit(False, message=f"更新 1Panel settings 失败 ({{db}}): {{e}}")
        return

    # 用 shell 调 systemctl/1pctl（部分环境 PATH/无 TTY 时 list 形式 subprocess 会失败）
    restarted = False
    for cmd in (
        "systemctl restart 1panel >/dev/null 2>&1",
        "systemctl restart 1panel-core >/dev/null 2>&1",
        "1pctl restart >/dev/null 2>&1",
        "1pctl restart core >/dev/null 2>&1",
        "/bin/systemctl restart 1panel >/dev/null 2>&1",
        "/bin/systemctl restart 1panel-core >/dev/null 2>&1",
        "docker restart 1panel >/dev/null 2>&1",
        "docker restart 1panel-v2 >/dev/null 2>&1",
    ):
        try:
            if os.system(cmd) == 0:
                restarted = True
                break
        except Exception:
            continue

    wl = "0.0.0.0/0" if allow_all else "保留原白名单"
    msg = f"1Panel API 已开启；库={{db}}；status={{api_status}}；白名单: {{wl}}"
    if restarted:
        msg += "；已重启 core 以刷新缓存"
    else:
        msg += "；未能自动重启 core，若暂时不可用请手动 1pctl restart core"
    emit(True, api_key=key, message=msg, restarted=restarted)

if kind == "bt":
    enable_bt()
elif kind == "1panel":
    enable_1panel()
else:
    emit(False, message=f"未知面板类型: {{kind}}")
PY
"#,
        kind = kind,
        allow = allow
    )
}

fn parse_enable_panel_api_output(
    kind: &str,
    output: &str,
) -> Result<EnablePanelApiResult, OmniError> {
    let mut ok: Option<bool> = None;
    let mut api_key_b64 = String::new();
    let mut message = String::new();
    let mut restarted = false;

    for line in output.lines() {
        let line = line.trim_end_matches('\r');
        if line == "@RESULT:ok" {
            ok = Some(true);
        } else if line == "@RESULT:err" {
            ok = Some(false);
        } else if line == "@END" {
            break;
        } else if let Some(v) = line.strip_prefix("api_key:") {
            api_key_b64 = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("message:") {
            message = scrub_probe_text(v);
        } else if let Some(v) = line.strip_prefix("restarted:") {
            restarted = v.trim() == "1";
        }
    }

    let Some(success) = ok else {
        let snippet = scrub_probe_text(&output.chars().take(400).collect::<String>());
        return Err(
            OmniError::new(ErrorCode::Ssh, "开启面板 API 未返回有效结果").with_cause(
                if snippet.is_empty() {
                    "远端无输出（是否缺少 python3？）".into()
                } else {
                    snippet
                },
            ),
        );
    };

    let api_key = if api_key_b64.is_empty() {
        String::new()
    } else {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(api_key_b64.trim())
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default()
    };

    if !success {
        return Err(OmniError::new(ErrorCode::Ssh, "开启面板 API 失败").with_cause(message));
    }

    Ok(EnablePanelApiResult {
        kind: kind.to_string(),
        enabled: true,
        api_key,
        message,
        restarted,
    })
}

#[cfg(test)]
mod panel_probe_tests {
    use super::{parse_enable_panel_api_output, parse_panel_probe_output, scrub_probe_text};
    use base64::Engine;

    #[test]
    fn parse_bt_and_1panel_segments() {
        let key = "secret-key-1";
        let key_b64 = base64::engine::general_purpose::STANDARD.encode(key);
        let out = format!(
            r#"@PANEL:bt
installed:1
port:7777
address:http://127.0.0.1:7777
entrance:/baota
api_enabled:0
api_key:{key_b64}
note:11.7.0
@ENDPANEL:bt
@PANEL:1panel
installed:1
port:7777
address:http://127.0.0.1:7777
entrance:/ca8b44c8e4
api_enabled:1
api_key:{key_b64}
note:v2.2.3
@ENDPANEL:1panel
"#
        );
        let panels = parse_panel_probe_output(&out);
        assert_eq!(panels.len(), 2);
        assert!(panels[0].installed);
        assert_eq!(panels[0].kind, "bt");
        assert_eq!(panels[0].port, 7777);
        assert_eq!(panels[0].entrance, "/baota");
        assert!(!panels[0].api_enabled);
        assert_eq!(panels[0].api_key, key);
        assert!(panels[1].installed);
        assert_eq!(panels[1].kind, "1panel");
        assert!(panels[1].api_enabled);
        assert_eq!(panels[1].entrance, "/ca8b44c8e4");
    }

    #[test]
    fn scrub_ansi_and_cr() {
        let s = scrub_probe_text("\u{1b}[0;34mv2.2.3\u{1b}[0m\r");
        assert_eq!(s, "v2.2.3");
    }

    #[test]
    fn parse_enable_ok() {
        let key = "abc123Key";
        let key_b64 = base64::engine::general_purpose::STANDARD.encode(key);
        let out = format!("@RESULT:ok\napi_key:{key_b64}\nmessage:ok done\nrestarted:1\n@END\n");
        let res = parse_enable_panel_api_output("bt", &out).unwrap();
        assert!(res.enabled);
        assert_eq!(res.api_key, key);
        assert!(res.restarted);
        assert!(res.message.contains("ok"));
    }

    #[test]
    fn parse_1panel_user_info_style_address() {
        let key_b64 = base64::engine::general_purpose::STANDARD.encode("k");
        let out = format!(
            r#"@PANEL:1panel
installed:1
port:7777
address:http://127.0.0.1:7777/777777
entrance:/777777
api_enabled:1
api_key:{key_b64}
note:v2
@ENDPANEL:1panel
"#
        );
        let panels = parse_panel_probe_output(&out);
        assert_eq!(panels.len(), 1);
        assert_eq!(panels[0].port, 7777);
        assert_eq!(panels[0].entrance, "/777777");
        // API 地址不含安全入口路径
        assert_eq!(panels[0].address, "http://127.0.0.1:7777");
    }
}

// ============================================================================
// 二进制下载安装
// ============================================================================

/// 仅允许从白名单 URL 本机下载二进制（用于 my2sql 等独立 IPC 入口）。
pub fn assert_allowed_binary_download_url(url: &str) -> Result<(), OmniError> {
    let ok = url.starts_with("https://raw.githubusercontent.com/liuhr/my2sql/")
        || url.starts_with("https://github.com/liuhr/my2sql/");
    if ok {
        Ok(())
    } else {
        Err(OmniError::new(
            ErrorCode::InvalidInput,
            "不允许从此 URL 下载远程安装包",
        ))
    }
}

/// manifest 中 DownloadBinary 声明的 URL 是否允许下载。
pub fn is_manifest_download_url(url: &str) -> bool {
    TOOLS.iter().any(|t| match &t.install {
        InstallMethod::DownloadBinary { url: u, .. } => u == url,
        _ => false,
    })
}

/// 本机下载二进制并经 SFTP 安装到远端路径。
pub async fn download_install_binary(
    session: &SshSession,
    url: &str,
    remote_path: &str,
) -> Result<String, OmniError> {
    let remote_path = remote_path.trim();
    if remote_path.is_empty() || remote_path.contains('\0') {
        return Err(OmniError::new(ErrorCode::InvalidInput, "远程安装路径无效"));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| OmniError::new(ErrorCode::Connection, format!("创建下载客户端失败: {e}")))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| OmniError::new(ErrorCode::Connection, format!("下载失败: {e}")))?;
    if !response.status().is_success() {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("下载失败，HTTP {}", response.status()),
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| OmniError::new(ErrorCode::Io, format!("读取下载内容失败: {e}")))?;
    if bytes.len() < 1024 {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "下载内容过小，可能不是有效二进制",
        ));
    }

    let abs_path = if remote_path.starts_with("~/") || remote_path == "~" {
        let home = session.exec_capture("printf %s \"$HOME\"").await?;
        let home = home.stdout.trim();
        if home.is_empty() {
            return Err(OmniError::new(ErrorCode::Internal, "远端 HOME 为空"));
        }
        if remote_path == "~" {
            home.to_string()
        } else {
            format!("{}/{}", home.trim_end_matches('/'), &remote_path[2..])
        }
    } else {
        remote_path.to_string()
    };

    let parent = abs_path
        .rsplit_once('/')
        .map(|(p, _)| p)
        .filter(|p| !p.is_empty())
        .unwrap_or(".");
    let mkdir_cmd = format!("mkdir -p {}", shell_single_quote(parent));
    let mkdir_out = session.exec_capture(&mkdir_cmd).await?;
    if mkdir_out.exit_code != 0 {
        return Err(OmniError::new(
            ErrorCode::Internal,
            format!("创建远端目录失败: {}", mkdir_out.stderr),
        ));
    }

    session.sftp_upload(&abs_path, &bytes).await?;

    let chmod_cmd = format!("chmod 755 {}", shell_single_quote(&abs_path));
    let chmod_out = session.exec_capture(&chmod_cmd).await?;
    if chmod_out.exit_code != 0 {
        return Err(OmniError::new(
            ErrorCode::Internal,
            format!("chmod 失败: {}", chmod_out.stderr),
        ));
    }

    Ok(abs_path)
}
