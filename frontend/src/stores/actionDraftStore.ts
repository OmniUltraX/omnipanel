import { create } from "zustand";
import type { DangerCheckResult, DangerLevel } from "../lib/commandGuard";
import { errorToString } from "../lib/errorToString";
import type { EnvironmentTag } from "../lib/resourceRegistry";
import { commands } from "../ipc/bindings";

export type ActionDraftKind = "sql" | "shell" | "docker" | "ssh" | "files" | "terminal" | "generic";

export interface ActionDraft {
  id: string;
  kind: ActionDraftKind;
  title: string;
  preview: string;
  /** 确认后执行 */
  execute: () => Promise<string>;
  conversationId?: string | null;
  createdAt: number;
  /** 风险等级（由 evaluateToolRisk 计算） */
  risk?: DangerLevel;
  /** 风险检测详情（由 evaluateToolRisk 计算） */
  riskCheck?: DangerCheckResult;
  /** 资源环境标签 */
  environment?: EnvironmentTag;
  /** 工具名（AI 工具审批时用于审计写入） */
  toolName?: string;
  /** 资源 ID（审计写入时用） */
  resourceId?: string;
  /** 超时自动 reject 的毫秒数（默认 120s） */
  timeoutMs?: number;
  /** 内部：等待确认的 Promise 回调 */
  _resolve?: (value: string) => void;
  _reject?: (reason?: unknown) => void;
  /** 内部：超时定时器 */
  _timeoutHandle?: ReturnType<typeof setTimeout>;
}

interface ActionDraftState {
  drafts: ActionDraft[];
  enqueue: (draft: Omit<ActionDraft, "id" | "createdAt">) => string;
  /** 入队并返回 Promise，确认后 resolve，忽略/超时则 reject */
  enqueueAwaitable: (
    draft: Omit<ActionDraft, "id" | "createdAt" | "_resolve" | "_reject" | "_timeoutHandle">,
  ) => Promise<string>;
  dismiss: (id: string) => void;
  confirm: (id: string) => Promise<string | null>;
}

let seq = 0;

/** 默认超时 120 秒（与后端 UiDelegated 300s 超时对齐，前端更短以避免用户遗忘） */
const DEFAULT_TIMEOUT_MS = 120_000;

export const useActionDraftStore = create<ActionDraftState>((set, get) => ({
  drafts: [],
  enqueue: (draft) => {
    const id = `draft_${Date.now()}_${++seq}`;
    set((s) => ({
      drafts: [...s.drafts, { ...draft, id, createdAt: Date.now() }],
    }));
    return id;
  },
  enqueueAwaitable: (draft) =>
    new Promise<string>((resolve, reject) => {
      const id = `draft_${Date.now()}_${++seq}`;
      const timeoutMs = draft.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      // 超时自动 reject，防止 AI agent 永久挂起
      const timeoutHandle = setTimeout(() => {
        const existing = get().drafts.find((d) => d.id === id);
        if (existing) {
          existing._reject?.(new Error(`审批超时（${timeoutMs / 1000}s）自动拒绝`));
          set((s) => ({ drafts: s.drafts.filter((d) => d.id !== id) }));
        }
      }, timeoutMs);

      set((s) => ({
        drafts: [
          ...s.drafts,
          {
            ...draft,
            id,
            createdAt: Date.now(),
            _resolve: resolve,
            _reject: reject,
            _timeoutHandle: timeoutHandle,
          },
        ],
      }));
    }),
  dismiss: (id) => {
    const draft = get().drafts.find((d) => d.id === id);
    if (draft?._timeoutHandle) clearTimeout(draft._timeoutHandle);
    draft?._reject?.(new Error("用户忽略了待确认操作"));
    set((s) => ({ drafts: s.drafts.filter((d) => d.id !== id) }));
  },
  confirm: async (id) => {
    const draft = get().drafts.find((d) => d.id === id);
    if (!draft) return null;
    if (draft._timeoutHandle) clearTimeout(draft._timeoutHandle);

    const removeDraft = () => {
      set((s) => ({ drafts: s.drafts.filter((d) => d.id !== id) }));
    };

    try {
      const result = await draft.execute();
      draft._resolve?.(result);

      // 审计联动：写 audit_log（异步，不阻塞 UI）
      if (draft.toolName) {
        const ts = Date.now();
        void commands.auditLogAppend({
          ts,
          action: `ai_tool.${draft.toolName}`,
          target: draft.resourceId ?? draft.title,
          envTag: draft.environment ?? "unknown",
          risk: draft.risk ?? "low",
          status: "success",
          detail: draft.preview.slice(0, 500),
        }).catch(() => {});
      }

      removeDraft();
      return result;
    } catch (e) {
      draft._reject?.(e);

      // 审计联动：写失败记录
      if (draft.toolName) {
        const ts = Date.now();
        const message = errorToString(e);
        void commands.auditLogAppend({
          ts,
          action: `ai_tool.${draft.toolName}`,
          target: draft.resourceId ?? draft.title,
          envTag: draft.environment ?? "unknown",
          risk: draft.risk ?? "low",
          status: "failed",
          detail: message.slice(0, 500),
        }).catch(() => {});
      }

      // 失败也关闭确认项，避免弹窗/卡片卡死；错误通过 reject + toast 告知
      removeDraft();
      const message = errorToString(e);
      throw new Error(message);
    }
  },
}));
