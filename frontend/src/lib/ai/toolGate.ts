/**
 * 统一 ToolGate：合并 SQL 只读、evaluateToolRisk、ACP 自动放行决策。
 * 所有 AI 工具路径（Builtin / ACP permission / Draft）应经此出口。
 */
import type { ActionDraftKind } from "../../stores/actionDraftStore";
import type { DangerCheckResult, DangerLevel } from "../commandGuard";
import type { EnvironmentTag } from "../resourceRegistry";
import { isReadOnlySql, isSafeDatabaseToolPermission } from "./sqlSafety";
import { evaluateToolRisk } from "./toolRisk";

export type ToolGateDecision = "allow" | "approve" | "deny";
export type ToolGateChannel = "acp" | "ui-delegated" | "native";

export interface ToolGateInput {
  toolName: string;
  args: Record<string, unknown> | string;
  resourceId?: string;
  channel?: ToolGateChannel;
  /** 终端审批策略已判定需人工确认时强制走 Draft，避免 evaluateToolRisk 误放行 */
  terminalApprovalRequired?: boolean;
}

export interface ToolGateResult {
  decision: ToolGateDecision;
  risk: DangerLevel;
  riskCheck?: DangerCheckResult;
  environment: EnvironmentTag;
  reason: string;
  kind: ActionDraftKind;
  title: string;
  preview: string;
}

const READ_ONLY_TOOL_PATTERNS = [
  /get_databases/,
  /get_tables/,
  /get_table_info/,
  /show_processlist/,
  /slow_log/,
  /list_containers/,
  /container_logs/,
  /inspect_container/,
  /list_connections/,
  /list_users/,
  /list_character_sets/,
  /preview_table/,
  /get_stats/,
  /list_tunnels/,
  /files_list/,
  /files_read/,
  /files_search/,
  /files_stat/,
];

const ALWAYS_APPROVE_PATTERNS = [
  /kill_query/,
  /create_database/,
  /docker_exec/,
];

function argsToRecord(args: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      return JSON.parse(args || "{}") as Record<string, unknown>;
    } catch {
      return { raw: args };
    }
  }
  return args;
}

function argsToJson(args: Record<string, unknown> | string): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return "{}";
  }
}

function inferKind(toolName: string): ActionDraftKind {
  const n = toolName.toLowerCase();
  if (n.includes("database") || n.includes("sql")) return "sql";
  // SSH 工具归入终端模块；draft kind 仍可用 ssh 区分展示
  if (n.includes("ssh")) return "ssh";
  if (n.includes("docker")) return "docker";
  if (n.includes("files") || n.includes("file_")) return "files";
  if (n.includes("terminal")) return "terminal";
  if (n.includes("shell")) return "shell";
  return "generic";
}

function shortPreview(args: Record<string, unknown>): string {
  const sql = typeof args.sql === "string" ? args.sql : null;
  const command = typeof args.command === "string" ? args.command : null;
  const action = typeof args.action === "string" ? args.action : null;
  const path = typeof args.path === "string" ? args.path : null;
  if (sql) return sql.slice(0, 2000);
  if (command) return command.slice(0, 2000);
  if (action) return `action=${action}`;
  if (path) return path.slice(0, 500);
  try {
    return JSON.stringify(args, null, 2).slice(0, 2000);
  } catch {
    return "";
  }
}

function isKnownReadOnlyTool(toolName: string): boolean {
  const n = toolName.toLowerCase();
  return READ_ONLY_TOOL_PATTERNS.some((re) => re.test(n));
}

function mustApproveTool(toolName: string): boolean {
  const n = toolName.toLowerCase();
  return ALWAYS_APPROVE_PATTERNS.some((re) => re.test(n));
}

/**
 * 统一决策：allow 直执 / approve 进 Draft / deny 拒绝。
 */
