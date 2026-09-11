## ADDED Requirements

### Requirement: 统一任务投影模型
系统 MUST 将多源运行数据投影为统一任务项，至少区分 facet：`passive_job`、`active_job`、`inbox`；实时审批 MUST 建模为独立的 `approval` 语义，不得并入 `inbox`。

#### Scenario: 投影包含模块与类型
- **WHEN** 任一被支持的任务源产生新项
- **THEN** 投影项 MUST 包含稳定 id、facet、module、kind、title、status 与时间戳字段

### Requirement: 被动任务终态可检索
被动任务（WorkerPool 等）在完成、失败或取消后 MUST 在约定保留策略内可被历史视图检索；MUST NOT 仅依赖短暂内存展示后不可查。

#### Scenario: 导出任务结束后可查
- **WHEN** 一次数据库导出任务成功结束
- **THEN** 用户在历史中 MUST 能在保留窗口内找到该任务及其结果摘要或错误信息

### Requirement: Finding 指纹合并
待办类 Finding MUST 使用 fingerprint（至少基于 loopId、resourceType、resourceId、规范化标题）合并重复项；合并后 MUST 更新出现次数与最近更新时间。

#### Scenario: 重复巡检建议合并
- **WHEN** 同一资源上再次产生与已有 open/triaged Finding 相同 fingerprint 的建议
- **THEN** 系统 MUST NOT 新建独立待办项
- **AND** MUST 增加 occurrenceCount（或等价计数）并刷新 updatedAt

#### Scenario: 已关闭建议再次出现
- **WHEN** fingerprint 匹配一条已 done 或 dismissed 的 Finding 再次被发现
- **THEN** 系统 MUST 将该项复活为可处理状态（如 open），或按产品配置的等价策略处理，且行为一致可测

### Requirement: 审批超时收口且留痕
实时审批在超时未响应时 MUST 自动收口（默认拒绝）；MUST 写入可审计的历史记录；MUST NOT 因超时而进入待办列表。

#### Scenario: 审批超时自动拒绝
- **WHEN** ActionDraft 超过配置时限未被确认或忽略
- **THEN** 系统 MUST 拒绝该审批并解除对上游 AI/工具链的无限等待
- **AND** 历史或审计中 MUST 可查到超时/拒绝结果

### Requirement: 取消语义明确
对 WorkerPool 被动任务的取消 MUST 触发后端中止（硬取消）；对仅前端编排状态的取消 MUST NOT 伪称为已中止后端任务，除非确有对应后端句柄。

#### Scenario: 取消后台导出
- **WHEN** 用户在运行中取消一条 WorkerPool 被动任务
- **THEN** 系统 MUST 调用后端取消接口并使任务进入 cancelled（或等价终态）
