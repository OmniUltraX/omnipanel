export type Locale = "zh" | "en";

const STORAGE_KEY = "omnipanel-lang";

type Dict = Record<string, string>;

const zh: Dict = {
  "meta.title": "OmniPanel — AI 原生跨平台工程工作站",
  "meta.desc":
    "OmniPanel 将终端、SSH、数据库、Docker、服务器管理、文件、协议调试与 AI 辅助集成于桌面与 Web 双形态。一个窗口，贯穿开发运维上下文。",
  "nav.showcase": "实机界面",
  "nav.highlights": "近期亮点",
  "nav.modules": "核心模块",
  "nav.ai": "AI 原生",
  "nav.architecture": "技术架构",
  "nav.deploy": "部署",
  "nav.download": "下载",
  "nav.contact": "联系我们",
  "nav.github": "在 GitHub 上查看 OmniPanel",
  "nav.menu": "打开菜单",
  "nav.home": "OmniPanel 首页",
  "hero.title": "一个窗口，管理服务器、数据库、容器与工作流",
  "hero.lead":
    "一个 AI，贯穿开发运维上下文。OmniPanel 将终端、SSH、数据库、Docker、服务器管理、文件、协议调试与 AI 辅助集成于单一工作台 —— 支持桌面应用与 Web 版（Docker 一键部署）。",
  "hero.ctaDownload": "下载 OmniPanel",
  "hero.ctaDeploy": "Web 版部署",
  "hero.ctaSource": "查看源码",
  "showcase.eyebrow": "Product Screenshots",
  "showcase.title": "真实运行界面",
  "showcase.lead": "SSH 监控、Docker 管理与 AI Agent 同屏协作。移动鼠标感受景深，点击切换主画面。",
  "showcase.ssh": "SSH · 资源监控",
  "showcase.docker": "Docker · 容器编排",
  "showcase.agent": "AI Agent · 巡检报告",
  "showcase.tabSsh": "SSH 监控",
  "showcase.tabDocker": "Docker",
  "showcase.tabAgent": "AI Agent",
  "showcase.tabs": "切换截图",
  "showcase.ariaSsh": "查看 SSH 监控界面",
  "showcase.ariaDocker": "查看 Docker 管理界面",
  "showcase.ariaAgent": "查看 AI Agent 巡检界面",
  "showcase.altSsh": "OmniPanel SSH 服务器监控与 AI 助手",
  "showcase.altDocker": "OmniPanel Docker 容器管理",
  "showcase.altAgent": "OmniPanel AI Agent 服务巡检报告",
  "highlights.eyebrow": "Highlights",
  "highlights.title": "近期亮点",
  "highlights.lead": "v0.8.1：团队管理与 OSS 同步、SSH 进程监控、Redis 应用内控制台，并修复设置页下拉导致标题栏消失等问题。",
  "highlights.web.h": "团队 · OSS 同步",
  "highlights.web.p": "邮箱邀请成员、数据预览、同步排除与自定义面板团队分享",
  "highlights.panel.h": "SSH · 进程监控",
  "highlights.panel.p": "主机概览与进程轮询；进程详情命令行解析与缓存",
  "highlights.ssh.h": "Redis 控制台",
  "highlights.ssh.p": "应用内 Redis 控制台，运维面板体验优化",
  "highlights.termAi.h": "自定义监控面板",
  "highlights.termAi.p": "网格拖拽布局；主机 / Docker / MySQL / Redis 等监控小组件",
  "highlights.db.h": "数据库",
  "highlights.db.p": "表网格列标题统一；设置页字体下拉不再滚走自定义标题栏",
  "highlights.sec.h": "Web 版",
  "highlights.sec.p": "浏览器访问 + GHCR 公开镜像，Render / Zeabur / Railway 等一键部署",
  "modules.eyebrow": "Core Modules",
  "modules.title": "九大模块，覆盖日常开发运维完整闭环",
  "mod.terminal.p": "多标签分屏、Blocks 输出分组、命令历史、危险命令二次确认，VT100/VT220 高兼容。",
  "mod.ssh.p": "连接管理、SFTP、端口转发、跳板机；tmux 远端会话治理与主机监控。",
  "mod.files.p": "本地 / 远程浏览、收藏与全局收藏、跨连接文件传输、统一预览壳。",
  "mod.db.p": "SQL 编辑器、百万行虚拟滚动网格、ER 图、NL2SQL、结果预览与数据同步导出。",
  "mod.docker.p": "容器、镜像、Compose、网络、卷；本地 / 远程 Engine / SSH 宿主机 / 1Panel / 宝塔。",
  "mod.docker.tagLog": "日志流",
  "mod.server.p": "系统监控、进程与远程文件；宝塔 / 1Panel 网站·应用·证书·计划任务；自定义监控面板与小组件；云厂商资源入口。",
  "mod.server.tagMon": "监控",
  "mod.server.tagBt": "宝塔",
  "mod.server.tagCloud": "云厂商",
  "mod.protocol.p": "HTTP/API 调试、WebSocket、MQTT、串口 —— 协议调试统一工作区。",
  "mod.ai.p": "上下文感知、Plan / Skills、操作链编排、`omni_ask_user` 澄清表单与敏感信息脱敏；危险操作需确认。",
  "mod.workflow.p": "命令模板、部署流水线、排障手册、快捷启动与任务中心，参数化执行与完整审计记录。",
  "mod.workflow.tagTpl": "模板",
  "mod.workflow.tagAudit": "审计",
  "ai.eyebrow": "AI Native",
  "ai.title": "AI 不是聊天窗口，是你的随行工程专家",
  "ai.lead":
    "OmniPanel 的 AI 能读取当前终端输出、数据库结构、容器状态和日志片段，给出可执行的建议 —— 不只是一段文本。",
  "ai.f1.h": "上下文感知",
  "ai.f1.p": "自动关联终端、SSH 主机、数据库连接、容器状态与日志片段",
  "ai.f2.h": "操作链编排",
  "ai.f2.p": "AI 拆解任务为多步操作链，用户确认后逐步执行，全程可审计",
  "ai.f3.h": "安全边界",
  "ai.f3.p": "AI 只建议不越权，危险操作需二次确认，生产环境内置保护",
  "ai.lines.eyebrow": "AI Stack",
  "ai.lines.title": "三条 AI 能力线",
  "ai.lines.lead": "内置助手、纯 LLM 路由与外部 Agent 接入，按需组合、互不耦合。",
  "ai.lines.orch.h": "InternalOrchestrator",
  "ai.lines.orch.p": "Tauri IPC `ai_chat_stream`：内置 UI，多 backend、`omni_*` 工具与终端审批",
  "ai.lines.router.h": "Agent Router",
  "ai.lines.router.p": "`http://127.0.0.1:8765/v1/*`：OpenAI 兼容 SSE 纯路由，零 MCP 耦合",
  "ai.lines.mcp.h": "OmniMCP",
  "ai.lines.mcp.p": "`http://127.0.0.1:12756/mcp`：Cursor / Claude Code 等外部 Agent 接入",
  "ai.demo.user": "分析 postgres-main 的慢查询",
  "ai.demo.1": "正在获取最近 1 小时的慢查询日志…",
  "ai.demo.2a": "发现 ",
  "ai.demo.2b": " 条超过 2s 的查询",
  "ai.demo.3": "建议执行：",
  "ai.demo.4": "[已复制到操作草稿箱] 确认后执行？",
  "arch.eyebrow": "Architecture",
  "arch.title": "Tauri 2 + Rust 核心，本地优先",
  "arch.lead":
    "单二进制、内存安全、凭据本地存储。桌面 Tauri IPC + Web HTTP/WS 双传输；模块能力收敛在 omnipanel-* crates。",
  "arch.ui": "UI 层",
  "arch.mod": "模块层",
  "arch.eng": "引擎层",
  "arch.store": "存储层",
  "arch.sys": "系统层",
  "arch.cred": "本地凭据",
  "arch.sync": "可选同步",
  "use.eyebrow": "Use Cases",
  "use.title": "为真正的工程场景设计",
  "use.1.h": "新项目部署",
  "use.1.p":
    "连接服务器、上传配置、启动容器、检查日志 —— SSH、SFTP、Docker Compose 与日志面板在同一工作区完成。",
  "use.2.h": "线上故障排查",
  "use.2.p": "AI 汇总主机、容器、日志与错误输出，生成排查路径。从告警到修复，全程不切换窗口。",
  "use.3.h": "多服务器维护",
  "use.3.p": "选中服务器分组后统一执行命令，结果按机器聚合对比。批量分发、模板化执行。",
  "deploy.eyebrow": "Deploy",
  "deploy.title": "部署",
  "deploy.lead": "Web 版支持 Docker、Render、Zeabur、Railway、Koyeb、DigitalOcean、Fly.io 等平台部署。",
  "deploy.render": "一键部署到 Render",
  "deploy.zeabur": "一键部署到 Zeabur",
  "deploy.railway": "一键部署到 Railway",
  "deploy.koyeb": "一键部署到 Koyeb",
  "deploy.digitalocean": "一键部署到 DigitalOcean",
  "deploy.flyio": "一键部署到 Fly.io",
  "foot.tagline": "All in One · 小而全而优而美",
  "pref.lang": "切换为 English",
  "pref.theme": "切换主题",
  "dl.sectionTitle": "下载 OmniPanel",
  "dl.currentVersion": "当前版本",
  "dl.loading": "正在加载版本信息…",
  "contact.eyebrow": "Contact",
  "contact.title": "联系我们",
  "contact.lead": "商务合作、技术支持与企业采购，可通过企业邮箱、微信公众号或反馈群联系我们。",
  "contact.emailLabel": "企业邮箱",
  "contact.oaScan": "微信扫一扫 · 关注公众号",
  "contact.oaAlt": "OmniPanel 微信公众号二维码",
  "contact.tabOa": "公众号",
  "contact.tabFeedback": "反馈群",
  "contact.qrSwitchAria": "切换联系二维码",
  "contact.feedbackScan": "微信扫一扫 · 加入反馈群",
  "contact.feedbackAlt": "OmniPanel 反馈群二维码",
  "dl.historyLoading": "加载中…",
  "dl.statusLoading": "正在从 OSS 读取版本清单…",
  "dl.statusError": "无法读取版本清单（OSS 可能未配置 CORS，且同域镜像缺失）。请稍后重试。",
  "dl.statusEmpty": "版本清单为空。",
  "dl.statusVersions": "已加载 {n} 个版本（versions.json）",
  "dl.statusLatestOnly": "已加载最新版（versions.json 尚未就绪，仅显示 latest.json）",
  "dl.lead": "安装包托管于阿里云 OSS，点击即下。当前通道：",
  "dl.published": "发布于",
  "dl.notes": "更新说明",
  "dl.noNotes": "暂无更新说明。",
  "dl.noAssets": "该版本暂无可用安装包。",
  "dl.recommended": "推荐",
  "dl.historyTitle": "历史版本",
  "dl.historyEmpty": "暂无更多版本。发版后会写入 versions.json 并在此列出。",
  "plat.win": "Windows",
  "plat.winHint": "NSIS 安装包 · x64",
  "plat.winHintAlt": "安装包 · x64",
  "plat.msi": "Windows MSI",
  "plat.msiHint": "企业部署 · x64",
  "plat.mac": "macOS",
  "plat.macArm": "Apple Silicon",
  "plat.macArmApp": "Apple Silicon · app.tar.gz",
  "plat.macIntel": "Intel",
  "plat.macIntelApp": "Intel · app.tar.gz",
  "plat.linux": "Linux",
  "plat.linuxX64": "x86_64",
  "plat.linuxArm": "ARM64",
  "plat.generic": "安装包",
};

