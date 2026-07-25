---
name: 容器异常响应
description: Docker 异常容器：list → logs → 建议 restart；restart/kill/remove 必须经审批。召回与 outcome 回写。
enabled: true
---

# 容器异常响应

## 何时使用
容器 unhealthy、exited、反复重启，或 Loop「容器异常响应」触发时。

## 流程（必须）
1. `omni_skill_recall`（resource_type=docker）。
2. `omni_docker_list_containers` 找异常容器。
3. `omni_docker_container_logs` / `omni_docker_inspect_container` 取证。
4. 给出根因猜测与建议动作；**restart/kill/remove 必须等待用户确认**（ToolGate/Draft）。
5. `omni_skill_report_outcome`。

## 验收
- 未自动执行破坏性 action
- findings 含容器 id、状态、日志摘要
