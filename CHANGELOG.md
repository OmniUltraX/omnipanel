# Changelog

本文件记录 OmniPanel 各版本的 notable 变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.7.12] - 2026-08-10

### 新增

- **助手 · ask_user 同步**：聊天 OSS 增加 `ask_user____` 段，桌面澄清表单同步到小程序；小程序可提交/跳过答案，经 notify 快通道回传桌面续跑挂起工具

### 修复

- **Rust 警告**：清理 assistant crate 未使用类型 / 补 overviewKey 解析单测

## [0.7.11] - 2026-08-08

### 新增

- **终端 · 直通 Ask / Plan**：流内询问卡（`omni_ask_user`）与右下角 Plan 条（`omni_plan_*`），OpenSpec `passthrough-ask-plan-cards`

### 修复

- **终端 · Shell Agent 结果卡锚点**：命令执行后等 shell prompt 落定再钉结果卡，避免插在输出与 prompt 中间
- **终端 · 双 prompt**：PTY 同步只发 `\n`（避免 ICRNL 下 `\r\n` 提交两次）；release 飞行锁防竞态
- **终端 · 卡下空白带**：结果卡测高收紧、起步行数降低，减少占位偏高留下的空白
- **终端 · 冗余回显**：去掉同意后的灰字「✓ 已同意 · …」行（确认卡已表达同意）

### 变更

- **终端 · Plan 条**：右下角窄条一体折叠，会话级展开态持久化

## [0.7.10] - 2026-08-07

### 修复

- **CI 构建**：修复 3 个 TypeScript 编译错误（TS6133 未使用 import、TS2322 `dbName` 类型不兼容、TS2345 测试文件 `setTablePreviews` 类型推断错误），恢复 `tsc -b && vite build` 门禁通过

### 变更

- **工程规范**：CLAUDE.md 新增「Mandatory Type Check」强校验章节，要求所有前端代码变更后必须运行 `tsc -b` 通过
- **规则文件**：新增 `.cursorrules`、`.windsurfrules`、`AGENTS.md`、`GEMINI.md`、`.github/copilot-instructions.md` 等 IDE/CLI 规则文件，统一强校验要求

## [0.7.9] - 2026-08-07

### 新增

- **终端 · 直通 AI 双轨**：直通表现层（decoration / 蓝字 / 占位）易失；命令栏 Block 持久 AI 时间线；关 tab 重开不重建流内卡、不 sticky 复活
- **终端 · 确认卡态**：同意 / 拒绝冻结卡对齐待确认布局（说明 + 命令 + 主按钮）；拒绝后立即归还 shell prompt；移除 sticky 思考兜底
- **文件 · 统一预览**：统一预览壳与 Preview IO（本地 / 文件管理 / SFTP）；CodeMirror 查找替换；本地大日志会话 API
- **数据库 · Schema / SQL**：Schema 树检索与扁平化增强；SQL 文件绑定上下文；表预览数据应用与历史/语句处理增强
- **UI · Topbar / 搜索**：Topbar 添加菜单配置化；ScopedSearch 注册与全局搜索快捷键优化
- **设置**：模块窗口集成设置能力
- **路由**：`useModuleRouteActive` 统一各模块路由激活判定

### 修复

- **终端**：命令输入分流边界与单测；tmux 断连与会话管理
- **数据库**：TableDataGrid 滚动恢复逻辑简化

### 变更

- 移除 workspace mock panel 功能

## [0.7.8] - 2026-08-07

### 新增

- **数据库 · SQL 语义高亮**：表名 / 别名 / 字段分色着色；修复反引号标识符后整段变白；Hover 浮层挂到 `body` 并避开顶部 Tab，避免被裁切
- **数据库 · SQL 工具栏**：查询设置（关键字大小写、字体/字号/行高、保存时格式化、结果页大小）；本文件执行历史（SELECT / DML / DDL / 其他，仅成功、最多 50 条）；自动提交开关与手动事务 Commit / Rollback（MySQL / PostgreSQL 独占会话）；格式化与终止移至左侧
- **数据库 · 结果导入表**：查询结果可一键导入到表
- **数据库 · 表预览查询栏**：WHERE / ORDER BY 可拖拽调宽；SQL 输入支持关键字与列名补全
- **终端 · 直通 AI Agent**：直通模式下 shell-tool Agent 循环（输出 → 审核 → 执行 → 观察 → 续轮）；自然语言 Enter 入口与 alt-screen 等门闩，保留原生终端编辑能力
- **安全 · Vault 设备码同步**：跨设备凭据同步（Argon2id + AES-256-GCM）；设备码解锁 / 推送 / 拉取面板
- **数据库连接同步**：设备间连接配置与密钥同步结构增强，兼容旧快照格式