const en: Dict = {
  "meta.title": "OmniPanel — AI-Native Engineering Workstation",
  "meta.desc":
    "OmniPanel unifies terminal, SSH, databases, Docker, server ops, files, protocol debugging, and AI — desktop and Web.",
  "nav.showcase": "Demo",
  "nav.highlights": "Highlights",
  "nav.modules": "Modules",
  "nav.ai": "AI",
  "nav.architecture": "Arch",
  "nav.deploy": "Deploy",
  "nav.download": "Download",
  "nav.contact": "Contact",
  "nav.github": "View OmniPanel on GitHub",
  "nav.menu": "Open menu",
  "nav.home": "OmniPanel home",
  "hero.title": "One window for servers, databases, containers, and workflows",
  "hero.lead":
    "One AI across your engineering context. OmniPanel unifies terminal, SSH, databases, Docker, server ops, files, protocol debugging, and AI — desktop app and Web edition (Docker one-click deploy).",
  "hero.ctaDownload": "Download OmniPanel",
  "hero.ctaDeploy": "Deploy Web",
  "hero.ctaSource": "View source",
  "showcase.eyebrow": "Product Screenshots",
  "showcase.title": "Real product UI",
  "showcase.lead":
    "SSH monitoring, Docker management, and AI Agent side by side. Move the pointer for depth; click to switch the hero shot.",
  "showcase.ssh": "SSH · Monitoring",
  "showcase.docker": "Docker · Containers",
  "showcase.agent": "AI Agent · Patrol report",
  "showcase.tabSsh": "SSH",
  "showcase.tabDocker": "Docker",
  "showcase.tabAgent": "AI Agent",
  "showcase.tabs": "Switch screenshot",
  "showcase.ariaSsh": "View SSH monitoring UI",
  "showcase.ariaDocker": "View Docker management UI",
  "showcase.ariaAgent": "View AI Agent patrol UI",
  "showcase.altSsh": "OmniPanel SSH server monitoring with AI assistant",
  "showcase.altDocker": "OmniPanel Docker container management",
  "showcase.altAgent": "OmniPanel AI Agent service patrol report",
  "highlights.eyebrow": "Highlights",
  "highlights.title": "Recent highlights",
  "highlights.lead": "v0.8.1: team management & OSS sync, SSH process monitoring, in-app Redis console, and settings dropdown title-bar fix.",
  "highlights.web.h": "Teams · OSS sync",
  "highlights.web.p": "Email invites, data preview, sync exclusions, and custom panel sharing to team members",
  "highlights.panel.h": "SSH · Process monitor",
  "highlights.panel.p": "Live polling on host overview; cached command-line in process details",
  "highlights.ssh.h": "Redis console",
  "highlights.ssh.p": "In-app Redis console with polished ops panels",
  "highlights.termAi.h": "Custom monitor panels",
  "highlights.termAi.p": "Drag-and-drop grid panels with host / Docker / MySQL / Redis widgets",
  "highlights.db.h": "Database",
  "highlights.db.p": "Unified grid column headers; settings font dropdown no longer hides the custom title bar",
  "highlights.sec.h": "Web edition",
  "highlights.sec.p": "Browser UI + public GHCR image; one-click deploy on Render, Zeabur, Railway, and more",
  "modules.eyebrow": "Core Modules",
  "modules.title": "Nine modules for day-to-day engineering ops",
  "mod.terminal.p":
    "Split panes, Blocks grouping, command history, dangerous-command confirmation; VT100/VT220 compatible.",
  "mod.ssh.p":
    "Connection manager, SFTP, port forwarding, jump hosts; tmux governance and host monitoring.",
  "mod.files.p":
    "Local / remote browsing, favorites, cross-connection transfer, unified preview shell.",
  "mod.db.p":
    "SQL editor, million-row virtual grid, ER diagrams, NL2SQL, result preview, sync and export.",
  "mod.docker.p":
    "Containers, images, Compose, networks, volumes — local / remote Engine / SSH host / 1Panel / BT Panel.",
  "mod.docker.tagLog": "Log stream",
  "mod.server.p":
    "System metrics, processes, remote files; BT / 1Panel sites·apps·certs·cron; custom monitor panels & widgets; cloud vendor entry.",
  "mod.server.tagMon": "Metrics",
  "mod.server.tagBt": "BT Panel",
  "mod.server.tagCloud": "Cloud",
  "mod.protocol.p": "HTTP/API, WebSocket, MQTT, serial — one workspace for protocol debugging.",
  "mod.ai.p":
    "Context-aware ops, Plans, Skills, action chains, `omni_ask_user` forms, secret redaction; risky ops need approval.",
  "mod.workflow.p":
    "Templates, deploy pipelines, runbooks, Quick Launcher, task center — parameterized runs with audit trails.",
  "mod.workflow.tagTpl": "Templates",
  "mod.workflow.tagAudit": "Audit",
  "ai.eyebrow": "AI Native",
  "ai.title": "Not a chat box — an engineering co-pilot",
  "ai.lead":
    "OmniPanel AI reads terminal output, schema, container state, and log slices to propose executable next steps — not just prose.",
  "ai.f1.h": "Context aware",
  "ai.f1.p": "Links terminal, SSH hosts, DB connections, containers, and log fragments automatically",
  "ai.f2.h": "Action chains",
  "ai.f2.p": "Breaks work into steps you confirm and execute, with a full audit trail",
  "ai.f3.h": "Safety rails",
  "ai.f3.p": "Suggestions only by default; dangerous ops need confirmation; prod protections built in",
  "ai.lines.eyebrow": "AI Stack",
  "ai.lines.title": "Three AI capability lines",
  "ai.lines.lead": "Built-in assistant, pure LLM router, and external agent bridge — composable, decoupled.",
  "ai.lines.orch.h": "InternalOrchestrator",
  "ai.lines.orch.p": "Tauri IPC `ai_chat_stream`: in-app UI, multi-backend, `omni_*` tools, terminal approval",
  "ai.lines.router.h": "Agent Router",
  "ai.lines.router.p": "`http://127.0.0.1:8765/v1/*`: OpenAI-compatible SSE routing, zero MCP coupling",
  "ai.lines.mcp.h": "OmniMCP",
  "ai.lines.mcp.p": "`http://127.0.0.1:12756/mcp`: Cursor, Claude Code, and other external agents",
  "ai.demo.user": "Analyze slow queries on postgres-main",
  "ai.demo.1": "Fetching slow-query logs from the last hour…",
  "ai.demo.2a": "Found ",
  "ai.demo.2b": " queries over 2s",
  "ai.demo.3": "Suggested:",
  "ai.demo.4": "[Copied to draft actions] Run after confirmation?",
  "arch.eyebrow": "Architecture",
  "arch.title": "Tauri 2 + Rust core, local-first",
  "arch.lead":
    "Single binary, memory-safe, credentials on device. Desktop Tauri IPC + Web HTTP/WS; capabilities in omnipanel-* crates.",
  "arch.ui": "UI",
  "arch.mod": "Modules",
  "arch.eng": "Engine",
  "arch.store": "Storage",
  "arch.sys": "System",
  "arch.cred": "Local secrets",
  "arch.sync": "Optional sync",
  "use.eyebrow": "Use Cases",
  "use.title": "Built for real engineering work",
  "use.1.h": "Ship a new project",
  "use.1.p":
    "Connect, upload config, start containers, check logs — SSH, SFTP, Compose, and logs in one place.",
  "use.2.h": "Production incident",
  "use.2.p": "AI stitches hosts, containers, logs, and errors into a path from alert to fix.",
  "use.3.h": "Fleet maintenance",
  "use.3.p": "Run templated commands across a server group and compare results per host.",
  "deploy.eyebrow": "Deploy",
  "deploy.title": "Deployment",
  "deploy.lead": "Web edition: Docker, Render, Zeabur, Railway, Koyeb, DigitalOcean, Fly.io, and more.",
  "deploy.render": "Deploy to Render",
  "deploy.zeabur": "Deploy on Zeabur",
  "deploy.railway": "Deploy on Railway",
  "deploy.koyeb": "Deploy to Koyeb",
  "deploy.digitalocean": "Deploy to DigitalOcean",
  "deploy.flyio": "Deploy on Fly.io",
  "foot.tagline": "All in One · Small, complete, refined",
  "pref.lang": "Switch to 中文",
  "pref.theme": "Toggle theme",
  "dl.sectionTitle": "Download OmniPanel",
  "dl.currentVersion": "Current version",
  "dl.loading": "Loading release info…",
  "contact.eyebrow": "Contact",
  "contact.title": "Contact us",
  "contact.lead":
    "For business, support, and enterprise licensing — email us, follow our WeChat Official Account, or join the feedback group.",
  "contact.emailLabel": "Enterprise email",
  "contact.oaScan": "Scan to follow on WeChat",
  "contact.oaAlt": "OmniPanel WeChat Official Account QR code",
  "contact.tabOa": "Official Account",
  "contact.tabFeedback": "Feedback Group",
  "contact.qrSwitchAria": "Switch contact QR code",
  "contact.feedbackScan": "Scan to join the feedback group",
  "contact.feedbackAlt": "OmniPanel feedback group QR code",
  "dl.historyLoading": "Loading…",
  "dl.statusLoading": "Fetching release manifests from OSS…",
  "dl.statusError":
    "Could not read release manifests (OSS CORS may be missing and local mirror absent). Try again later.",
  "dl.statusEmpty": "Release list is empty.",
  "dl.statusVersions": "Loaded {n} versions (versions.json)",
  "dl.statusLatestOnly": "Loaded latest only (versions.json not ready yet)",
  "dl.lead": "Installers are hosted on Aliyun OSS. Current channel:",
  "dl.published": "Published",
  "dl.notes": "Release notes",
  "dl.noNotes": "No release notes.",
  "dl.noAssets": "No installers for this version.",
  "dl.recommended": "Recommended",
  "dl.historyTitle": "Previous releases",
  "dl.historyEmpty": "No older releases yet. Future publishes will append versions.json.",
  "plat.win": "Windows",
  "plat.winHint": "NSIS installer · x64",
  "plat.winHintAlt": "Installer · x64",
  "plat.msi": "Windows MSI",
  "plat.msiHint": "Enterprise · x64",
  "plat.mac": "macOS",
  "plat.macArm": "Apple Silicon",
  "plat.macArmApp": "Apple Silicon · app.tar.gz",
  "plat.macIntel": "Intel",
  "plat.macIntelApp": "Intel · app.tar.gz",
  "plat.linux": "Linux",
  "plat.linuxX64": "x86_64",
  "plat.linuxArm": "ARM64",
  "plat.generic": "Installer",
};

