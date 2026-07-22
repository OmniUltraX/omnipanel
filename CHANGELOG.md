# Changelog

本文件记录 OmniPanel 各版本的 notable 变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
