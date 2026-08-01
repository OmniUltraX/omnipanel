import { create } from "zustand";
import type { DangerCheckResult, DangerLevel } from "../lib/commandGuard";
import { errorToString } from "../lib/errorToString";
import type { EnvironmentTag } from "../lib/resourceRegistry";
import { commands } from "../ipc/bindings";
import { t } from "../i18n";

export type ActionDraftKind =
  | "sql"
  | "shell"
  | "docker"
  | "ssh"
  | "files"
  | "terminal"
  | "generic";

export type ApprovalSource = "terminal" | "toolgate" | "acp" | "action";

export type ApprovalTargetModule =
  | "terminal"
  | "database"
  | "docker"
  | "files"
  | "server"
  | "ai"
  | "other";

export interface ApprovalTarget {
  module: ApprovalTargetModule;
  resourceId?: string;
  sessionId?: string;
  conversationId?: string | null;
}

export interface ApprovalActionDef {
  id: string;
  label: string;
  /** primary / secondary / danger 视觉 */
  variant?: "primary" | "secondary" | "danger";
  /** 拒绝类动作：走 dismiss 语义 */
  reject?: boolean;
}

export interface ActionDraft {
  id: string;
  kind: ActionDraftKind;
  title: string;
  preview: string;
  /** 确认后执行（默认 primary 动作） */
  execute: () => Promise<string>;
  conversationId?: string | null;
  createdAt: number;
  risk?: DangerLevel;
  riskCheck?: DangerCheckResult;
  environment?: EnvironmentTag;
  toolName?: string;
  resourceId?: string;
  timeoutMs?: number;
  /** 审批来源 */
  source?: ApprovalSource;
  /** 呈现路由目标 */
  target?: ApprovalTarget;
  /** 自定义动作（ACP 多选项等）；缺省为 执行/拒绝 */
  actions?: ApprovalActionDef[];
  /**
   * 自定义动作执行器。若提供，`resolveAction` 优先调用它；
   * 返回值会 resolve enqueueAwaitable 的 Promise。
   */
  runAction?: (actionId: string) => Promise<string>;
  _resolve?: (value: string) => void;
  _reject?: (reason?: unknown) => void;
  _timeoutHandle?: ReturnType<typeof setTimeout>;
}

export type EnqueueAwaitableInput = Omit<
  ActionDraft,
  "id" | "createdAt" | "_resolve" | "_reject" | "_timeoutHandle"
>;

interface ActionDraftState {
  drafts: ActionDraft[];
  /** 当前焦点项（内嵌条 / 全局弹窗） */
  focusId: string | null;
  /** 用户主动打开全局审批弹窗（状态栏入口） */
  globalDialogOpen: boolean;
  /** 自动弹出被用户关闭后，降级为仅状态栏，直到有新项入队 */
  autoDialogSuppressed: boolean;
  enqueue: (draft: Omit<ActionDraft, "id" | "createdAt">) => string;
  enqueueAwaitable: (draft: EnqueueAwaitableInput) => Promise<string>;
  dismiss: (id: string) => void;
  confirm: (id: string) => Promise<string | null>;
  resolveAction: (id: string, actionId: string) => Promise<string | null>;
  setFocusId: (id: string | null) => void;
  setGlobalDialogOpen: (open: boolean) => void;
  suppressAutoDialog: () => void;
  focusNext: (fromId?: string) => void;
}

let seq = 0;

const DEFAULT_TIMEOUT_MS = 120_000;

const DEFAULT_ACTIONS: ApprovalActionDef[] = [
  { id: "confirm", label: t("ai.approval.execute"), variant: "primary" },
  { id: "reject", label: t("ai.approval.reject"), variant: "secondary", reject: true },
];

/** 与 draft 对象分离存放，避免状态更新时丢失 Promise 回调导致确认后永久挂起 */
const pendingWaiters = new Map<
  string,
  {
    resolve: (value: string) => void;
    reject: (reason?: unknown) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
  }
>();

function clearTimeoutSafe(draft: ActionDraft | undefined) {
  if (draft?._timeoutHandle) clearTimeout(draft._timeoutHandle);
}

function clearWaiterTimeout(id: string) {
  const waiter = pendingWaiters.get(id);
  if (waiter) clearTimeout(waiter.timeoutHandle);
}

export function getDraftActions(draft: ActionDraft): ApprovalActionDef[] {
  return draft.actions?.length ? draft.actions : DEFAULT_ACTIONS;
}

