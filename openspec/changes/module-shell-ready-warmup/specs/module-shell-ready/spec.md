## ADDED Requirements

### Requirement: 叠层模块分阶段就绪

系统 SHALL 将每个叠层模块（`terminal`、`database`、`docker`、`files`、`server`、`protocol`、`workflow`、`knowledge`、`tasks`）的就绪状态划分为 ChunkReady、ShellReady、ContentReady 三档，并且 MUST NOT 在应用启动的首帧同步将全部模块置为 ShellReady。

#### Scenario: 首帧不全量挂壳

- **WHEN** 应用冷启动且落地路由为首页（Dashboard）
- **THEN** 系统 MUST NOT 在同一同步任务中将全部叠层模块的 Overlay 置为已挂载
- **AND** 首页首屏交互 MUST NOT 被全量模块 mount 阻塞

#### Scenario: 空闲推进到 ShellReady

- **WHEN** 应用完成首屏并可进入空闲调度
- **THEN** 系统 SHALL 错峰预拉取各叠层模块 JS chunk，并错峰请求挂载各模块 Overlay 壳（ShellReady）
- **AND** 挂壳更新 MUST 经低优先级过渡（如 `startTransition`），避免打断用户输入

### Requirement: 悬停与空闲预热协同

系统 SHALL 保留侧栏导航悬停预热，并与空闲全量 Shell 预热共用去重逻辑：已 ShellReady 的模块 MUST NOT 重复挂载。

#### Scenario: 悬停提前挂壳

- **WHEN** 用户指针在侧栏某叠层模块入口停留超过预热阈值
- **THEN** 系统 SHALL 预拉取该模块 chunk，并请求将该模块 Overlay 置为已挂载
- **AND** 若路由尚未切换到该模块，该模块 MUST 保持 suspended（非 live）

#### Scenario: 已挂载则跳过

- **WHEN** 某模块已处于 ShellReady
- **AND** 空闲队列或悬停再次请求预热该模块
- **THEN** 系统 MUST 跳过重复挂载，不卸载重建 Overlay

### Requirement: ShellReady 时禁止 Live 重活

当叠层模块已挂壳但路由未激活（或显式 suspended）时，系统 MUST NOT 启动该模块的 Live 重活，包括但不限于：Docker 容器/stats 轮询、为会话创建 xterm 实例、数据库连接池按 live 路径注册、Schema 远端全量刷新。

#### Scenario: 预热挂壳不建 xterm

- **WHEN** 终端模块因空闲或悬停达到 ShellReady，且当前路由不是 `/module/terminal`
- **THEN** 系统 MUST NOT 为终端会话创建新的 xterm 实例

#### Scenario: 预热挂壳不跑 Docker 轮询

- **WHEN** Docker 模块达到 ShellReady，且当前路由不是 `/module/docker`（模块非 live）
- **THEN** 系统 MUST NOT 启动容器列表或 stats 的周期性轮询

#### Scenario: 进入模块后恢复 Live

- **WHEN** 用户导航到已 ShellReady 的模块路由使模块变为 live
- **THEN** 系统 SHALL 按该模块既有逻辑启动所需的 Live 行为（如终端可见 session 的 xterm、Docker 轮询等）

### Requirement: 允许空闲本地只读预取

系统 MAY 在模块非 live 的 ShellReady 之后，于空闲时段执行本地只读预取（例如连接列表或侧栏磁盘缓存 hydrate）。此类预取 MUST NOT 触发远端全量 Schema 刷新或 Docker Engine 轮询。

#### Scenario: 本地缓存预取不触发轮询

- **GIVEN** Docker 模块已 ShellReady 且非 live
- **WHEN** 系统执行侧栏本地缓存的只读 hydrate
- **THEN** 系统 MUST NOT 因此启动 stats/容器列表轮询
