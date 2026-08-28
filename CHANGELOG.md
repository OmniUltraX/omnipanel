# Changelog

本文件记录 OmniPanel 各版本的 notable 变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 新增

- **数据库 · sidecar 引擎**：ClickHouse / MongoDB / SQL Server 走独立 sidecar；Redis 走进程内；DBX 插件（Oracle、达梦、Hive 等）可装即用
- **数据库 · 方言家族工作台**：Oracle 系 / PG 系 / MySQL 系 / Hive 系补齐库列表统计、表详情、用户与表设计，不再因「不支持的数据库类型」残缺工作区
- **数据库 · 瀚高身份**：已激活瀚高插件时把历史 `ys-highgo4.5` 纠正为 `highgo`；有插件则禁止静默回退 PostgreSQL
- **数据库 · JDBC 编码**：sidecar JVM UTF-8；错误文案按 GB18030 回退，避免中文乱码
- **数据库 · SQL Server 工作台**：建库、删表、克隆、用户，以及会话 / 配置只读
- **数据库 · sidecar 建库与会话**：PG / 达梦等按家族打开建库与连接信息；慢查询走方言视图（Binlog 仍仅 MySQL）
- **数据库 · Neo4j / Cassandra**：树分别为 graph / keyspace，编辑器接 Cypher / CQL
- **数据库 · 目录引擎**：可安装金仓 / Vastbase / UXDB；OceanBase 走目录实有 key（`oceanbase-oracle`）；GaussDB / TiDB 目录无包则跳过
- **数据库 · Docker 本地种子**：幂等写入本机 9 条测试连接（密码进 Vault，列表不落明文）
- **数据库 · MCP 工作台对齐**：建库 / 用户列表 / 表预览 / 字符集与工作台同一后端路径（`create_database` / `list_users` / `preview_table` / `list_character_sets`）

### 修复

- **数据库 · 可选 DBX 引擎**：先查官方目录再安装，目录无 `tidb` / `gaussdb` / `oceanbase` 时不再抛 IPC `notFound`
- **数据库 · PostgreSQL 结果解码**：`INT2`/`INT4`/`FLOAT4`、时间戳、`NUMERIC`、常见数组与 `UUID` 按实际类型解码，不再把 `SELECT 42` / `now()` / `1.25::numeric` 变成 `null`
- **数据库 · MySQL TEXT/DESC**：协议报成 BLOB 的文本列按 UTF-8 文本返回，不再编成 blob 结构
- **数据库 · MySQL DECIMAL**：字面量 `1.25` 按十进制解码，不再变成 `null`
- **数据库 · SQL Server 日期时间**：`GETDATE()` / `DateTime2` 等返回可读日期，不再输出 Debug 结构体
- **数据库 · MCP 库列表**：按连接 id 或名称解析；走统一 `db_list_databases`（含 PG / SQL Server / ClickHouse / Mongo / Redis）
- **数据库 · MCP 表结构**：复用 introspect（含 SQL Server / ClickHouse / Mongo / sidecar）
- **数据库 · MCP 会话**：SQL Server 支持 processlist / 慢查询；PG 无 `pg_stat_statements` 时回退 `pg_stat_activity`
- **数据库 · Mongo shell**：`show collections` / `show dbs` / `db.<集合>.find()` 可执行
- **数据库 · Redis / Neo4j 查询**：编辑器不再把 Redis 命令包成 SELECT；Neo4j 数字字符串还原为 JSON number
- **终端 · Shell Agent 浮层**：xterm 视口刷新不再反复 setState，避免思考卡/工具条死循环

## [0.8.8] - 2026-08-25

### 新增

- **同步加密 v2**：团队 `sync_key_v2` 替代 SyncMasterKey 驱动模块快照加解密；支持导出/导入 `.omnipanel-sync.key`
- **同步密钥中继**：新设备登录后经 omniserver 向在线设备请求密钥；无在线设备时引导导入密钥文件
- **助手绑定 v2**：PC 生成助手密钥对，二维码加密私钥；小程序扫码确认后本地安全存储
- **助手摘要加密**：PC 推送快照时额外上传 `assistant-payload` 加密信封，仅绑定助手可解密

### 变更

- **同步认证 UI**：`SyncTeamKeySetupDialog` 替代旧扫码配对对话框；设置页新增团队同步密钥管理
- **小程序**：移除「同步安全」扫码传钥入口；绑定流程支持 v2 二维码解密私钥

