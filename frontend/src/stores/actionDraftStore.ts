import { create } from "zustand";

export type ActionDraftKind = "sql" | "shell" | "docker" | "generic";

export interface ActionDraft {
  id: string;
  kind: ActionDraftKind;
  title: string;
  preview: string;
  /** 确认后执行 */
  execute: () => Promise<string>;
  conversationId?: string | null;
  createdAt: number;
  /** 内部：等待确认的 Promise 回调 */
  _resolve?: (value: string) => void;
  _reject?: (reason?: unknown) => void;
}

interface ActionDraftState {
  drafts: ActionDraft[];
  enqueue: (draft: Omit<ActionDraft, "id" | "createdAt">) => string;
  /** 入队并返回 Promise，确认后 resolve，忽略则 reject */
  enqueueAwaitable: (
    draft: Omit<ActionDraft, "id" | "createdAt" | "_resolve" | "_reject">,
  ) => Promise<string>;
  dismiss: (id: string) => void;
  confirm: (id: string) => Promise<string | null>;
}

let seq = 0;

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
      set((s) => ({
        drafts: [
          ...s.drafts,
          {
            ...draft,
            id,
            createdAt: Date.now(),
            _resolve: resolve,
            _reject: reject,
          },
        ],
      }));
    }),
  dismiss: (id) => {
    const draft = get().drafts.find((d) => d.id === id);
    draft?._reject?.(new Error("用户忽略了待确认操作"));
    set((s) => ({ drafts: s.drafts.filter((d) => d.id !== id) }));
  },
  confirm: async (id) => {
    const draft = get().drafts.find((d) => d.id === id);
    if (!draft) return null;
    try {
      const result = await draft.execute();
      draft._resolve?.(result);
      set((s) => ({ drafts: s.drafts.filter((d) => d.id !== id) }));
      return result;
    } catch (e) {
      draft._reject?.(e);
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(message);
    }
  },
}));
