import { create } from "zustand";
import {
  commands,
  type WebFetchTestResultDto,
  type WebSearchConfigDto,
  type WebSearchTestResultDto,
} from "../ipc/bindings";

interface WebSearchStore {
  config: WebSearchConfigDto | null;
  exaKeyConfigured: boolean;
  zhihuSecretConfigured: boolean;
  jinaKeyConfigured: boolean;
  loading: boolean;
  lastTest: WebSearchTestResultDto | null;
  lastFetchTest: WebFetchTestResultDto | null;
  hydrate: () => Promise<void>;
  setConfig: (config: WebSearchConfigDto) => Promise<void>;
  setExaKey: (apiKey: string) => Promise<void>;
  setZhihuSecret: (secret: string) => Promise<void>;
  setJinaKey: (apiKey: string) => Promise<void>;
  testBackend: (backend: string) => Promise<WebSearchTestResultDto | null>;
  testFetch: (url: string) => Promise<WebFetchTestResultDto | null>;
}

export const useWebSearchStore = create<WebSearchStore>((set) => ({
  config: null,
  exaKeyConfigured: false,
  zhihuSecretConfigured: false,
  jinaKeyConfigured: false,
  loading: false,
  lastTest: null,
  lastFetchTest: null,

  hydrate: async () => {
    set({ loading: true });
    try {
      const [cfgRes, exaRes, zhihuRes, jinaRes] = await Promise.all([
        commands.webSearchGetConfig(),
        commands.webSearchExaKeyConfigured(),
        commands.webSearchZhihuSecretConfigured(),
        commands.webSearchJinaKeyConfigured(),
      ]);
      set({
        config:
          cfgRes.status === "ok"
            ? cfgRes.data
            : {
                version: 2,
                enabled: true,
                search: { backend: "auto", autoOrder: ["zhihu", "exa", "ddg", "jina"] },
                fetch: { backend: "auto", jina: { domain: "auto", noCache: false } },
              },
        exaKeyConfigured: exaRes.status === "ok" ? exaRes.data : false,
        zhihuSecretConfigured: zhihuRes.status === "ok" ? zhihuRes.data : false,
        jinaKeyConfigured: jinaRes.status === "ok" ? jinaRes.data : false,
      });
    } finally {
      set({ loading: false });
    }
  },

  setConfig: async (config) => {
    const res = await commands.webSearchSetConfig(config);
    if (res.status === "ok") {
      set({ config });
    }
  },

  setExaKey: async (apiKey) => {
    const res = await commands.webSearchSetExaKey(apiKey);
    if (res.status === "ok") {
      set({ exaKeyConfigured: apiKey.trim().length > 0 });
    }
  },

  setZhihuSecret: async (secret) => {
    const res = await commands.webSearchSetZhihuSecret(secret);
    if (res.status === "ok") {
      set({ zhihuSecretConfigured: secret.trim().length > 0 });
    }
  },

  setJinaKey: async (apiKey) => {
    const res = await commands.webSearchSetJinaKey(apiKey);
    if (res.status === "ok") {
      set({ jinaKeyConfigured: apiKey.trim().length > 0 });
    }
  },

  testBackend: async (backend) => {
    const res = await commands.webSearchTestBackend(backend);
    if (res.status === "ok") {
      set({ lastTest: res.data });
      return res.data;
    }
    return null;
  },

  testFetch: async (url) => {
    const res = await commands.webSearchTestFetch(url);
    if (res.status === "ok") {
      set({ lastFetchTest: res.data });
      return res.data;
    }
    return null;
  },
}));

export async function initWebSearchStore(): Promise<void> {
  await useWebSearchStore.getState().hydrate();
}