### 修复

- **数据库**：编辑连接时从 Vault 回填密码（列表接口不返回明文导致表单密码为空）
- **数据库 · 查询设置**：设置面板内下拉被浮层遮挡（提高 Select `z-index`，点击选项不再误关面板）
- **触控 / 滚动**：修复 macOS WKWebView 触摸滚动失效；补充 Shift+滚轮横向滚动
- **前端构建**：修复 terminal shellAgent 相关 `tsc -b` 类型错误；去掉查询会话中多余的 `mut` 警告

### 变更

- 列选择栏折叠状态本地持久化
- 客户端设备导入数据库连接改为走全局状态存储，侧边栏同步刷新
- IPC 命令注册补充 `protocol::sse_connect` / `protocol::sse_close`

## [0.7.7] - 2026-08-05

### 修复

- **AI · ask_user 工具**：修复 `omni_ask_user` 在终端内嵌会话不出现表单的问题。dispatcher 此前仅支持从 `useAiStore` 查找/写入父消息，导致终端内嵌会话（消息存储在 `useBlocksStore.<blockId>.aiThread`）找不到父消息而直接报错回传。现已支持双存储：根据 `inline.blockId` 自动切换到 blocksStore 路径，并新增 `upsertAiThreadUserQuestionPart` 方法写入 part；`UserQuestionForm` 的 `useLiveAskUserForm` 也按 `term-inline:` 前缀分流订阅，确保终端内嵌表单状态实时刷新

## [0.7.6] - 2026-08-05

### 新增

- **助手 · 入站会话**：小程序消息携带 `sessionId`，桌面端自动切到对应会话并触发 AI 回复；忙时排队，成功后才标记已读
- **助手 · Plan 同步**：聊天 OSS 增加 `plan________` 段落，桌面 Plan 待办可同步到助手端；`omni_plan_*` 工具调用在聊天中隐藏
- **AI · 思考阶段工具合并**：同一思考阶段内连续工具调用合并为一组展示
- **文件传输**：拖拽 / 粘贴上传、断点续传、后台任务统一展示；SFTP / 本地 OS 文件拖放增强
- **协议 · SSE**：HTTP 面板支持 Server-Sent Events 会话
- **数据库**：AI Composer 可挂载数据库连接上下文；MySQL BIT 列解码

### 修复

- **安全 · 危险命令审批**：修复 Windows 客户端 `rm -rf` 等危险命令绕过审批的根因
- **安全 · ToolGate**：审批闭环、长耗时命令超时 / 拦截；工具结果失败必回传，避免 AI 工具挂起
- **AI 助手页**：正文 / Markdown / 思考 / PlanView 可选中复制（全局 `user-select: none` 放行）

### 变更

- README 增加中文版并完善英文说明

## [0.7.5] - 2026-08-04

### 修复

- **发版 CI**：微信广播超时不再导致整次发版失败（阻断 OSS 同步）；rust-cache 换新 key 并禁止失败半成品锁死缓存

### 变更

- 发版只恢复 master 预热缓存、不写回 tag 缓存，避免配额浪费与 immutable key 踩坑

## [0.7.4] - 2026-08-04

### 新增

- **文件 · 超大日志预览**：末尾窗口模式、可选中文本、正搜/反搜与持续翻页（`skip_matches`，避免大文件 `head` 超时）
- **数据库 · MCP**：`create_run_sql`，支持执行复杂 SQL 脚本

### 修复

- **终端 · AI**：tool group / tool fallback 触发区域过窄、空 action bar 挡点击；吸顶滚动锁干扰
- **日志搜索**：`LogSearchOptions.totalLinesHint` 与 bindings 对齐；`lineNo` 可空导致 `tsc` 失败

### 变更

- **发版 CI**：在 master 预热 rust-cache / npm（tag 可从默认分支命中）；关闭 sccache→GHA，避免海量碎片撑爆缓存配额

## [0.7.3] - 2026-08-04