export const useActionDraftStore = create<ActionDraftState>((set, get) => ({
  drafts: [],
  focusId: null,
  globalDialogOpen: false,
  autoDialogSuppressed: false,

  enqueue: (draft) => {
    const id = `draft_${Date.now()}_${++seq}`;
    set((s) => ({
      drafts: [...s.drafts, { ...draft, id, createdAt: Date.now() }],
      focusId: s.focusId ?? id,
      autoDialogSuppressed: false,
    }));
    return id;
  },

  enqueueAwaitable: (draft) =>
    new Promise<string>((resolve, reject) => {
      const id = `draft_${Date.now()}_${++seq}`;
      const timeoutMs = draft.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const timeoutHandle = setTimeout(() => {
        const waiter = pendingWaiters.get(id);
        if (!waiter) return;
        pendingWaiters.delete(id);
        waiter.reject(new Error(`审批超时（${timeoutMs / 1000}s）自动拒绝`));
        set((s) => {
          const drafts = s.drafts.filter((d) => d.id !== id);
          return {
            drafts,
            focusId: s.focusId === id ? (drafts[0]?.id ?? null) : s.focusId,
          };
        });
      }, timeoutMs);

      pendingWaiters.set(id, { resolve, reject, timeoutHandle });

      set((s) => ({
        drafts: [
          ...s.drafts,
          {
            ...draft,
            id,
            createdAt: Date.now(),
            source: draft.source ?? "toolgate",
          },
        ],
        focusId: s.focusId ?? id,
        autoDialogSuppressed: false,
      }));
    }),

  dismiss: (id) => {
    const waiter = pendingWaiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timeoutHandle);
      pendingWaiters.delete(id);
      waiter.reject(new Error("用户忽略了待确认操作"));
    } else {
      const draft = get().drafts.find((d) => d.id === id);
      clearTimeoutSafe(draft);
      draft?._reject?.(new Error("用户忽略了待确认操作"));
    }
    set((s) => {
      const drafts = s.drafts.filter((d) => d.id !== id);
      return {
        drafts,
        focusId: s.focusId === id ? (drafts[0]?.id ?? null) : s.focusId,
      };
    });
  },

  confirm: async (id) => get().resolveAction(id, "confirm"),

  resolveAction: async (id, actionId) => {
    const draft = get().drafts.find((d) => d.id === id);
    if (!draft) return null;

    const action =
      getDraftActions(draft).find((a) => a.id === actionId) ??
      (actionId === "confirm"
        ? DEFAULT_ACTIONS[0]
        : actionId === "reject"
          ? DEFAULT_ACTIONS[1]
          : undefined);

    if (action?.reject || actionId === "reject" || actionId === "dismiss") {
      get().dismiss(id);
      return null;
    }

    const waiter = pendingWaiters.get(id);
    clearWaiterTimeout(id);
    clearTimeoutSafe(draft);

    const removeDraft = () => {
      pendingWaiters.delete(id);
      set((s) => {
        const drafts = s.drafts.filter((d) => d.id !== id);
        return {
          drafts,
          focusId: s.focusId === id ? (drafts[0]?.id ?? null) : s.focusId,
        };
      });
    };

    try {
      const result = draft.runAction
        ? await draft.runAction(actionId)
        : await draft.execute();

      // 先放行等待方，再清理 UI，避免后续执行逻辑看不到已确认状态
      if (waiter) {
        pendingWaiters.delete(id);
        waiter.resolve(result);
      } else {
        draft._resolve?.(result);
      }

      if (draft.toolName) {
        const ts = Date.now();
        void commands
          .auditLogAppend({
            ts,
            action: `ai_tool.${draft.toolName}`,
            target: draft.resourceId ?? draft.title,
            envTag: draft.environment ?? "unknown",
            risk: draft.risk ?? "low",
            status: "success",
            detail: draft.preview.slice(0, 500),
          })
          .catch(() => {});
      }

      removeDraft();
      return result;
    } catch (e) {
      if (waiter) {
        pendingWaiters.delete(id);
        waiter.reject(e);
      } else {
        draft._reject?.(e);
      }

      if (draft.toolName) {
        const ts = Date.now();
        const message = errorToString(e);
        void commands
          .auditLogAppend({
            ts,
            action: `ai_tool.${draft.toolName}`,
            target: draft.resourceId ?? draft.title,
            envTag: draft.environment ?? "unknown",
            risk: draft.risk ?? "low",
            status: "failed",
            detail: message.slice(0, 500),
          })
          .catch(() => {});
      }

      removeDraft();
      throw new Error(errorToString(e));
    }
  },

  setFocusId: (id) => set({ focusId: id }),

  setGlobalDialogOpen: (open) =>
    set({ globalDialogOpen: open, autoDialogSuppressed: open ? false : get().autoDialogSuppressed }),

  suppressAutoDialog: () => set({ autoDialogSuppressed: true, globalDialogOpen: false }),

  focusNext: (fromId) => {
    const { drafts, focusId } = get();
    if (drafts.length === 0) {
      set({ focusId: null });
      return;
    }
    const current = fromId ?? focusId;
    const idx = drafts.findIndex((d) => d.id === current);
    const next = drafts[(idx + 1) % drafts.length];
    set({ focusId: next?.id ?? drafts[0].id });
  },
}));