### 兼容

- **拉取**：仍可读旧版 `omnipanel-sync-e2e-v1` 信封；新版本写入 v2 scheme

---

## [0.8.7] - 2026-08-24

### 新增

- **插件开放平台**：单源注册表、`.omni-plugin` 签名包安装、L2 双引擎（QuickJS / WASM）与 L3 沙箱 Overlay UI；Host SDK 与开发者文档就绪
- **插件 Host**：内置插件清单、设置开关与运行时写穿；面板 / Docker / 导入走统一发现预览
- **云厂商 · 地域发现**：展开阿里云账号后按实例探测有资源的地域，不再只显示手选区域
- **同步 · SyncMasterKey**：新设备经小程序扫码配对入网；在线主设备自动密文传钥
- **同步 · 模块快照**：SSH / Docker / 数据库 / 协议文件夹树纳入推送与拉取；上传后 peek 以本机快照为准

### 变更

- **同步认证**：多客户端仅保留扫码授权传钥，移除动态码兑换与本地导入/复制密钥 UI
- **模块窗口**：取消启动时模块窗预热，首次打开对应模块再创建，降低常驻内存

### 修复

- **数据库 · 远程导出**：团队同步后 SSH 池未刷新导致「未知 SSH 资源」；现按需从 Storage 加载、同步后 reload，导出前校验 SSH 就绪
- **团队同步 · 预览表**：上传模块快照后表格仍像旧数据；peek 树改用侧栏文件夹 JSON，after_upload 以本机为准
- **插件 Overlay**：无条目时读取 `pluginId` 导致页面崩溃
- **阿里云 · ECS 空列表**：默认杭州无机器时侧栏仍只显示杭州；现自动列出账号下有 ECS / 轻量的地域
- **终端**：直通模式滚动、链接识别与 NL 占位提示

---

### 新增

- **团队 · 侧栏切换**：头像上方可切换当前同步团队；切换前落盘旧团队快照，再拉取并替换本地
- **团队 · 管理窗口**：独立团队管理子窗口（编辑入口不再挤进用户中心）
- **同步 · 资源标签**：连接 / 数据库 / 知识库等支持 `tags`；推送时自动补当前设备名
- **表数据预览 · 查询历史**：WHERE / ORDER BY 按表记忆，↑/↓ 回填历史条件
- **终端 · 路径点击**：输出中的文件路径可点击打开预览 / 定位
- **AI · harness**：统一提示词分层与工具路由，终端路径与 Agent 协作更一致

### 变更

- **同步 · 端到端加密**：`modules/latest.json` 与 `ai-conversations/latest.json` 整包加密后再写团队 OSS；拉取兼容历史明文
- **同步 · 凭据隔离**：密码不再进入 modules 快照；个人多设备凭据走 secrets vault；自定义团队不同步密码
- **同步 · 成员校验**：显式 `teamId` 必须属于 `/api/me.teams`，禁止越权访问他队快照
- **同步架构**：快照从账号路径改为团队 OSS（`team_sync/{teamId}/`），个人团队与协作团队统一通道

### 修复

- **Dock · 关 Tab**：增量同步布局，避免关页签时清空其他终端会话
- **终端 · 思考卡**：修复死循环与最后一轮思考被结果卡顶替
- **终端 · IME / 切 Tab**：修复 Tab 切换乱码与输入法回车误触；Ubuntu 26 中文输入不再变成 readline `(arg: 4)`
- **终端 · 确认卡 / 复制粘贴**：命令单行折叠、结果卡测高与复制粘贴样式优化
- **任务卡**：修复撑满布局与后台任务行被裁切

## [0.8.3] - 2026-08-18

### 新增

- **SQL 编辑器 · 跳转到表**：Ctrl/Cmd+点击表名或表别名，打开对应表数据面板
- **SQL 编辑器 · 字号缩放**：Ctrl/Cmd+滚轮按档缩放，与工具栏字号选择同步
- **数据库 · 库名**：创建与校验允许名称中间使用连字符（如 `edu-center`）
- **工作区 · 自定义面板**：关闭 Tab 不再删除面板，可从「+」菜单再打开；右键「删除面板」才真正删除
- **数据库 · 导出**：弹窗展示源连接 / 源库；目标连接与目标库同行布局；目标库可搜索输入，不存在时标「将新建」