### 新增

- **SSH · tmux 会话树**：窗口列表展开、按 pane 恢复终端；`ssh_tmux_list_windows`；pane↔sessionId 映射以续接 Blocks / 历史 / AI
- **主机列表**：SSH 主机快捷跳转入口增强

### 修复

- **终端 · WSL 文件侧栏**：本地 WSL 会话误显示 Windows 家目录；cwd 映射到 `\\wsl$\发行版\...` 并跟随切换；忽略切 shell 残留的盘符路径
- **终端 · 空目录 ls**：空目录命令回显不再被解析成伪目录项 `ls/`
- **终端 · 会话**：远程会话在 connections 未加载时被误清；会话 ID 复用导致灌入旧历史
- **终端 · AI 卡片**：浅色模式下卡片阴影与上下导航按钮配色过重/发黑

### 变更

- 本地文件面板支持 UNC（`\\wsl$`）面包屑与路径上一级；文件侧栏随本地终端 cwd 导航

## [0.7.2] - 2026-08-04

### 新增

- **开发 / 正式并存**：Agent Router / 内置 OmniMCP 默认端口错开（8766 / 12757 vs 8765 / 12756），避免 Dev 与正式版抢端口

### 变更

- **发版 CI**：修正 rust-cache 指向仓库根 `target/`；接入 sccache；`workflow_dispatch` 可只构建 Windows；release 显式关闭 LTO 并 strip 符号

## [0.7.1] - 2026-08-04

### 修复

- **启动 / 登录**：release 首启时前端早于 `AppState` 注册发起 IPC（如 `auth_login_qrcode`）导致 `state not managed`；改为先 `manage` 再创建 WebView
- **退出**：关闭主窗后快捷启动 / 模块预热隐藏窗残留进程；`app_exit` 强制销毁全部窗口，主窗 `Destroyed` 兜底退出

### 新增

- **开发构建**：独立 `OmniPanel Dev` identifier / 产品名 / DEV 角标图标与窗口标题，可与正式安装版并存

## [0.7.0] - 2026-08-03

### 新增

- **服务器 · 面板四域与 1Panel/宝塔打通**
  - 网站 / 应用 / 证书 / 计划任务四域完善；SSH 探测宝塔与 1Panel，支持一键开启 API 并写入面板连接
  - 1Panel **v1 / v2** 兼容：API 开关（`enable` / `Enable`）、`OrderBy`、监控 / 日志 / 任务接口自动回退
  - 无 `sqlite3` 时用 Python 读库取 ApiKey；禁止静默默认错误端口
  - 宝塔应用市场与应用图标处理增强；面板资源缓存过期自动回源
- **云厂商**：新增云资源侧栏与多云厂商图标 / 入口
- **SSH · tmux 远端会话治理**
  - tmux control mode 协议与会话管理；终端传输模式 UI；三段式安装与快捷启动文案
- **文件 · 跨连接传输**
  - 跨连接文件传输引擎；收藏 / 全局收藏与侧栏体验完善
- **快捷启动（Quick Launcher）**
  - 全局快捷键唤起；剪贴板实体识别；跨窗外观同步
- **AI**
  - `omni_ask_user` 结构化澄清表单；工具结果与上下文敏感信息脱敏
- **安全 · Vault**：凭据统一写入系统钥匙串，避免前端落盘明文
- **数据库**：SQL 结果预览与单元格交互；表预览分页大小；列宽与末列拉伸优化
- **窗口 / 侧栏**：模块窗 Snap Layout；小程序入口支持 H5 二维码；个人中心菜单合并
- **开发**：Tauri MCP Bridge，便于 Cursor 调试驱动桌面端

### 修复

- **侧栏**：恢复 `VerticalSplitSidebar` 的 `autoSize` / 高度持久化与段顶拖拽方向（误删回归）
- **终端**：WSL 会话误启为 PowerShell、路径显示；Blocks 孤儿 running 无法停止；OSC 133 退出码
- **SSH**：连接池死连接；浅色主题深色残留
- **数据库**：连接栏导入下拉按钮与旁路 icon 画风不一致
- **平台**：macOS EventLoop 非主线程启动崩溃；`gen:bindings` 堆溢出与 64 位类型导出；`tsc` / cargo 警告清理
- **发布**：Release / updater 下载端点与 User-Agent 对齐新仓库路径 `OmniUltraX/omnipanel`

