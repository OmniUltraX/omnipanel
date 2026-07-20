import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/**
 * Skill 自我进化 — 主动提醒机制
 *
 * 触发规则（来自 Phase 4 设计）：
 *   - 硬信号任一命中  → 立即提醒
 *   - 软信号 ≥2 命中   → 提醒
 *   - 本周内 dismiss 累计 3 次 → 本周不再提醒
 *
 * 信号去重：每个信号类型在单个会话内只计一次（避免反复触发）。
 * 周切换：检测到 ISO week 不一致时，自动清零 dismissCount。
 */

export type SkillSignalKind =
  /** 硬信号：AI 调用 omni_skill_recall 且返回 ≥1 条结果（用户在重复解决问题） */
  | "skill_recalled"
  /** 硬信号：AI 调用 omni_skill_extract_experience 成功（已沉淀，提醒可关联知识库） */
  | "skill_extracted"
  /** 硬信号：AI 调用 omni_skill_refine 成功（已有 skill 在迭代） */
  | "skill_refined"
  /** 软信号：当前会话执行了 5+ 条终端命令 */
  | "terminal_long_session"
  /** 软信号：用户保存了知识库条目（可能值得转为 skill） */
  | "knowledge_saved";

export interface SkillPrompt {
  triggerKind: SkillSignalKind;
  triggeredAt: number;
  /** 用于 i18n 的 body 文案 key 后缀 */
  bodyKey: "hard_recall" | "hard_extracted" | "hard_refined" | "soft_batch";
  /** 触发时收集的上下文摘要（用于"提取技能"时传给 AI） */
  contextSummary?: string;
}

interface SkillPromptState {
  // 持久化字段
  weekKey: string;
  dismissCount: number;
  lastDismissAt: number;

  // 会话内字段（不持久化）
  hardSignalHits: SkillSignalKind[];
  softSignalHits: SkillSignalKind[];
  firedThisSession: SkillSignalKind[];
  currentPrompt: SkillPrompt | null;

  // actions
  recordSignal: (
    kind: SkillSignalKind,
    opts?: { contextSummary?: string },
  ) => void;
  dismiss: () => void;
  dismissForWeek: () => void;
  acceptAndExtract: () => void;
  clearSession: () => void;
  resetWeekIfStale: () => void;
}

const HARD_SIGNALS: SkillSignalKind[] = [
  "skill_recalled",
  "skill_extracted",
  "skill_refined",
];
const SOFT_SIGNALS: SkillSignalKind[] = [
  "terminal_long_session",
  "knowledge_saved",
];
const SOFT_THRESHOLD = 2;
const MAX_WEEKLY_DISMISS = 3;

function currentWeekKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const start = new Date(year, 0, 1);
  const diff = (now.getTime() - start.getTime()) / 86_400_000;
  const week = Math.ceil((diff + start.getDay() + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function isHard(kind: SkillSignalKind): boolean {
  return HARD_SIGNALS.includes(kind);
}

function bodyKeyForHard(kind: SkillSignalKind): SkillPrompt["bodyKey"] {
  switch (kind) {
    case "skill_recalled":
      return "hard_recall";
    case "skill_extracted":
      return "hard_extracted";
    case "skill_refined":
      return "hard_refined";
    default:
      return "soft_batch";
  }
}

function shouldPrompt(state: SkillPromptState): boolean {
  if (state.dismissCount >= MAX_WEEKLY_DISMISS) return false;
  if (state.currentPrompt) return false;
  if (state.hardSignalHits.length > 0) return true;
  if (state.softSignalHits.length >= SOFT_THRESHOLD) return true;
  return false;
}

function buildPrompt(
  state: SkillPromptState,
  contextSummary?: string,
): SkillPrompt | null {
  if (state.hardSignalHits.length > 0) {
    const kind = state.hardSignalHits[0];
    return {
      triggerKind: kind,
      triggeredAt: Date.now(),
      bodyKey: bodyKeyForHard(kind),
      contextSummary,
    };
  }
  if (state.softSignalHits.length >= SOFT_THRESHOLD) {
    return {
      triggerKind: state.softSignalHits[0],
      triggeredAt: Date.now(),
      bodyKey: "soft_batch",
      contextSummary,
    };
  }
  return null;
}

export const useSkillPromptStore = create<SkillPromptState>()(
  persist(
    (set, get) => ({
      weekKey: currentWeekKey(),
      dismissCount: 0,
      lastDismissAt: 0,
      hardSignalHits: [],
      softSignalHits: [],
      firedThisSession: [],
      currentPrompt: null,

      recordSignal: (kind, opts) => {
        const state = get();
        // 周切换时自动清零
        const wk = currentWeekKey();
        let base = state;
        if (state.weekKey !== wk) {
          base = {
            ...state,
            weekKey: wk,
            dismissCount: 0,
            lastDismissAt: 0,
          };
        }
        // 本会话已触发过该信号 → 跳过（去重）
        if (base.firedThisSession.includes(kind)) {
          return;
        }
        const newFired = [...base.firedThisSession, kind];
        let hardHits = base.hardSignalHits;
        let softHits = base.softSignalHits;
        if (isHard(kind)) {
          if (!hardHits.includes(kind)) hardHits = [...hardHits, kind];
        } else {
          if (!softHits.includes(kind)) softHits = [...softHits, kind];
        }
        const next: SkillPromptState = {
          ...base,
          firedThisSession: newFired,
          hardSignalHits: hardHits,
          softSignalHits: softHits,
          currentPrompt: base.currentPrompt,
        };
        if (shouldPrompt(next)) {
          next.currentPrompt = buildPrompt(next, opts?.contextSummary);
        }
        set(next);
      },

      dismiss: () => {
        const state = get();
        set({
          ...state,
          currentPrompt: null,
          dismissCount: Math.min(state.dismissCount + 1, MAX_WEEKLY_DISMISS),
          lastDismissAt: Date.now(),
          // 清空本会话信号，避免立刻再次触发
          hardSignalHits: [],
          softSignalHits: [],
          firedThisSession: [],
        });
      },

      dismissForWeek: () => {
        const state = get();
        set({
          ...state,
          currentPrompt: null,
          dismissCount: MAX_WEEKLY_DISMISS,
          lastDismissAt: Date.now(),
          hardSignalHits: [],
          softSignalHits: [],
          firedThisSession: [],
        });
      },

      acceptAndExtract: () => {
        const state = get();
        set({
          ...state,
          currentPrompt: null,
          // 用户采取了积极行动，不计入 dismiss 次数
          hardSignalHits: [],
          softSignalHits: [],
          firedThisSession: [],
        });
      },

      clearSession: () => {
        const state = get();
        set({
          ...state,
          hardSignalHits: [],
          softSignalHits: [],
          firedThisSession: [],
          currentPrompt: null,
        });
      },

      resetWeekIfStale: () => {
        const state = get();
        const wk = currentWeekKey();
        if (state.weekKey !== wk) {
          set({
            ...state,
            weekKey: wk,
            dismissCount: 0,
            lastDismissAt: 0,
          });
        }
      },
    }),
    {
      name: "omnipanel.skill-prompt.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        weekKey: s.weekKey,
        dismissCount: s.dismissCount,
        lastDismissAt: s.lastDismissAt,
      }),
    },
  ),
);

export const SKILL_PROMPT_WEEKLY_DISMISS_CAP = MAX_WEEKLY_DISMISS;
