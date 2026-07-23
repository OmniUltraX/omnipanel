/**
 * 运维 Skill 种子：首次启动写入 ~/.omnipd/skills（若不存在）。
 */
import { commands } from "../../ipc/bindings";
import { isTauriRuntime } from "../isTauriRuntime";

interface OpsSkillSeed {
  id: string;
  name: string;
  description: string;
  body: string;
}

const OPS_SKILL_SEEDS: OpsSkillSeed[] = [
  {
    id: "ops-db-slow-query",
    name: "DB 慢查询排查",
    description:
      "数据库慢查询巡检：召回本 Skill → 只读采集 slow_log/processlist → 解释与索引建议 → report_outcome。禁止自动 DML/DDL。",
    body: `# DB 慢查询排查

## 何时使用
用户或 Loop 需要排查数据库性能、慢 SQL、长事务时。

## 流程（必须）
1. 调用 \`omni_skill_recall\`（resource_type=database）召回历史经验。
2. 使用只读工具：
   - \`omni_database_slow_log_summary\`
   - \`omni_database_show_processlist\`
   - \`omni_database_execute_sql\` 仅 SELECT/SHOW/EXPLAIN
3. 给出：慢 SQL 摘要、可能原因、索引/改写建议。
4. **禁止**自动执行 ALTER/UPDATE/DELETE；写操作需用户确认。
5. 结束时调用 \`omni_skill_report_outcome\`（success|partial|failure）。

## 验收
- 未在未审批情况下执行写 SQL
- 输出包含 evidence（工具结果摘要）与 actionable 建议
`,
  },
  {
    id: "ops-docker-anomaly",
    name: "容器异常响应",
    description:
      "Docker 异常容器：list → logs → 建议 restart；restart/kill/remove 必须经审批。召回与 outcome 回写。",
    body: `# 容器异常响应

## 何时使用
容器 unhealthy、exited、反复重启，或 Loop「容器异常响应」触发时。

## 流程（必须）
1. \`omni_skill_recall\`（resource_type=docker）。
2. \`omni_docker_list_containers\` 找异常容器。
3. \`omni_docker_container_logs\` / \`omni_docker_inspect_container\` 取证。
4. 给出根因猜测与建议动作；**restart/kill/remove 必须等待用户确认**（ToolGate/Draft）。
5. \`omni_skill_report_outcome\`。

## 验收
- 未自动执行破坏性 action
- findings 含容器 id、状态、日志摘要
`,
  },
  {
    id: "ops-ssh-patrol",
    name: "SSH 主机巡检",
    description:
      "SSH 主机只读巡检：磁盘/负载/关键服务；危险命令需审批；召回与 outcome。",
    body: `# SSH 主机巡检

## 流程
1. \`omni_skill_recall\`（resource_type=ssh）。
2. 优先 \`omni_ssh_get_stats\`；必要时 \`omni_ssh_exec\` 执行只读命令（df、uptime、free）。
3. 危险命令（rm、mkfs、reboot 等）必须审批。
4. \`omni_skill_report_outcome\`。
`,
  },
];

let seeded = false;

export async function ensureOpsSkillSeeds(): Promise<void> {
  if (seeded || !isTauriRuntime()) return;
  seeded = true;
  try {
    const listRes = await commands.skillList();
    const existing = new Set(
      listRes.status === "ok" ? listRes.data.map((s) => s.id) : [],
    );
    for (const seed of OPS_SKILL_SEEDS) {
      if (existing.has(seed.id)) continue;
      const res = await commands.skillCreate({
        id: seed.id,
        name: seed.name,
        description: seed.description,
        body: seed.body,
        enabled: true,
      });
      if (res.status === "error") {
        console.warn(`[opsSkills] 创建 ${seed.id} 失败:`, res.error);
      }
    }
  } catch (e) {
    console.warn("[opsSkills] 种子写入失败", e);
  }
}

export { OPS_SKILL_SEEDS };
