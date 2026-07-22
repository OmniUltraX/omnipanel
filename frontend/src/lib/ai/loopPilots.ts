/**
 * 内置运维 Loop 试点：DB 健康巡检 / 容器异常响应。
 * discover 阶段只读采集，写操作仅产出 suggestedAction（进 Triage，不自动执行）。
 */
import type { LoopFinding, LoopSpec } from "./loopSpec";

type BuiltinPartial = Omit<LoopSpec, "createdAt" | "updatedAt" | "enabled"> & {
  enabled?: boolean;
};

export const BUILTIN_LOOP_SPECS: BuiltinPartial[] = [
  {
    id: "loop-db-health",
    name: "DB 健康巡检",
    description:
      "定时查看 slow_log / processlist，产出 findings；不自动执行 DML，仅建议。",
    trigger: "manual",
    intervalMs: 60 * 60 * 1000,
    pilotId: "db-health",
    discoverSkillId: "ops-db-slow-query",
    worker: {
      toolAllowPrefix: ["omni_database_"],
      readOnlyWrites: true,
    },
    verify: {
      mode: "deterministic",
      maxOpenFindings: 20,
      modelPrompt: "确认仅产出只读 findings，无自动写库",
    },
    stop: { maxTurns: 3, verifyPass: true },
    enabled: true,
  },
  {
    id: "loop-docker-anomaly",
    name: "容器异常响应",
    description:
      "扫描 unhealthy / exited 容器，拉日志并生成重启建议；重启需人工在 Draft 确认。",
    trigger: "manual",
    intervalMs: 15 * 60 * 1000,
    pilotId: "docker-anomaly",
    discoverSkillId: "ops-docker-anomaly",
    worker: {
      toolAllowPrefix: ["omni_docker_"],
      readOnlyWrites: true,
    },
    verify: {
      mode: "deterministic",
      maxOpenFindings: 20,
      modelPrompt: "确认未自动 restart/kill，仅建议",
    },
    stop: { maxTurns: 3, verifyPass: true },
    enabled: true,
  },
];

export interface PilotDiscoverContext {
  loopId: string;
  runId: string;
  connectionId?: string;
  connectionName?: string;
}

export interface PilotDiscoverResult {
  summary: string;
  findings: Omit<LoopFinding, "id" | "loopId" | "runId" | "createdAt" | "updatedAt" | "status">[];
}

/** 尝试调用模块工具做只读探测；失败时返回占位 findings。 */
export async function runPilotDiscover(
  pilotId: string,
  ctx: PilotDiscoverContext,
): Promise<PilotDiscoverResult> {
  if (pilotId === "db-health") {
    return discoverDbHealth(ctx);
  }
  if (pilotId === "docker-anomaly") {
    return discoverDockerAnomaly(ctx);
  }
  return {
    summary: `未知 pilot：${pilotId}`,
    findings: [],
  };
}

async function discoverDbHealth(ctx: PilotDiscoverContext): Promise<PilotDiscoverResult> {
  const findings: PilotDiscoverResult["findings"] = [];
  let summary = "DB 巡检完成";

  try {
    const { listConnections, isConnectionEnabled, isSqlCapableConnection } = await import(
      "../../modules/database/api"
    );
    const connections = (await listConnections()).filter(
      (c) => isConnectionEnabled(c) && isSqlCapableConnection(c),
    );
    const target = ctx.connectionName
      ? connections.find((c) => c.name === ctx.connectionName)
      : connections[0];

    if (!target) {
      findings.push({
        title: "无可用 SQL 连接",
        summary: "未找到已启用的 SQL 连接，跳过慢查询采集",
        severity: "warning",
        resourceType: "database",
        suggestedAction: "在数据库模块添加或启用连接后重跑",
      });
      return { summary: "无连接", findings };
    }

    const { executeModuleBuiltinTool } = await import("./context/registry");
    try {
      const slow = await executeModuleBuiltinTool(
        "database",
        "omni_database_slow_log_summary",
        JSON.stringify({ connection_name: target.name, count: 5 }),
      );
      if (!slow.success) throw new Error(slow.result);
      findings.push({
        title: `慢查询摘要 · ${target.name}`,
        summary: "已采集 slow_log / performance_schema 摘要（只读）",
        severity: "info",
        resourceId: target.id,
        resourceType: "database",
        evidence: String(slow.result).slice(0, 4000),
        suggestedAction: "人工审查慢 SQL，必要时加索引；勿由 loop 自动 ALTER",
      });
    } catch (e) {
      findings.push({
        title: `慢查询采集失败 · ${target.name}`,
        summary: String(e),
        severity: "warning",
        resourceId: target.id,
        resourceType: "database",
        suggestedAction: "检查 performance_schema / pg_stat_statements 是否可用",
      });
    }

    try {
      const pl = await executeModuleBuiltinTool(
        "database",
        "omni_database_show_processlist",
        JSON.stringify({ connection_name: target.name }),
      );
      if (!pl.success) throw new Error(pl.result);
      findings.push({
        title: `进程列表 · ${target.name}`,
        summary: "已采集 processlist（只读）",
        severity: "info",
        resourceId: target.id,
        resourceType: "database",
        evidence: String(pl.result).slice(0, 4000),
        suggestedAction: "对长事务人工确认后再 kill_query（需审批）",
      });
    } catch (e) {
      findings.push({
        title: `processlist 失败 · ${target.name}`,
        summary: String(e),
        severity: "warning",
        resourceId: target.id,
        resourceType: "database",
      });
    }

    summary = `已巡检连接 ${target.name}，产出 ${findings.length} 条 findings`;
  } catch (e) {
    summary = `DB 巡检异常：${e}`;
    findings.push({
      title: "DB 巡检异常",
      summary: String(e),
      severity: "critical",
      resourceType: "database",
    });
  }

  return { summary, findings };
}