### 变更

- 发版仍由 `v*` tag 触发 `.github/workflows/build.yml`：校验 OSS → Win/macOS 构建 → GitHub Release → 同步阿里云 OSS → OmniServer 微信广播
- 官网下载区继续消费 OSS `latest.json` / `versions.json`（与 updater 同源）

## [0.6.7] - 2026-07-29

### 新增

- **官网（`website/`）**
  - 首页整合下载区（OSS `latest.json` / `versions.json`，构建时镜像到 `public/releases/`）
  - 产品截图展示、中英切换、跟随系统的亮/暗主题
  - 联系区：企业邮箱 + 微信公众号二维码；修复 `gh_qrcode.jpg` 未打入静态资源导致 404
- **侧栏 · 小程序入口**：头像上方手机图标，悬停 popover 预览、点击居中弹窗展示小程序码
- **侧栏 · 用户菜单**：新增「访问官网」；设置项调整为菜单末项
- **AI · Surfaces / Harness**
  - 模块「问 AI」入口与建议 chips；Ask AI Composer
  - Harness 清单 / digest / 经验语料骨架；设置页 Harness 库存面板
  - 子会话集群取消传播与 child request context 对齐
- **服务器 · 宝塔面板资源创建**
  - 网站 / 数据库 / 证书 / 计划任务创建与网站编辑对话框
  - 网站 / 数据库 / 证书 / Cron 列表操作与缓存刷新增强
- **README**：补充 `docs/examples` 实机截图与官网 / Release 链接

### 修复

- **TypeScript**：`tsc -b` 通过（`TableDataGrid` 列宽 ref 类型、`TextInput` 只读字段、未使用 import）
- **官网 Logo**：修正无效占位 PNG，保证产品标识正常显示

### 变更

- 发版脚本维护 OSS `versions.json`；官网下载页与 updater 清单同源
- Agent 模块提示词（database / docker / files）与侧栏收起交互微调

## [0.6.6] - 2026-07-29

### 新增

- **客户端 ↔ 客户端数据同步（同账号）**
  - 按设备写入 OSS：`sync/{userId}/devices/{deviceId}/ai-conversations|modules/latest.json`
  - 本机数据变更自动上传快照（会话、连接、数据库、知识库、HTTP、工作区）；跨端改为手动导入
  - 侧栏头像菜单新增「数据同步」SubWindow：左侧其它客户端，右侧模块 Tab + 可折叠树形表格勾选导入
  - 知识库按文件夹树、连接按分组、HTTP 按集合→请求层级展示；勾选文件夹连带子项
- **任务中心 · 我的待办**：todo 列表 / 任务 / 步骤一等公民模型；智能视图与 UI 重构（迁移知识库待办）
- **终端 · 会话 Plan**：接通 `omni_plan_*`；标题栏悬浮展示进度与当前步骤

### 修复

- **数据库**：表横置空数据绘制；SQL 结果跨 Tab / 嵌套 dock overlay 穿透
- **知识库**：自建文档新建菜单文字叠压
- **客户端同步**：取消登录/冷启动自动 pull-merge，避免覆盖本机数据；导入后刷新侧栏与相关面板

### 变更

- 客户端同步与助手快照路径继续隔离（`sync/` vs `assistant/`）；模块快照仍可含 SSH/DB 密码明文以便多端恢复（不含私钥文件）
- 侧栏背景色统一为 `--bg`

## [0.6.5] - 2026-07-28

### 新增

- **助手 ↔ 客户端聊天通道**
  - 助手端写入 OSS 后 `POST /notify`，客户端 `GET /latest` + SSE `/wait` 收件并触发 AI Dock 生成
  - 聊天落盘协议升级为 **`omni-chat-sections.v1`**（分段 TAG 聚合，约 3s flush）
- **AI · Plan / 子会话集群**
  - Plan todolist 吸顶展示；子会话集群并发执行与取消传播
  - 默认 Agent 模式；审批展示统一；Token / 上下文用量展示增强
- **任务中心**：全局活动 / 待办 / 历史架构；批量操作完善
- **数据库 · SQL INSERT inlay**
  - `INSERT ... (cols) VALUES/SELECT` 在 value 前显示列名 tag（含反引号表名、`WHERE NOT EXISTS` 等）
  - 鼠标悬停 value 时高亮对应 field
