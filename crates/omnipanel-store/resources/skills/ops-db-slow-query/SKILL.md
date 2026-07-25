---
name: DB 慢查询排查
description: 数据库慢查询巡检：召回本 Skill → 只读采集 slow_log/processlist → 解释与索引建议 → report_outcome。禁止自动 DML/DDL。
enabled: true
---

# DB 慢查询排查

## 何时使用
用户或 Loop 需要排查数据库性能、慢 SQL、长事务时。

## 流程（必须）
1. 调用 `omni_skill_recall`（resource_type=database）召回历史经验。
2. 使用只读工具：
   - `omni_database_slow_log_summary`
   - `omni_database_show_processlist`
   - `omni_database_execute_sql` 仅 SELECT/SHOW/EXPLAIN
3. 给出：慢 SQL 摘要、可能原因、索引/改写建议。
4. **禁止**自动执行 ALTER/UPDATE/DELETE；写操作需用户确认。
5. 结束时调用 `omni_skill_report_outcome`（success|partial|failure）。

## 验收
- 未在未审批情况下执行写 SQL
- 输出包含 evidence（工具结果摘要）与 actionable 建议
