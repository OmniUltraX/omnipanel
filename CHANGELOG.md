# Changelog

本文件记录 OmniPanel 各版本的 notable 变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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

详见 [GitHub Release v0.4.0](https://github.com/chaojimct/omnipanel/releases/tag/v0.4.0)。
