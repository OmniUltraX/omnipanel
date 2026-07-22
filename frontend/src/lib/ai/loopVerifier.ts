/**
 * 独立 Verifier：禁止 worker 自评完成。
 * - deterministic：按 findings / 断言判定
 * - model：预留短上下文模型检查（当前用确定性启发式 + 可选提示文本记录）
 */
import type { LoopFinding, LoopRun, LoopSpec, LoopVerifySpec } from "./loopSpec";

export interface VerifyInput {
  spec: LoopSpec;
  run: LoopRun;
  findings: LoopFinding[];
}

export interface VerifyResult {
  passed: boolean;
  reason: string;
  mode: LoopVerifySpec["mode"];
}

export function verifyLoopRun(input: VerifyInput): VerifyResult {
  const { spec, run, findings } = input;
  const mode = spec.verify.mode;

  if (mode === "none") {
    return { passed: true, reason: "未配置验收，默认通过", mode };
  }

  if (run.status === "failed" || run.status === "cancelled") {
    return { passed: false, reason: `运行状态为 ${run.status}`, mode };
  }

  const openCritical = findings.filter(
    (f) => f.status === "open" && f.severity === "critical",
  );
  const openAll = findings.filter((f) => f.status === "open" || f.status === "blocked");

  if (mode === "deterministic" || mode === "model") {
    const maxOpen = spec.verify.maxOpenFindings ?? 0;
    if (openCritical.length > 0) {
      return {
        passed: false,
        reason: `仍有 ${openCritical.length} 条 critical findings 未处理`,
        mode,
      };
    }
    if (openAll.length > maxOpen) {
      return {
        passed: false,
        reason: `未关闭 findings ${openAll.length} 超过阈值 ${maxOpen}（已写入 Triage，待人工处理）`,
        mode,
      };
    }
    // model 模式：记录提示，实际判定仍用确定性门（避免 worker 自评）
    if (mode === "model" && spec.verify.modelPrompt) {
      return {
        passed: true,
        reason: `确定性门通过；model 提示已记录：${spec.verify.modelPrompt.slice(0, 80)}`,
        mode,
      };
    }
    return { passed: true, reason: "确定性验收通过", mode };
  }

  return { passed: false, reason: `未知 verify 模式：${mode}`, mode };
}

/** 是否应因 stop 条件终止（maxTurns 等）。 */
export function shouldStopLoop(spec: LoopSpec, run: LoopRun, verify: VerifyResult): boolean {
  if (spec.stop.verifyPass && verify.passed) return true;
  const maxTurns = spec.stop.maxTurns ?? 8;
  if (run.turns.length >= maxTurns) return true;
  return false;
}
