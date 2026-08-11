import { create } from "zustand";
import { persist } from "zustand/middleware";

/** 侧栏「查询」入口的单例 SQL 草稿（不落文件，关闭后再打开可恢复）。 */
export type DbScratchQueryDraft = {
  sql: string;
  connId: string;
  database: string;
  cursorOffset: number;
};

type DbScratchQueryState = DbScratchQueryDraft & {
  setDraft: (patch: Partial<DbScratchQueryDraft>) => void;
  replaceDraft: (draft: DbScratchQueryDraft) => void;
};

const EMPTY_DRAFT: DbScratchQueryDraft = {
  sql: "",
  connId: "",
  database: "",
  cursorOffset: 0,
};

export const useDbScratchQueryStore = create<DbScratchQueryState>()(
  persist(
    (set) => ({
      ...EMPTY_DRAFT,
      setDraft: (patch) => set((state) => ({ ...state, ...patch })),
      replaceDraft: (draft) => set({ ...draft }),
    }),
    {
      name: "omnipanel-db-scratch-query",
      partialize: (state) => ({
        sql: state.sql,
        connId: state.connId,
        database: state.database,
        cursorOffset: state.cursorOffset,
      }),
    },
  ),
);
