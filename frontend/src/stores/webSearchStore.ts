import { create } from "zustand";
import { commands, type WebSearchConfigDto, type WebSearchTestResultDto } from "../ipc/bindings";

interface WebSearchStore {
  config: WebSearchConfigDto | null;
  exaKeyConfigured: boolean;
  loading: boolean;
  lastTest: WebSearchTestResultDto | null;
  hydrate: () => Promise<void>;
  setConfig: (config: WebSearchConfigDto) => Promise<void>;
  setExaKey: (apiKey: string) => Promise<void>;
  testBackend: (backend: string) => Promise<WebSearchTestResultDto | null>;
}

export const useWebSearchStore = create<WebSearchStore>((set) => ({
  config: null,
  exaKeyConfigured: false,
  loading: false,
  lastTest: null,

  hydrate: async () => {
    set({ loading: true });
    try {
      const [cfgRes, keyRes] = await Promise.all([
        commands.webSearchGetConfig(),
        commands.webSearchExaKeyConfigured(),
      ]);
      set({
        config: cfgRes.status === "ok" ? cfgRes.data : { enabled: true, backend: "auto" },
        exaKeyConfigured: keyRes.status === "ok" ? keyRes.data : false,
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

  testBackend: async (backend) => {
    const res = await commands.webSearchTestBackend(backend);
    if (res.status === "ok") {
      set({ lastTest: res.data });
      return res.data;
    }
    return null;
  },
}));

export async function initWebSearchStore(): Promise<void> {
  await useWebSearchStore.getState().hydrate();
}
