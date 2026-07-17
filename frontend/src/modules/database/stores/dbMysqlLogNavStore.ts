import { create } from "zustand";

export type MysqlLogNavKind = "slow-query" | "binlog";

export type MysqlLogNavRequest = {
  connId: string;
  kind: MysqlLogNavKind;
};

interface DbMysqlLogNavState {
  pending: MysqlLogNavRequest | null;
  requestOpen: (connId: string, kind: MysqlLogNavKind) => void;
  consume: () => MysqlLogNavRequest | null;
}

/** 连接信息面板 → DatabasePanel：请求打开慢日志 / 二进制日志 Tab */
export const useDbMysqlLogNavStore = create<DbMysqlLogNavState>((set, get) => ({
  pending: null,

  requestOpen: (connId, kind) => set({ pending: { connId, kind } }),

  consume: () => {
    const pending = get().pending;
    if (!pending) return null;
    set({ pending: null });
    return pending;
  },
}));
