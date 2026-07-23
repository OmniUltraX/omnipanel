/**
 * Outer Loop 规格：发现工作 → 派发 → 验收 → 持久状态。
 * 进度存在本地（loopStore），不依赖 gateway。
 */

export type LoopTrigger = "manual" | "cron" | "event";

export type LoopFindingStatus = "open" | "triaged" | "done" | "dismissed" | "blocked";

export type LoopRunStatus =
  | "pending"
  | "discovering"
  | "running"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"
  | "stopped";

export type VerifyMode = "deterministic" | "model" | "none";

export interface LoopVerifySpec {
  mode: VerifyMode;
  /** 确定性断言：检查 findings 是否满足（如 maxOpenFindings） */
  maxOpenFindings?: number;
  /** 模型 verifier 提示（短上下文，禁止复用 worker 自评） */
  modelPrompt?: string;
}

export interface LoopStopSpec {
  maxTurns?: number;
  maxBudgetTokens?: number;
  verifyPass?: boolean;
}

export interface LoopWorkerSpec {
  /** 工具白名单前缀，空表示不限制（仍经 ToolGate） */
  toolAllowPrefix?: string[];
  envTag?: string;
  /** 只读模式：写操作一律进 Draft，不自动确认 */
  readOnlyWrites?: boolean;
}

export interface LoopSpec {
  id: string;
  name: string;
  description: string;
  trigger: LoopTrigger;
  /** cron 表达式（仅展示/调度占位，一期用 intervalMs） */
  cron?: string;
  intervalMs?: number;
  /** discover 步骤：调用的 skill id 或内置 pilot id */
  discoverSkillId?: string;
  /** 内置 pilot 处理器 id：db-health | docker-anomaly */
  pilotId?: string;
  worker: LoopWorkerSpec;
  verify: LoopVerifySpec;
  stop: LoopStopSpec;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LoopFinding {
  id: string;
  loopId: string;
  runId: string;
  title: string;
  summary: string;
  severity: "info" | "warning" | "critical";
  status: LoopFindingStatus;
  resourceId?: string;
  resourceType?: string;
  evidence?: string;
  suggestedAction?: string;
  createdAt: number;
  updatedAt: number;
}

export interface LoopRunTurn {
  index: number;
  phase: "discover" | "work" | "verify";
  summary: string;
  ok: boolean;
  at: number;
}

export interface LoopRun {
  id: string;
  loopId: string;
  status: LoopRunStatus;
  startedAt: number;
  finishedAt?: number;
  turns: LoopRunTurn[];
  findingIds: string[];
  error?: string;
  verifyPassed?: boolean;
  parentTaskId?: string;
}

export function createLoopSpec(
  partial: Omit<LoopSpec, "createdAt" | "updatedAt" | "enabled"> & {
    enabled?: boolean;
  },
): LoopSpec {
  const now = Date.now();
  return {
    ...partial,
    enabled: partial.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
}