- **数据库 · 表预览编辑**
  - 「新建行」在当前页底部插入可编辑 pending 行（不再弹表单）
  - 顶栏：列选择开关移至最左；移除独立「建表语句」按钮，右侧信息面板统一收展
- **文件 / OSS**
  - STS 文本上传；S3 / 阿里云 OSS 兼容增强
  - SSH 远程大日志流式预览；远程媒体 Range 边下边播
- **账号**：微信 / GitHub / 邮箱账号关联与解绑

### 修复

- **数据库网格**：Canvas 模式下 pending 新建行不显示；单元格编辑框与格子错位（锚点与 hitTest 同源）
- **AI Dock**：侧栏开合导致左右分栏列宽错乱
- **终端**：AI 命名返回思考链、SSH 首命令卡死、localStorage 配额等问题
- **TypeScript**：清理 `erasableSyntaxOnly`、未使用变量与类型收窄等编译错误，保证 `tsc -b` 通过

### 变更

- SSH 能力并入终端模块；Agent 提示词与工具路由持续整理（Plan / Run / 模块 Agent）

## [0.6.2] - 2026-07-23

### 新增

- **助手端元数据同步（`omnipanel-assistant`）**
  - 新增传输内核 crate：采集脱敏元数据 → 申请上传凭证 → OSS PUT → `POST /api/assistant/snapshots/notify`
  - 快照 schema v2：每次写入独立目录，含 `overview.json`（各模块 count + objectKey）与 8 个 `modules/{id}.json`（terminal / database / docker / files / server / knowledge / protocol / tasks）
  - 支持永久 AK（空 `securityToken` / `expiration`）与 `cname` 虚拟主机风格 PUT；有 STS token 时才带 `x-amz-security-token`
  - Tauri 命令 `assistant_push_snapshot`；登录后模块元数据变更自动 debounce（5s）推送，绑定成功立即推一次；设备页仅保留说明文案，无手动试组装/推送入口
- **助手端绑定 UI**：绑定按钮移至助手端标题右侧；二维码在窗口内联展示，不再使用独立弹窗

### 修复

- **助手端绑定**：出码时 `X-App-Id` 兼容 `omni-client` 与历史 `default`，避免本机设备已落库仍报 `client device not found`
- **AI Dock 调宽卡顿**：拖拽中仅用 `requestAnimationFrame` 更新 `--ai-dock-w`，松手再写入 store / 持久化，宽度仍实时跟随鼠标
- **数据库 · 关闭 Tab**：禁止在 `setWorkspaceTabs` updater 内调用 `activateWorkspaceTab`，消除 `Cannot update a component while rendering a different component`（DatabaseSchemaSidebar）
- **数据库 · 删除选中行**：行选区判定与工具栏删除对齐；仅整行全选才计入「删除选中」
- **i18n**：修复 `knowledge.search` 重复键导致的类型错误

### 变更

- 助手端同步路径改为「元数据变更自动上传」；敏感字段（密码、私钥、Token 等）不进入快照，上传凭证不落盘

## [0.6.0] - 2026-07-21

### 新增

- **账号体系**
  - 启动登录页（微信扫码；GitHub / 邮箱 / 手机预留入口）
  - 个人中心：资料（昵称 / 头像）、设备列表与删除、订阅入口
  - 侧栏底部用户入口与快捷菜单
- **协议实验室 · HTTP 环境**
  - 环境管理改为 SubWindow 左右布局（列表 + 配置）
  - 环境支持与请求面板一致的认证方式；发送时请求认证优先于环境认证
- **AI / 终端 / 数据库 / Docker / 服务器**
  - AI Dock、联网工具路由、Composer @ 上下文、自我进化与资源档案等能力持续增强
  - 终端补全 / 历史持久化 / Feed 搜索等体验优化
  - 数据库表数据网格、Schema、连接与监控多项增强（含 Qdrant 等）
  - Docker CLI 执行、镜像搜索、Compose 与连接反馈增强
  - 服务器第三方服务侧栏分类、SSL / 定时任务等能力扩展
- **壳层**
  - 窗口几何记忆与多屏幕恢复
  - 快捷启动面板、多快捷键绑定与跨功能跳转

### 变更