const catalogs: Record<Locale, Dict> = { zh, en };

function detectLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "zh" || saved === "en") return saved;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

let current: Locale = "zh";

export function getLocale(): Locale {
  return current;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = catalogs[current] ?? zh;
  let text = dict[key] ?? zh[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

export function applyI18n(locale: Locale = current) {
  current = locale;
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  document.documentElement.dataset.lang = locale;

  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (!key) return;
    el.textContent = t(key);
  });

  document.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => {
    const key = el.dataset.i18nHtml;
    if (!key) return;
    el.innerHTML = t(key);
  });

  document.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((el) => {
    const key = el.dataset.i18nAria;
    if (!key) return;
    el.setAttribute("aria-label", t(key));
  });

  document.querySelectorAll<HTMLElement>("[data-i18n-alt]").forEach((el) => {
    const key = el.dataset.i18nAlt;
    if (!key) return;
    el.setAttribute("alt", t(key));
  });

  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const key = el.dataset.i18nTitle;
    if (!key) return;
    document.title = t(key);
  });

  const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  const descKey = document.documentElement.dataset.i18nDesc;
  if (desc && descKey) desc.content = t(descKey);

  document.querySelectorAll<HTMLButtonElement>("[data-lang-toggle]").forEach((btn) => {
    btn.textContent = locale === "zh" ? "EN" : "中文";
    btn.setAttribute("aria-label", t("pref.lang"));
  });

  document.dispatchEvent(new CustomEvent("omnipanel:locale", { detail: { locale } }));
}

export function setLocale(locale: Locale) {
  localStorage.setItem(STORAGE_KEY, locale);
  applyI18n(locale);
}

export function toggleLocale(): Locale {
  const next: Locale = current === "zh" ? "en" : "zh";
  setLocale(next);
  return next;
}

export function setupI18n() {
  current = detectLocale();
  applyI18n(current);

  document.querySelectorAll<HTMLButtonElement>("[data-lang-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => toggleLocale());
  });
}
