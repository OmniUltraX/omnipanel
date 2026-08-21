## ADDED Requirements

### Requirement: 发现总线 prod 闸语义

发现总线 SHALL 维持「prod 主机不发起真实探测」的策略：`env_tag` 为 prod / prod-* / production 的 SSH 主机 MUST 在进入 probe 前被过滤，并在结果中以跳过计数呈现。后端 `discovery_run` MUST NOT 包含永不执行或与前端策略重复的占位分支；其职责限于任务中心登记、进度与取消令牌。

#### Scenario: prod 主机只计数不探测

- **WHEN** 用户对含 prod 标签主机的连接集运行 SSH 扫面板/扫 Docker
- **THEN** prod 主机不出现在 probe 的 hostIds 中
- **AND** 预览结果展示 skippedProdCount，且不产生任何针对 prod 主机的网络请求

#### Scenario: 后端无死分支

- **WHEN** 审查 `discovery_run` 实现
- **THEN** 不存在依赖前端永远不会发送的 `env_tag=prod` scope 才能触发的分支
- **AND** 命令行为与任务中心展示一致

### Requirement: 发现任务取消联动

任务中心对发现任务的取消 SHALL 联动到前端实际执行的 probe：probe 执行方 MUST 订阅任务取消状态（事件或轮询任务接口），取消后 MUST 停止产出新候选行并以「已取消」结束任务；已完成的批次结果可保留但 MUST 标记未完整。

#### Scenario: 取消后不再产出候选

- **WHEN** 用户在扫描多台主机途中点击任务中心的取消
- **THEN** 剩余主机的 probe 被跳过
- **AND** 任务最终状态为已取消，预览不呈现取消后新增的行

#### Scenario: 正常完成不受影响

- **WHEN** 任务未被取消并跑完全部主机
- **THEN** 任务成功收尾
- **AND** 候选行完整呈现

### Requirement: 导入候选去重归一化

面板类导入候选的既有连接判定 SHALL 对 `serviceType` 做插件 id 归一化（legacy 别名 bt/baota/1panel/onepanel 与对应插件 id 等价）后再比较；Host API upsert 兜底去重与预览层去重 MUST 使用同一归一化规则。命中既有连接时 upsert MUST 更新原连接而非新建。

#### Scenario: legacy 面板连接不重复导入

- **WHEN** 某主机已存在 `serviceType:"1panel"` 的旧面板连接，再次执行 SSH 扫面板并确认导入
- **THEN** 结果为更新或跳过该连接
- **AND** 连接列表中不出现同主机的第二条 1Panel 面板连接

#### Scenario: 预览与落库判定一致

- **WHEN** 预览层将某行标记为 duplicate
- **THEN** Host API upsert 对同一候选的兜底判定结论一致
- **AND** 不出现「预览判重但落库新建」的分叉

### Requirement: Warpgate 示例数据诚实标注

在远程拉取实现落地前，Warpgate 导入向导 SHALL 明确标注当前加载的是示例数据（mock）；Token 输入 MUST NOT 触发「已加载远程」类误导性成功提示。导入统计 SHALL 区分新增与更新计数。

#### Scenario: mock 标注可见

- **WHEN** 用户打开 Warpgate 向导并加载候选
- **THEN** 界面明确提示当前为示例数据
- **AND** 不因输入了 Token 而声称已连接远程

#### Scenario: 统计区分新增与更新

- **WHEN** 导入包含已存在与全新的候选各若干
- **THEN** 结果统计分别给出 updated 与 added 计数
- **AND** 全部计入 added 的旧实现被移除