- **子模块解耦**：`miniapp` / `agent` 不再作为本仓库 submodule；CI 不再拉取子模块。本地 OmniAgent 独立目录为 `D:/project/omniagent`（开发态回退路径 `../../omniagent`）

### 修复

- **侧栏头像**：已登录冷启动时侧栏不显示头像；打开个人中心后才恢复。现于启动 splash 与 App 挂载时同步拉取用户资料
- **登录等待**：扫码 SSE 可恢复断开不再刷控制台错误日志
- 终端命令历史刷新丢失、数据库 Tab / flushSync、Docker 连接与表格交互等多处稳定性问题

## [0.5.0] - 2026-07-13

### 新增

- **OmniPanel 官网（`website/`）**
  - 基于 Vite 的静态营销站点，含 Hero、模块介绍、AI 原生、工作流、技术架构等区块
  - 支持 GitHub Pages 部署（`.github/workflows/deploy-website.yml`），默认 base 路径 `/omnipanel/`
- **Docker · 容器日志**
  - 日志查看器支持**跟踪**（实时流 / 1Panel 轮询）、**下载**、**清空**、**时间范围筛选**（15m / 1h / 6h / 24h / 7d）
  - 操作按钮与刷新统一放在 `log-viewer-panel__footer` 右侧，使用图标按钮
  - 后端新增 `DockerLogQuery`（`tail` + `since`）、`docker_clear_container_logs` IPC；1Panel 跟踪改为轮询 `download/log`
- **Docker · 容器 Dock 页**
  - 左侧 exec 区域拆为上下分屏：**上日志、下终端**，默认各占 50%，可拖拽调整
  - 连接级 Dock 面板按**服务组**分区展示，未分组容器单独区块
- **Docker · 侧栏拖放**
  - 容器拖入服务组改用 **Pointer 事件**（兼容 Tauri WebView2 不触发 HTML5 DnD 的问题）
  - 拖动已选中的容器时，支持**多选批量**归入目标服务组
- **数据库 · 慢查询日志**
  - 慢查询日志面板重构：支持 SSH 远程拉取、分页/筛选、LogViewer 展示与工具栏操作
- **跨窗口拖拽 · z-order 命中**
  - 新增 `window_z_order` 命令（Win32 EnumWindows），跨窗拖拽按窗口叠放顺序正确命中目标
- **终端 · 后端会话运行时状态**
  - 新增 `terminalBackendStateStore`，统一管理 pending/injected 后端会话状态，附带单元测试

### 改进

- **AI 工具注册表统一（单一真相源）**
  - 内置工具的名称 / 模块 / 描述 / 参数 schema / 执行类型集中定义于后端 `omnipanel-store` 的 `BUILTIN_TOOL_SPECS`，杜绝前后端与各注入路径的 schema 漂移
  - 工具 schema 落库（`mcp_tools.input_schema`），HTTP 直连、ACP、OmniMCP 三条路径共用同一份定义
  - ACP client-tools 的可用工具清单改为按内部 registry 动态生成（随开关 / 模块状态变化），修复终端工具参数为空 `{}` 的问题，并支持数据库等 UiDelegated 工具经 ACP 调用
  - `load_skill` 纳入统一 registry 管理（遵循开关与模块判定），不再无条件注入
- **侧栏树交互统一**：`SidebarTreeNode` 单击仅选中/预览，**双击**才激活并打开面板（Docker 容器、终端会话等）
- **服务器监控**：`ServerMonitorTab` 轮询逻辑简化，不再限制仅 1Panel 类型才刷新仪表盘
- **代码清理**：移除 `OnePanelClient.get_text`、未使用的 `collect_table_sync_sql` 等 dead code

### 变更

- **对外暴露收紧**：仅后端可直执（Native）工具允许经 OmniMCP 对外暴露；对 UiDelegated（终端 / 数据库）工具或未打开模块下的工具开启 external 暴露将被拒绝
- **模块状态联动**：模块由关闭重新打开时自动恢复其下工具为可用；前端工具目录同步（`mcp_tool_sync_catalog`）不再覆盖内置工具描述（以后端 spec 为准）

### 修复

- **1Panel 容器日志**：批量拉取改走 `POST /containers/download/log`，修复误用 SSE 搜索接口导致获取失败
- **跨窗口拖拽**
  - 修复多窗口重叠时 ghost 误激活到非目标窗口
  - 修复原生 dockview 分屏拖拽在跨窗取消后 `pointerup` 不触发 drop 的问题
  - 工作区弹出独立窗口时，主窗若停留在该工作区路由则自动导航回首页，避免右侧空白
