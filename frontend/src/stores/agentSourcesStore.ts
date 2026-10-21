import { create } from "zustand";

import { commands, type AgentSourceCard } from "../ipc/bindings";
import { canUseAiBackend } from "../lib/isTauriRuntime";
import { parseModelSelectionId } from "./aiModelsStore";

const PREFS_KEY = "omnipanel.agent-source-prefs";

interface SourcePref {
  enabled: boolean;
  disabledModelIds: string[];
}

function loadPrefs(): Record<string, SourcePref> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, SourcePref>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function savePrefs(prefs: Record<string, SourcePref>) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

function prefOf(prefs: Record<string, SourcePref>, id: string): SourcePref {
  return prefs[id] ?? { enabled: true, disabledModelIds: [] };
}

interface AgentSourcesState {
  sources: AgentSourceCard[];
  refreshingId: string | null;
  prefs: Record<string, SourcePref>;
  load: () => Promise<void>;
  refresh: (id: string) => Promise<void>;
  setSourceEnabled: (id: string, enabled: boolean) => void;
  setModelEnabled: (sourceId: string, modelId: string, enabled: boolean) => void;
  setAllModelsEnabled: (sourceId: string, modelIds: string[], enabled: boolean) => void;
}

export const useAgentSourcesStore = create<AgentSourcesState>((set, get) => ({
  sources: [],
  refreshingId: null,
  prefs: loadPrefs(),
  setSourceEnabled: (id, enabled) => {
    const current = prefOf(get().prefs, id);
    const prefs = { ...get().prefs, [id]: { ...current, enabled } };
    savePrefs(prefs);
    set({ prefs });
  },
  setModelEnabled: (sourceId, modelId, enabled) => {
    const current = prefOf(get().prefs, sourceId);
    const disabled = new Set(current.disabledModelIds);
    if (enabled) disabled.delete(modelId);
    else disabled.add(modelId);
    const prefs = {
      ...get().prefs,
      [sourceId]: { ...current, disabledModelIds: [...disabled] },
    };
    savePrefs(prefs);
    set({ prefs });
  },
  setAllModelsEnabled: (sourceId, modelIds, enabled) => {
    const current = prefOf(get().prefs, sourceId);
    const disabled = new Set(current.disabledModelIds);
    for (const modelId of modelIds) {
      if (enabled) disabled.delete(modelId);
      else disabled.add(modelId);
    }
    const prefs = {
      ...get().prefs,
      [sourceId]: { ...current, disabledModelIds: [...disabled] },
    };
    savePrefs(prefs);
    set({ prefs });
  },
  load: async () => {
    if (!canUseAiBackend()) return;
    const result = await commands.agentSourceList();
    if (result.status === "ok") {
      set({ sources: result.data });
    }
  },
  refresh: async (id: string) => {
    if (!canUseAiBackend()) return;
    set({ refreshingId: id });
    const result = await commands.agentSourceRefresh(id);
    set({ refreshingId: null });
    if (result.status === "ok") {
      const rest = get().sources.filter((source) => source.id !== id);
      set({ sources: [...rest, result.data] });
    } else {
      const rest = get().sources.map((source) =>
        source.id === id ? { ...source, error: result.error } : source,
      );
      set({ sources: rest });
    }
  },
}));

export async function initAgentSourcesStore(): Promise<void> {
  await useAgentSourcesStore.getState().load();
  const signedIn = useAgentSourcesStore
    .getState()
    .sources.filter((source) => source.signedIn);
  for (const source of signedIn) {
    void useAgentSourcesStore.getState().refresh(source.id);
  }
}

export function isAgentSourceEnabled(sourceId: string): boolean {
  return prefOf(useAgentSourcesStore.getState().prefs, sourceId).enabled;
}

export function isAgentModelEnabled(sourceId: string, modelId: string): boolean {
  const pref = prefOf(useAgentSourcesStore.getState().prefs, sourceId);
  return pref.enabled && !pref.disabledModelIds.includes(modelId);
}

export function isAgentSourceSelection(selectionId: string): boolean {
  const parsed = parseModelSelectionId(selectionId);
  if (!parsed) return false;
  return useAgentSourcesStore.getState().sources.some(
    (source) =>
      source.signedIn &&
      source.id === parsed.providerId &&
      source.models.some((model) => model.id === parsed.modelName),
  );
}
