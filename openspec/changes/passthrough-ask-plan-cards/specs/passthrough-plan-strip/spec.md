## ADDED Requirements

### Requirement: 直通模式 Plan 吸底进度条

在终端直通模式下，当会话存在进行中的 `omni_plan_*` 计划时，系统 MUST 在终端 pane 视口底部展示固定高度的 live 进度条；进度更新 MUST 刷新该条内容，且 MUST NOT 因 PTY 大量输出而滚出可见区。

#### Scenario: 创建计划后出现吸底条

- **WHEN** 直通会话成功执行 `omni_plan_create` 并产生可订阅的 plan
- **THEN** 当前终端 pane MUST 在底部显示进度条，展示进度分数与当前步骤摘要

#### Scenario: 步骤更新只刷新同一条

- **WHEN** 同一 plan 发生 `omni_plan_update_step`（或等价状态变更）
- **THEN** 系统 MUST 更新吸底条上的进度与当前任务文案，且 MUST NOT 默认再插入一张新的流内进度 decoration 卡

#### Scenario: 长输出后仍可见

- **WHEN** 计划执行期间终端 buffer 产出大量输出导致视口滚动
- **THEN** 吸底进度条 MUST 仍固定可见于 pane 底部（不随 xterm scrollback 卷走）

#### Scenario: 点击查看详情

- **WHEN** 用户点击吸底条（或详情入口）
- **THEN** 系统 MUST 展示完整计划条目（复用 PlanView 或等价详情），包含各步骤状态

#### Scenario: 计划终态

- **WHEN** 计划进入 completed、failed 或 cancelled
- **THEN** 吸底条 MUST 反映终态；系统 MAY 额外写入一张流内冻结摘要卡，但 MUST NOT 为每一个中间步骤默认盖卡
