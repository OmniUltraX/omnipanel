import { create } from "zustand";

const AUTO_OPEN_KEY = "omnipanel.pluginStudio.autoOpenAiDock";
const EXCERPT_MAX = 6000;
const LOG_TAIL_MAX = 4000;

export type PluginStudioAiSnapshot = {
  active: boolean;
  project: string;
  file: string;
  kind: string | null;
  version: string | null;
  displayName: string | null;
  dirty: boolean;
  files: string[];
  lastLogTail: string;
  lastStatus: string;
  manifestOk: boolean | null;
  manifestHint: string;
  fileExcerpt: string;
};

export const EMPTY_PLUGIN_STUDIO_AI_SNAPSHOT: PluginStudioAiSnapshot = {
  active: false,
  project: "",
  file: "",
  kind: null,
  version: null,
  displayName: null,
  dirty: false,
  files: [],
  lastLogTail: "",
  lastStatus: "",
  manifestOk: null,
  manifestHint: "",
  fileExcerpt: "",
};

interface PluginStudioAiState {
  snapshot: PluginStudioAiSnapshot;
  setSnapshot: (snapshot: PluginStudioAiSnapshot) => void;
  clear: () => void;
}

export const usePluginStudioAiStore = create<PluginStudioAiState>((set) => ({
  snapshot: EMPTY_PLUGIN_STUDIO_AI_SNAPSHOT,
  setSnapshot: (snapshot) => set({ snapshot }),
  clear: () => set({ snapshot: EMPTY_PLUGIN_STUDIO_AI_SNAPSHOT }),
}));

export function clipStudioText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated)`;
}

export function formatPluginStudioAiContext(snapshot: PluginStudioAiSnapshot): string | null {
  if (!snapshot.active) return null;
  const lines = ["## 插件工作台现场"];
  if (!snapshot.project) {
    lines.push("- 尚未选择工程。可让用户点「新增」，或根据描述用工具写入 plugins-custom。");
    return lines.join("\n");
  }
  lines.push(`- 工程：${snapshot.displayName || snapshot.project}（目录 ${snapshot.project}）`);
  if (snapshot.kind) lines.push(`- kind：${snapshot.kind}`);
  if (snapshot.version) lines.push(`- version：${snapshot.version}`);
  if (snapshot.files.length > 0) {
    lines.push(`- 文件：${snapshot.files.slice(0, 40).join(", ")}`);
  }
  if (snapshot.file) {
    lines.push(`- 打开：${snapshot.file}${snapshot.dirty ? "（未保存）" : ""}`);
  }
  if (snapshot.lastStatus) lines.push(`- 最近状态：${snapshot.lastStatus}`);
  if (snapshot.manifestHint) {
    lines.push(
      `- 清单：${snapshot.manifestOk === false ? "无效" : snapshot.manifestOk ? "格式正确" : "—"} ${snapshot.manifestHint}`,
    );
  }
  if (snapshot.lastLogTail.trim()) {
    lines.push("- 最近日志：", "```", clipStudioText(snapshot.lastLogTail.trim(), LOG_TAIL_MAX), "```");
  }
  if (snapshot.fileExcerpt.trim()) {
    lines.push(`- 当前文件摘录（${snapshot.file}）：`, "```", clipStudioText(snapshot.fileExcerpt, EXCERPT_MAX), "```");
  }
  lines.push(
    "- 改文件请用 omni_studio_read_file / omni_studio_write_file，校验用 omni_studio_validate；路径相对工程根，禁止 ..。",
  );
  return lines.join("\n");
}

export function getPluginStudioAiContextText(): string | null {
  return formatPluginStudioAiContext(usePluginStudioAiStore.getState().snapshot);
}

export function getPluginStudioAiSnapshot(): PluginStudioAiSnapshot {
  return usePluginStudioAiStore.getState().snapshot;
}

export function readPluginStudioAutoOpenAiDock(): boolean {
  try {
    return localStorage.getItem(AUTO_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writePluginStudioAutoOpenAiDock(open: boolean): void {
  try {
    localStorage.setItem(AUTO_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* ignore quota */
  }
}

export function excerptStudioFile(content: string): string {
  return clipStudioText(content, EXCERPT_MAX);
}

export function tailStudioLog(log: string): string {
  if (log.length <= LOG_TAIL_MAX) return log;
  return log.slice(-LOG_TAIL_MAX);
}
