import { create } from "zustand";

import {
  commands,
  type ThirdPartyAccount,
  type ThirdPartyAuthMethod,
  type ThirdPartyPlatform,
  type UpsertThirdPartyAccountInput,
} from "../ipc/bindings";

export type {
  ThirdPartyAccount,
  ThirdPartyAuthMethod,
  ThirdPartyPlatform,
  UpsertThirdPartyAccountInput,
};

interface ThirdPartyAccountsState {
  accounts: ThirdPartyAccount[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  upsertAccount: (input: UpsertThirdPartyAccountInput) => Promise<ThirdPartyAccount | null>;
  removeAccount: (id: string) => Promise<boolean>;
}

export const useThirdPartyAccountsStore = create<ThirdPartyAccountsState>()((set, get) => ({
  accounts: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const result = await commands.thirdPartyAccountList();
      if (result.status === "ok") {
        set({ accounts: result.data, loading: false });
      } else {
        set({ loading: false, error: result.error ?? "加载账户列表失败" });
      }
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : "加载账户列表失败",
      });
    }
  },

  upsertAccount: async (input) => {
    set({ error: null });
    try {
      const result = await commands.thirdPartyAccountUpsert(input);
      if (result.status === "ok") {
        await get().refresh();
        return result.data;
      }
      set({ error: result.error ?? "保存账户失败" });
      return null;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "保存账户失败" });
      return null;
    }
  },

  removeAccount: async (id) => {
    set({ error: null });
    try {
      const result = await commands.thirdPartyAccountDelete(id);
      if (result.status === "ok") {
        await get().refresh();
        return true;
      }
      set({ error: result.error ?? "删除账户失败" });
      return false;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "删除账户失败" });
      return false;
    }
  },
}));

export const THIRD_PARTY_PLATFORMS: ThirdPartyPlatform[] = [
  "github",
  "gitlab",
  "gitee",
  "docker_hub",
  "aws",
  "aliyun",
  "tencent",
  "custom",
];

export const THIRD_PARTY_AUTH_METHODS: ThirdPartyAuthMethod[] = ["api_key", "password"];