export function decideToolInvocation(input: ToolGateInput): ToolGateResult {
  const toolName = input.toolName;
  const args = argsToRecord(input.args);
  const argsJson = argsToJson(input.args);
  const resourceId =
    input.resourceId ??
    (typeof args.resource_id === "string"
      ? args.resource_id
      : typeof args.connection_id === "string"
        ? args.connection_id
        : typeof args.connection_name === "string"
          ? args.connection_name
          : undefined);

  const kind = inferKind(toolName);
  const title = toolName.replace(/^omni_/, "").slice(0, 120);
  const preview = shortPreview(args);

  if (input.terminalApprovalRequired) {
    const risk = evaluateToolRisk(toolName, argsJson, resourceId);
    return {
      decision: "approve",
      risk: risk.risk === "low" ? "medium" : risk.risk,
      riskCheck: risk.riskCheck,
      environment: risk.environment,
      reason: "终端审批策略要求确认",
      kind,
      title: `${title}（需确认）`,
      preview,
    };
  }

  // 1) 显式危险工具 → 必须审批
  if (mustApproveTool(toolName)) {
    const risk = evaluateToolRisk(toolName, argsJson, resourceId);
    return {
      decision: "approve",
      risk: risk.risk === "low" ? "high" : risk.risk,
      riskCheck: risk.riskCheck ?? {
        safe: false,
        level: "high",
        matches: [{ desc: "高风险操作，需人工确认", level: "high" }],
      },
      environment: risk.environment,
      reason: "高风险工具强制审批",
      kind,
      title: `${title}（需确认）`,
      preview,
    };
  }

  // 2) 已知只读工具 → 放行
  if (isKnownReadOnlyTool(toolName)) {
    return {
      decision: "allow",
      risk: "low",
      environment: "unknown",
      reason: "只读工具自动放行",
      kind,
      title,
      preview,
    };
  }

  // 3) SQL 执行：只读放行，写操作审批
  if (/execute_sql|run_sql/i.test(toolName) && typeof args.sql === "string") {
    if (isReadOnlySql(args.sql)) {
      return {
        decision: "allow",
        risk: "low",
        environment: "unknown",
        reason: "只读 SQL 自动放行",
        kind: "sql",
        title,
        preview: args.sql,
      };
    }
    const risk = evaluateToolRisk(toolName, argsJson, resourceId);
    return {
      decision: "approve",
      risk: risk.risk === "low" ? "medium" : risk.risk,
      riskCheck: risk.riskCheck,
      environment: risk.environment,
      reason: "写 SQL 需审批",
      kind: "sql",
      title: typeof args.connection_name === "string"
        ? `${args.connection_name} / ${String(args.database_name ?? "")}`
        : title,
      preview: args.sql,
    };
  }

  // 4) 通用风险：evaluateToolRisk
  const risk = evaluateToolRisk(toolName, argsJson, resourceId);
  if (!risk.needsApproval) {
    return {
      decision: "allow",
      risk: risk.risk,
      riskCheck: risk.riskCheck,
      environment: risk.environment,
      reason: "低风险自动放行",
      kind,
      title,
      preview,
    };
  }

  return {
    decision: "approve",
    risk: risk.risk,
    riskCheck: risk.riskCheck,
    environment: risk.environment,
    reason: "风险评估要求审批",
    kind,
    title,
    preview,
  };
}

/** ACP permission_request：是否可自动 allow_once。 */
export function canAutoAllowAcp(toolTitle: string, rawInput: string): boolean {
  if (isSafeDatabaseToolPermission(toolTitle, rawInput)) return true;
  try {
    const parsed = JSON.parse(rawInput || "{}") as Record<string, unknown>;
    const gate = decideToolInvocation({
      toolName: toolTitle,
      args: parsed,
      channel: "acp",
    });
    return gate.decision === "allow";
  } catch {
    return decideToolInvocation({
      toolName: toolTitle,
      args: {},
      channel: "acp",
    }).decision === "allow";
  }
}

/**
 * 按 ToolGate 决策执行：allow 直跑，approve 进 Draft 等用户确认后再跑。
 *
 * 关键安全语义：
 * - approve 路径下：只有当用户在 UI 上点击「确认」，`enqueueAwaitable` 的
 *   Promise 才会 resolve；此时 resolve 返回的字符串就是 execute 的结果。
 * - 若用户点击「拒绝」或「忽略」或审批超时：`enqueueAwaitable` Promise 会
 *   reject → 冒泡到调用方抛错，execute 绝对不会被调用。
 */
export async function runWithToolGate(
  input: ToolGateInput,
  execute: () => Promise<string>,
): Promise<string> {
  const gate = decideToolInvocation(input);
  if (gate.decision === "deny") {
    throw new Error(`工具被拒绝：${gate.reason}`);
  }
  if (gate.decision === "allow") {
    return execute();
  }

  const { useActionDraftStore } = await import("../../stores/actionDraftStore");
  const resourceId =
    input.resourceId ??
    (typeof argsToRecord(input.args).resource_id === "string"
      ? (argsToRecord(input.args).resource_id as string)
      : typeof argsToRecord(input.args).connection_id === "string"
        ? (argsToRecord(input.args).connection_id as string)
        : undefined);

  // 审批 + 执行一体化：把真实的 execute 交给 draft 的 execute 回调，
  // 这样只有用户点「确认」时才真正执行；若 reject/超时，则 enqueueAwaitable
  // Promise 会 reject → 本函数直接抛错，不会继续执行。
  return useActionDraftStore.getState().enqueueAwaitable({
    kind: gate.kind,
    source: "toolgate",
    title: gate.title,
    preview: `${gate.preview}\n\n[ToolGate] ${gate.reason} · risk=${gate.risk}`,
    execute,
    risk: gate.risk,
    riskCheck: gate.riskCheck,
    environment: gate.environment,
    toolName: input.toolName,
    resourceId,
    target: {
      module:
        gate.kind === "sql"
          ? "database"
          : gate.kind === "docker"
            ? "docker"
            : gate.kind === "files"
              ? "files"
              : gate.kind === "ssh" || gate.kind === "terminal" || gate.kind === "shell"
                ? "terminal"
                : "other",
      resourceId,
    },
  });
}