### 变更

- **SSH · 侧栏**：与数据库 / 服务端 / 协议对齐——主机列表吃剩余空间，隧道与密钥按内容自适应并记忆高度
- **SQL 编辑器 · INSERT 高亮**：列名与值的配对高亮跟随文本光标，不再跟随鼠标悬停

### 修复

- **MySQL · 跨库导出**：Docker 容器内 dump / count / import 使用 `--password="$MYSQL_PWD"`，避免 `-p` 空密码导致 1045（using password: NO）

## [0.8.2] - 2026-08-17

### 新增

- **服务器 · 应用安装日志**：面板应用安装过程可打开安装日志对话框，跟踪进度与失败原因
- **数据同步 · 账号级快照**：登录后拉取账号级云端快照，多端共享同一份同步数据（不再按设备分片）

### 变更

- **数据同步**：由设备级推送改为账号级 pull；移除个人中心 DataSyncPanel 与按设备导入路径
- **SSH · 侧栏**：主机 / 隧道分区支持可拖拽高度记忆，并按内容自适应初始高度
- **侧栏布局**：`VerticalSplitSidebar` 支持分区 body 高度持久化与用户拖拽标记

### 修复

- **Docker · SSH 绑定**：启动期短暂等待已绑定 SSH 建连完成，再决定是否弹窗，减少误报与重复确认

## [0.8.1] - 2026-08-14

### 新增

- **团队 · 管理与 OSS 同步**：邮箱搜索添加成员；团队数据预览；同步排除项管理；自定义面板可分享给团队成员
- **Redis · 应用内控制台**：Redis 连接可打开应用内 Redis 控制台，运维面板体验优化
- **SSH · 进程监控**：主机概览与进程轮询增强；进程详情命令行解析与缓存
- **宝塔 · Java 项目**：Java 项目监控与相关 UI 组件
- **数据同步**：DataSyncPanel / TeamDataTree 交互与展示优化
- **数据库 · 表网格**：统一列标题格式与样式

### 变更

- **团队同步**：支持静默加载；移除局域网发现，改接团队管理与 OSS 同步
- **宝塔**：鉴权失败冷却与错误提示优化
- **API**：API Key 处理与输入组件增强

### 修复

- **Dock · 设置下拉**：打开设置页数据库字体大小等下拉时，自定义窗口标题栏（`dv-tabs-and-actions-container`）不再消失
- **终端 · PowerShell**：结果卡结束后补画提示符；Shell Agent 执行后布局与光标落点
- **云开发**：预览模式改标准云开发模式，规避 8686 端口检测时序死锁

## [0.8.0] - 2026-08-12

### 新增

- **工作区 · 自定义监控面板**：首页支持新建自定义面板，基于网格布局自由摆放监控小组件（`react-grid-layout`）
- **工作区 · 监控小组件**：主机资源、Docker 容器 / Compose、MySQL / Redis 概览等可配置数据源与尺寸的小组件
- **Docker · 宝塔面板**：Docker 连接支持宝塔 BT Panel 来源；一键从 SSH 探测导入（1Panel > 宝塔 > 裸 Docker）
- **Docker · 侧栏分组**：Docker 专用嵌套树分组（新建 / 拖放 / 持久化），多选热键对齐协议侧栏
- **Redis · 可视化运维**：Stream 等键类型运维布局与键值预览增强
- **状态栏 · 模块日志**：错误日志可点开弹窗查看全文、一键复制；左侧清除按钮；超长文案省略号截断

### 变更

- **Docker**：宝塔 API 鉴权失败 / 临时封禁增加熔断与串行请求，避免并发把「验证失败」计数打满导致封禁 1 小时
- **工程**：清理 `omnipanel-docker` / `omnipanel-server` 项目内 `cargo check` 警告

### 修复

- **数据库 · 表预览表名**（#48）：顶栏展示可框选 / 一键复制的 `库.表` 标识
- **数据库 · 空结果残留**（#47）：过滤无结果时写入空行缓存，不再回退显示上一次查询数据
- **数据库 · macOS 横滚**（#46）：修正 Canvas 横向内容宽度与 overscroll，避免滚过右侧空白区
- **宝塔 / Docker**：面板锁 IP / 密钥错误时停止无效重试与轮询，状态栏可见错误详情

## [0.7.17] - 2026-08-11

### 修复