- **Docker 连接对话框**：1Panel 来源配置表单精简

## [0.4.2] - 2026-06-25

### 新增

- **预览 Tab**
  - Schema 树单击打开表数据预览 Tab（斜体标识），双击升级为常驻 Tab
  - Dock Tab 双击可将预览 Tab 固定为常驻
  - 预览槽在切换表时就地复用，避免反复创建/销毁 Tab
- **数据库 · 表数据网格**
  - 左侧可折叠「列选择」侧边栏：全选、搜索、列显示/隐藏
  - 点击列名可滚动定位并高亮对应列（转置模式下定位到对应行）
  - 分页栏左侧按钮控制列选择栏展开/收起
- **工作区空态**：数据库工作区统一使用 `WorkspaceEmptyPage`，支持展示最近关闭的 Tab 并一键恢复

### 改进

- **Schema 浏览性能**
  - 单击/双击区分延迟优化至 200ms
  - `countTable` 与数据预览并行加载，先展示数据再更新总行数
  - Schema 缓存预热列元数据，减少重复 introspect
  - 激活连接切换增加短路判断，减少无效状态更新
- **Dock 同步**：Tab meta（预览状态、标题等）在 layout 阶段同步，标签头更新更及时
- **终端**
  - 右侧 Dock 侧栏 Tab 改为竖排显示，修复 group 宽度收缩链路
  - 侧栏布局持久化；进程列表在侧栏内自适应并支持横向滚动
  - 模块重新可见时自动恢复 ResizeObserver、fit 与焦点，切换更稳定
- **设置 · 软件更新**：标题、当前版本与操作按钮（含下载进度条）同一行展示，更新日志独立占一行
- **自动更新**：增加 GitHub Release 镜像 endpoint 作为备用检查源（主源不可用时自动 fallback）

### 修复

- 修复预览 Tab 升级为常驻后斜体样式未及时刷新的问题

---

## [0.4.1] - 2025-06-24

### 新增

- **AI 场景设置**：支持为不同使用场景（如对话、补全等）分别指定默认模型
- **数据库 · Schema 侧栏**
  - 连接/文件夹布局：可新建文件夹，通过拖放整理连接与文件夹层级
  - 「全部收起」一键折叠 Schema 树
  - Schema 树虚拟滚动重构，大数据量下更流畅
- **数据库 · 表预览与网格**
  - 单元格预览抽屉：支持 JSON 结构化展示与网页 URL iframe 预览
  - 表头 tooltip 显示字段注释；非空列显示 `NN` 标记
  - 表预览状态持久化：隐藏列、行转列、排序、过滤等在 Tab 关闭后恢复
  - 分页查询与结果集导航增强
- **数据库 · SQL 编辑器**
  - SQL 格式化
  - 可自定义 SQL 编辑器字体（设置面板）
  - 自动补全逻辑增强，提示更准确
- **工作区 / Dock**
  - Dock 面板布局持久化，重启后恢复分屏结构
  - 表预览、SQL 等工作区 Tab 状态迁移与管理优化

### 改进

- 统一工作区「添加到面板」操作的修饰键逻辑，面板标题提示更准确
- Redis 查询结果表格支持纵向滚动
- 后端 `DbColumnMeta` 补充 `nullable`、`comment` 字段，供表头与预览使用
- 移除已废弃的 Ctrl 复制面板相关逻辑，简化代码路径

### 修复

- 修复 Dock Tab 批量关闭（关闭左侧/右侧/其他/全部）后 Tab 栏残留、内容已删但标签仍在的问题
- 修复「关闭右侧/左侧」误关当前 Tab 的索引错位问题
- 修复关闭 Tab 时 `duplicate key`、`invalid location` 等 Dock 布局冲突
- 修复 Tauri 桌面端 Schema 连接拖放无效（改用 Pointer 事件实现，兼容 WebView2）

### 构建

- GitHub Actions 增加 **macOS (Apple Silicon / aarch64)** 构建目标

---

## [0.4.0]

详见 [GitHub Release v0.4.0](https://github.com/OmniUltraX/omnipanel/releases/tag/v0.4.0)。