async function discoverDockerAnomaly(ctx: PilotDiscoverContext): Promise<PilotDiscoverResult> {
  const findings: PilotDiscoverResult["findings"] = [];
  let summary = "容器巡检完成";

  try {
    const connectionId = ctx.connectionId ?? "docker-local";
    const { executeModuleBuiltinTool } = await import("./context/registry");
    const listRes = await executeModuleBuiltinTool(
      "docker",
      "omni_docker_list_containers",
      JSON.stringify({ connection_id: connectionId, filter: "all" }),
    );
    if (!listRes.success) throw new Error(listRes.result);
    const parsed = JSON.parse(String(listRes.result)) as {
      containers?: Array<{
        id: string;
        name: string;
        state: string;
        statusText: string;
        running: boolean;
      }>;
    };
    const containers = parsed.containers ?? [];
    const bad = containers.filter((c) => {
      const st = `${c.state} ${c.statusText}`.toLowerCase();
      return (
        st.includes("unhealthy") ||
        st.includes("exited") ||
        st.includes("dead") ||
        (!c.running && st.includes("restart"))
      );
    });

    if (bad.length === 0) {
      findings.push({
        title: "容器状态正常",
        summary: `连接 ${connectionId} 下未发现 unhealthy/exited 容器（共 ${containers.length}）`,
        severity: "info",
        resourceId: connectionId,
        resourceType: "docker",
      });
      summary = "无异常容器";
      return { summary, findings };
    }

    for (const c of bad.slice(0, 10)) {
      let evidence = c.statusText;
      try {
        const logs = await executeModuleBuiltinTool(
          "docker",
          "omni_docker_container_logs",
          JSON.stringify({
            connection_id: connectionId,
            container_id: c.id,
            tail: 80,
          }),
        );
        if (logs.success) evidence = String(logs.result).slice(0, 3000);
      } catch {
        // ignore log failures
      }
      findings.push({
        title: `异常容器 ${c.name || c.id.slice(0, 12)}`,
        summary: `state=${c.state} · ${c.statusText}`,
        severity: c.state.toLowerCase().includes("dead") ? "critical" : "warning",
        resourceId: c.id,
        resourceType: "docker",
        evidence,
        suggestedAction: `建议 restart（需人工确认）：omni_docker_container_action action=restart container=${c.id}`,
      });
    }
    summary = `发现 ${bad.length} 个异常容器，已写入 Triage`;
  } catch (e) {
    summary = `Docker 巡检异常：${e}`;
    findings.push({
      title: "Docker 巡检异常",
      summary: String(e),
      severity: "critical",
      resourceType: "docker",
    });
  }

  return { summary, findings };
}

export function materializeFindings(
  loopId: string,
  runId: string,
  partials: PilotDiscoverResult["findings"],
): LoopFinding[] {
  const now = Date.now();
  return partials.map((p, i) => ({
    ...p,
    id: `finding_${now}_${i}`,
    loopId,
    runId,
    status: "open" as const,
    createdAt: now,
    updatedAt: now,
  }));
}