- **CI · Docker Web**：`docker-web.yml` 的 step `if` 误用 `secrets` 上下文导致工作流校验失败（0s Invalid workflow file），tag 发版无法构建镜像；改为 env 判断 `PACKAGES_TOKEN`

## [0.7.16] - 2026-08-11

### 新增

- **数据库 · 内置演示连接**：启动时自动注入「OmniPanel 元数据库」与「文件索引库」两条本地 SQLite 连接（桌面 / Web 共用）；用户删除后写入 tombstone，不再自动恢复
- **官网 / README**：补充 Web 版多平台一键部署入口（Render / Zeabur / Railway / Koyeb / DigitalOcean / Fly.io）及部署配置

## [0.7.15] - 2026-08-11

### 新增

- **数据库 · 侧栏查询**：左侧顶栏新增「查询」入口，打开不落文件的单例 SQL 草稿编辑器；关闭后再打开可恢复上次内容（连接/库/光标位置一并恢复）
- **表数据预览 · WHERE / ORDER**：查询栏支持一键清空过滤与排序条件

### 变更

- **数据库**：移除「数据字典」入口、对话框与本地持久化实现

### 修复

- **数据库结果精度**：VARCHAR / 文本中的大整数经 JSON 传到前端时不再被解析成 JS number 丢精度（MySQL / PostgreSQL / SQLite / Mongo 共用安全解码）
- **Schema 侧栏搜索**：不再只搜已展开节点；已加载 schema 缓存内的表/列/索引等均可命中并展示路径（#43）
- **macOS 表预览残影**：切换库列表等 Tab 时 canvas 合成层残影；非激活预览隐藏并清空位图，切回强制重绘（#44）
- **测试**：修复 vitest 环境下 `aiModelsStore` 读取 `import.meta.hot.data` 为 undefined 导致套件无法加载

## [0.7.14] - 2026-08-11

### 新增

- **系统托盘 · 打开工作区**：右键菜单增加「打开工作区」子菜单，列出全部工作区；点击后聚焦独立窗或进入主窗全屏，工作区变更时菜单自动刷新
- **助手 · AI 模型 / 终端指令**：模型元数据上报与远程设模通知；助手端可唤起桌面终端会话（openOrFocus）
- **聊天 OSS**：`chatOssRecorder` 处理 `turn_end` 事件，完善回合结束落盘
- **文件 · 详情侧栏**：详情侧栏展开态全局持久化
- **架构**：抽取 `omnipanel-bg` / `omnipanel-db-sync` / `omnipanel-server` 等无 Tauri 共享模块，对齐 Web / 桌面双端

### 变更

- **侧栏顶栏**：macOS / Windows 左侧壳侧栏宽度统一为 56px；两侧均增加与 Tab 栏同高的顶条，顶栏视觉贯通全窗
- **工程规范**：清理 transfer / db-sync / src-tauri 未使用 import 与死代码，`cargo check` 无项目内警告

### 修复

- **macOS 设备名**：GUI 下无法读到 `HOSTNAME` 时改为 `scutil` / sysinfo；非 ASCII 电脑名百分号编码上报
- **半屏工作区**：空态顶栏 spacer 不再拖拽控制 OS 窗口；半屏双击顶栏不再误触全屏切换
- **类型**：`terminalCmdInbox` 改用 `tab.sessionId`，修复 `TerminalSessionInfo` 无 `id` 的 `tsc` 错误

## [0.7.13] - 2026-08-10

### 新增

- **反馈群二维码**：官网联系区与客户端侧栏小程序弹窗支持「反馈群」入口；服务端公开图与管理上传
- **版本更新**：头像菜单增加「版本更新」；启动检测更新，弹窗展示 changelog 并可立即更新 / 暂时跳过
- **macOS 窗口控件**：无边框窗口按平台适配——Windows 右上角三键，macOS 左上角原生风格红绿灯（主壳侧栏顶 / 独立窗 Tab 前缀）

### 变更

- **模块左侧栏**：最大宽度改为应用宽度的 40%（可拖拽，窗口变窄自动钳制）
- **macOS 顶栏**：红绿灯区与 Tab 栏同高对齐；右侧 AI 入口取消 Windows 窗控占位空白；快捷键提示改为 ⌘

### 修复

- **侧栏 / 表预览**：侧栏主次文字色与 schema 树贴边；表数据预览默认光标调整

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
