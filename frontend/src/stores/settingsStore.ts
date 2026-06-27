import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Locale = "zh-CN" | "en-US";
export type UiDensity = "compact" | "standard" | "comfortable";
export type Theme = "system" | "light" | "dark";

/** 强调色预设：影响全局 --accent / --accent-hover / --accent-active / --accent-soft 变量 */
export type AccentColor = "blue" | "green" | "orange" | "red" | "purple";

export interface AccentPalette {
  id: AccentColor;
  /** UI 中显示的色块 */
  swatch: string;
  accent: string;
  accentHover: string;
  accentActive: string;
  accentSoft: string;
}

export const ACCENT_PRESETS: Record<AccentColor, AccentPalette> = {
  blue:   { id: "blue",   swatch: "#007aff", accent: "#007aff", accentHover: "#0056b3", accentActive: "#004085", accentSoft: "rgba(0, 122, 255, 0.12)" },
  green:  { id: "green",  swatch: "#30d158", accent: "#30d158", accentHover: "#27ae44", accentActive: "#1f8a36", accentSoft: "rgba(48, 209, 88, 0.12)" },
  orange: { id: "orange", swatch: "#ff9f0a", accent: "#ff9f0a", accentHover: "#e08a00", accentActive: "#b37000", accentSoft: "rgba(255, 159, 10, 0.12)" },
  red:    { id: "red",    swatch: "#ff3b30", accent: "#ff3b30", accentHover: "#e02e23", accentActive: "#b3241c", accentSoft: "rgba(255, 59, 48, 0.12)" },
  purple: { id: "purple", swatch: "#bf5af2", accent: "#bf5af2", accentHover: "#a13ed4", accentActive: "#8030a8", accentSoft: "rgba(191, 90, 242, 0.12)" },
};

export const ACCENT_ORDER: AccentColor[] = ["blue", "green", "orange", "red", "purple"];

/** 界面全局缩放（百分比），适用于 Tauri WebView（html zoom） */
export const UI_SCALE = {
  min: 80,
  max: 150,
  default: 100,
  step: 5,
} as const;

export type ProxyProtocol = "http" | "https" | "socks5";

export interface ProxyConfig {
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
}

export const DEFAULT_PROXY: ProxyConfig = {
  enabled: false,
  protocol: "http",
  host: "",
  port: 8080,
  username: "",
  password: "",
};

export type AiDisplayMode = "subwindow" | "dockview";

/** 详情面板呈现方式：右侧滑入抽屉 / 居中浮动窗口 */
export type DetailPanelMode = "drawer" | "floating";

export type TerminalCursorStyle = "block" | "bar" | "underline";

export const AI_DOCK_WIDTH_MIN = 300;
export const AI_DOCK_WIDTH_DEFAULT = 480;

export const KNOWLEDGE_CHUNK_SIZE = {
  min: 200,
  max: 4000,
  default: 800,
  step: 100,
} as const;

export const KNOWLEDGE_CHUNK_OVERLAP = {
  min: 0,
  max: 1000,
  default: 100,
  step: 50,
} as const;

export const KNOWLEDGE_TOP_N = {
  min: 1,
  max: 50,
  default: 5,
  step: 1,
} as const;

export function clampKnowledgeChunkSize(value: number): number {
  const stepped = Math.round(value / KNOWLEDGE_CHUNK_SIZE.step) * KNOWLEDGE_CHUNK_SIZE.step;
  return Math.min(KNOWLEDGE_CHUNK_SIZE.max, Math.max(KNOWLEDGE_CHUNK_SIZE.min, stepped));
}

export function clampKnowledgeChunkOverlap(value: number, chunkSize: number): number {
  const stepped = Math.round(value / KNOWLEDGE_CHUNK_OVERLAP.step) * KNOWLEDGE_CHUNK_OVERLAP.step;
  const max = Math.max(0, chunkSize - 100);
  return Math.min(max, Math.max(KNOWLEDGE_CHUNK_OVERLAP.min, stepped));
}

export function clampKnowledgeTopN(value: number): number {
  return Math.min(KNOWLEDGE_TOP_N.max, Math.max(KNOWLEDGE_TOP_N.min, Math.round(value)));
}

/** SQL 查询结果每页行数（设置页可选值）。 */
export const DATABASE_QUERY_PAGE_SIZE_OPTIONS = [10, 100, 1000, 5000] as const;
export type DatabaseQueryPageSize = (typeof DATABASE_QUERY_PAGE_SIZE_OPTIONS)[number];
export const DEFAULT_DATABASE_QUERY_PAGE_SIZE: DatabaseQueryPageSize = 100;

export function clampDatabaseQueryPageSize(value: number): DatabaseQueryPageSize {
  const n = Math.round(value);
  if ((DATABASE_QUERY_PAGE_SIZE_OPTIONS as readonly number[]).includes(n)) {
    return n as DatabaseQueryPageSize;
  }
  return DEFAULT_DATABASE_QUERY_PAGE_SIZE;
}

/** SQL 编辑器字号可选值。 */
export const SQL_EDITOR_FONT_SIZE_OPTIONS = [11, 12, 13, 14, 15, 16, 18] as const;
export type SqlEditorFontSize = (typeof SQL_EDITOR_FONT_SIZE_OPTIONS)[number];
export const DEFAULT_SQL_EDITOR_FONT_SIZE: SqlEditorFontSize = 13;

/** SQL 编辑器行高可选值（倍数）。 */
export const SQL_EDITOR_LINE_HEIGHT_OPTIONS = [1.2, 1.4, 1.6, 1.8] as const;
export type SqlEditorLineHeight = (typeof SQL_EDITOR_LINE_HEIGHT_OPTIONS)[number];
export const DEFAULT_SQL_EDITOR_LINE_HEIGHT: SqlEditorLineHeight = 1.6;

export const DEFAULT_SQL_EDITOR_FONT_FAMILY = "Cascadia Code";

export function clampSqlEditorFontSize(value: number): SqlEditorFontSize {
  const n = Math.round(value);
  if ((SQL_EDITOR_FONT_SIZE_OPTIONS as readonly number[]).includes(n)) {
    return n as SqlEditorFontSize;
  }
  return DEFAULT_SQL_EDITOR_FONT_SIZE;
}

export function clampSqlEditorLineHeight(value: number): SqlEditorLineHeight {
  const stepped = Math.round(value * 10) / 10;
  if ((SQL_EDITOR_LINE_HEIGHT_OPTIONS as readonly number[]).includes(stepped)) {
    return stepped as SqlEditorLineHeight;
  }
  return DEFAULT_SQL_EDITOR_LINE_HEIGHT;
}

/** 文件详情预览允许的最大文件大小（字节）。 */
export const FILE_PREVIEW_THRESHOLD_OPTIONS = [
  256 * 1024,
  512 * 1024,
  1024 * 1024,
  2 * 1024 * 1024,
  5 * 1024 * 1024,
  10 * 1024 * 1024,
] as const;
export type FilePreviewThresholdBytes = (typeof FILE_PREVIEW_THRESHOLD_OPTIONS)[number];
export const DEFAULT_FILE_PREVIEW_THRESHOLD_BYTES: FilePreviewThresholdBytes = 1024 * 1024;

export function clampFilePreviewThresholdBytes(value: number): FilePreviewThresholdBytes {
  const n = Math.round(value);
  if ((FILE_PREVIEW_THRESHOLD_OPTIONS as readonly number[]).includes(n)) {
    return n as FilePreviewThresholdBytes;
  }
  return DEFAULT_FILE_PREVIEW_THRESHOLD_BYTES;
}

interface SettingsState {
  locale: Locale;
  uiDensity: UiDensity;
  uiScale: number;
  theme: Theme;
  accentColor: AccentColor;
  proxy: ProxyConfig;
  aiDisplayMode: AiDisplayMode;
  aiDockWidth: number;
  detailPanelMode: DetailPanelMode;
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalLineHeight: number;
  terminalCursorStyle: TerminalCursorStyle;
  terminalCursorBlink: boolean;
  terminalScrollback: number;
  terminalGpuAccel: boolean;
  terminalCopyOnSelect: boolean;
  terminalHistoryPersist: boolean;
  terminalHistoryMaxBlocks: number;
  knowledgeChunkSize: number;
  knowledgeChunkOverlap: number;
  knowledgeTopN: number;
  knowledgeEmbeddingModelSelectionId: string | null;
  /** 表单填充场景默认模型（aiModelsStore selection id） */
  aiScenarioFormFillModelSelectionId: string | null;
  /** AI 助手场景默认模型（aiModelsStore selection id） */
  aiScenarioAssistantModelSelectionId: string | null;
  /** 终端内联 AI 默认模型 */
  aiScenarioTerminalModelSelectionId: string | null;
  /** 终端命令审批档位：严格 / 查看 / 宽松 */
  terminalApprovalMode: import("../modules/terminal/terminalApprovalPolicy").TerminalApprovalMode;
  databaseQueryPageSize: DatabaseQueryPageSize;
  sqlEditorFontFamily: string;
  sqlEditorFontSize: SqlEditorFontSize;
  sqlEditorLineHeight: SqlEditorLineHeight;
  filePreviewThresholdBytes: FilePreviewThresholdBytes;
  /** 文件索引存储目录，空字符串表示默认 ~/.omnipd/files/index */
  fileIndexStorageDir: string;
  resolved: "light" | "dark";
  setLocale: (locale: Locale) => void;
  setUiDensity: (density: UiDensity) => void;
  setUiScale: (percent: number) => void;
  setTheme: (theme: Theme) => void;
  setAccentColor: (color: AccentColor) => void;
  setProxy: (proxy: ProxyConfig) => void;
  setAiDisplayMode: (mode: AiDisplayMode) => void;
  setAiDockWidth: (width: number) => void;
  setDetailPanelMode: (mode: DetailPanelMode) => void;
  setTerminalSettings: (patch: Partial<Pick<SettingsState,
    "terminalFontFamily" | "terminalFontSize" | "terminalLineHeight" |
    "terminalCursorStyle" | "terminalCursorBlink" | "terminalScrollback" |
    "terminalGpuAccel" | "terminalCopyOnSelect" | "terminalHistoryPersist" |
    "terminalHistoryMaxBlocks"
  >>) => void;
  setKnowledgeSettings: (patch: Partial<Pick<SettingsState,
    "knowledgeChunkSize" | "knowledgeChunkOverlap" | "knowledgeTopN" | "knowledgeEmbeddingModelSelectionId"
  >>) => void;
  setAiScenarioSettings: (patch: Partial<Pick<SettingsState,
    "aiScenarioFormFillModelSelectionId" | "aiScenarioAssistantModelSelectionId" | "aiScenarioTerminalModelSelectionId"
  >>) => void;
  setTerminalApprovalMode: (
    mode: import("../modules/terminal/terminalApprovalPolicy").TerminalApprovalMode,
  ) => void;
  setDatabaseSettings: (patch: Partial<Pick<SettingsState,
    "databaseQueryPageSize" | "sqlEditorFontFamily" | "sqlEditorFontSize" | "sqlEditorLineHeight"
  >>) => void;
  setFileSettings: (patch: Partial<Pick<SettingsState, "filePreviewThresholdBytes" | "fileIndexStorageDir">>) => void;
}

export function clampUiScale(percent: number): number {
  const stepped = Math.round(percent / UI_SCALE.step) * UI_SCALE.step;
  return Math.min(UI_SCALE.max, Math.max(UI_SCALE.min, stepped));
}

function applyDocumentUiScale(percent: number) {
  const scale = clampUiScale(percent) / 100;
  document.documentElement.style.setProperty("--ui-scale", String(scale));
  document.documentElement.setAttribute("data-ui-scale", String(clampUiScale(percent)));
  document.documentElement.style.zoom = String(scale);
}

function applyDocumentLocale(locale: Locale) {
  document.documentElement.lang = locale;
}

function applyDocumentAccentColor(color: AccentColor) {
  const palette = ACCENT_PRESETS[color];
  const root = document.documentElement;
  root.style.setProperty("--accent", palette.accent);
  root.style.setProperty("--accent-hover", palette.accentHover);
  root.style.setProperty("--accent-active", palette.accentActive);
  root.style.setProperty("--accent-soft", palette.accentSoft);
  // 同步 Tailwind 别名
  root.style.setProperty("--color-accent", palette.accent);
  root.style.setProperty("--color-accent-hover", palette.accentHover);
  root.style.setProperty("--color-accent-active", palette.accentActive);
  root.style.setProperty("--color-accent-soft", palette.accentSoft);
  root.setAttribute("data-accent", color);
}

function getSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(theme: Theme): "light" | "dark" {
  return theme === "system" ? getSystemTheme() : theme;
}

function applyDocumentTheme(theme: Theme): "light" | "dark" {
  const resolved = resolveTheme(theme);
  document.documentElement.setAttribute("data-theme", resolved);
  return resolved;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      locale: "zh-CN",
      uiDensity: "standard",
      uiScale: UI_SCALE.default,
      theme: "system",
      accentColor: "blue",
      proxy: { ...DEFAULT_PROXY },
      aiDisplayMode: "subwindow",
      aiDockWidth: AI_DOCK_WIDTH_DEFAULT,
      detailPanelMode: "drawer",
      terminalFontFamily: "Cascadia Code",
      terminalFontSize: 13,
      terminalLineHeight: 1.6,
      terminalCursorStyle: "bar",
      terminalCursorBlink: true,
      terminalScrollback: 10000,
      terminalGpuAccel: true,
      terminalCopyOnSelect: false,
      terminalHistoryPersist: true,
      terminalHistoryMaxBlocks: 200,
      knowledgeChunkSize: KNOWLEDGE_CHUNK_SIZE.default,
      knowledgeChunkOverlap: KNOWLEDGE_CHUNK_OVERLAP.default,
      knowledgeTopN: KNOWLEDGE_TOP_N.default,
      knowledgeEmbeddingModelSelectionId: null,
      aiScenarioFormFillModelSelectionId: null,
      aiScenarioAssistantModelSelectionId: null,
      aiScenarioTerminalModelSelectionId: null,
      terminalApprovalMode: "view",
      databaseQueryPageSize: DEFAULT_DATABASE_QUERY_PAGE_SIZE,
      sqlEditorFontFamily: DEFAULT_SQL_EDITOR_FONT_FAMILY,
      sqlEditorFontSize: DEFAULT_SQL_EDITOR_FONT_SIZE,
      sqlEditorLineHeight: DEFAULT_SQL_EDITOR_LINE_HEIGHT,
      filePreviewThresholdBytes: DEFAULT_FILE_PREVIEW_THRESHOLD_BYTES,
      fileIndexStorageDir: "",
      resolved: resolveTheme("system"),
      setLocale: (locale) => {
        applyDocumentLocale(locale);
        set({ locale });
      },
      setUiDensity: (uiDensity) => set({ uiDensity }),
      setUiScale: (percent) => {
        const uiScale = clampUiScale(percent);
        applyDocumentUiScale(uiScale);
        set({ uiScale });
      },
      setTheme: (theme) => {
        const resolved = applyDocumentTheme(theme);
        set({ theme, resolved });
      },
      setAccentColor: (accentColor) => {
        applyDocumentAccentColor(accentColor);
        set({ accentColor });
      },
      setProxy: (proxy) => set({ proxy }),
      setAiDisplayMode: (aiDisplayMode) => set({ aiDisplayMode }),
      setAiDockWidth: (aiDockWidth) => set({ aiDockWidth }),
      setDetailPanelMode: (detailPanelMode) => set({ detailPanelMode }),
      setTerminalSettings: (patch) => set(patch),
      setKnowledgeSettings: (patch) =>
        set((state) => {
          const chunkSize = patch.knowledgeChunkSize ?? state.knowledgeChunkSize;
          const nextChunkSize = clampKnowledgeChunkSize(chunkSize);
          const nextOverlap =
            patch.knowledgeChunkOverlap !== undefined
              ? clampKnowledgeChunkOverlap(patch.knowledgeChunkOverlap, nextChunkSize)
              : clampKnowledgeChunkOverlap(state.knowledgeChunkOverlap, nextChunkSize);
          return {
            ...patch,
            knowledgeChunkSize: nextChunkSize,
            knowledgeChunkOverlap: nextOverlap,
            knowledgeTopN:
              patch.knowledgeTopN !== undefined
                ? clampKnowledgeTopN(patch.knowledgeTopN)
                : state.knowledgeTopN,
          };
        }),
      setAiScenarioSettings: (patch) => set(patch),
      setTerminalApprovalMode: (terminalApprovalMode) => set({ terminalApprovalMode }),
      setDatabaseSettings: (patch) =>
        set((state) => ({
          databaseQueryPageSize:
            patch.databaseQueryPageSize !== undefined
              ? clampDatabaseQueryPageSize(patch.databaseQueryPageSize)
              : state.databaseQueryPageSize,
          sqlEditorFontFamily:
            patch.sqlEditorFontFamily !== undefined
              ? patch.sqlEditorFontFamily.trim() || DEFAULT_SQL_EDITOR_FONT_FAMILY
              : state.sqlEditorFontFamily,
          sqlEditorFontSize:
            patch.sqlEditorFontSize !== undefined
              ? clampSqlEditorFontSize(patch.sqlEditorFontSize)
              : state.sqlEditorFontSize,
          sqlEditorLineHeight:
            patch.sqlEditorLineHeight !== undefined
              ? clampSqlEditorLineHeight(patch.sqlEditorLineHeight)
              : state.sqlEditorLineHeight,
        })),
      setFileSettings: (patch) =>
        set((state) => ({
          filePreviewThresholdBytes:
            patch.filePreviewThresholdBytes !== undefined
              ? clampFilePreviewThresholdBytes(patch.filePreviewThresholdBytes)
              : state.filePreviewThresholdBytes,
          fileIndexStorageDir:
            patch.fileIndexStorageDir !== undefined
              ? patch.fileIndexStorageDir.trim()
              : state.fileIndexStorageDir,
        })),
    }),
    {
      name: "omnipanel-settings",
      // resolved 为派生态（依赖系统主题），不持久化
      partialize: (state) => ({
        locale: state.locale,
        uiDensity: state.uiDensity,
        uiScale: state.uiScale,
        theme: state.theme,
        accentColor: state.accentColor,
        proxy: state.proxy,
        aiDisplayMode: state.aiDisplayMode,
        aiDockWidth: state.aiDockWidth,
        detailPanelMode: state.detailPanelMode,
        terminalFontFamily: state.terminalFontFamily,
        terminalFontSize: state.terminalFontSize,
        terminalLineHeight: state.terminalLineHeight,
        terminalCursorStyle: state.terminalCursorStyle,
        terminalCursorBlink: state.terminalCursorBlink,
        terminalScrollback: state.terminalScrollback,
        terminalGpuAccel: state.terminalGpuAccel,
        terminalCopyOnSelect: state.terminalCopyOnSelect,
        terminalHistoryPersist: state.terminalHistoryPersist,
        terminalHistoryMaxBlocks: state.terminalHistoryMaxBlocks,
        knowledgeChunkSize: state.knowledgeChunkSize,
        knowledgeChunkOverlap: state.knowledgeChunkOverlap,
        knowledgeTopN: state.knowledgeTopN,
        knowledgeEmbeddingModelSelectionId: state.knowledgeEmbeddingModelSelectionId,
        aiScenarioFormFillModelSelectionId: state.aiScenarioFormFillModelSelectionId,
        aiScenarioAssistantModelSelectionId: state.aiScenarioAssistantModelSelectionId,
        aiScenarioTerminalModelSelectionId: state.aiScenarioTerminalModelSelectionId,
        terminalApprovalMode: state.terminalApprovalMode,
        databaseQueryPageSize: state.databaseQueryPageSize,
        sqlEditorFontFamily: state.sqlEditorFontFamily,
        sqlEditorFontSize: state.sqlEditorFontSize,
        sqlEditorLineHeight: state.sqlEditorLineHeight,
        filePreviewThresholdBytes: state.filePreviewThresholdBytes,
        fileIndexStorageDir: state.fileIndexStorageDir,
      }),
      onRehydrateStorage: () => (state) => {
        applyDocumentLocale(state?.locale ?? "zh-CN");
        applyDocumentUiScale(state?.uiScale ?? UI_SCALE.default);
        applyDocumentAccentColor(state?.accentColor ?? "blue");
        const resolved = applyDocumentTheme(state?.theme ?? "system");
        useSettingsStore.setState({
          resolved,
          databaseQueryPageSize:
            state?.databaseQueryPageSize ?? DEFAULT_DATABASE_QUERY_PAGE_SIZE,
          filePreviewThresholdBytes:
            state?.filePreviewThresholdBytes ?? DEFAULT_FILE_PREVIEW_THRESHOLD_BYTES,
          fileIndexStorageDir: state?.fileIndexStorageDir ?? "",
        });
      },
    }
  )
);

applyDocumentLocale(useSettingsStore.getState().locale);
applyDocumentUiScale(useSettingsStore.getState().uiScale);
applyDocumentAccentColor(useSettingsStore.getState().accentColor);

/** 应用启动时调用：应用当前语言与主题，并监听系统主题变化。 */
export function initSettings() {
  const state = useSettingsStore.getState();
  applyDocumentLocale(state.locale);
  applyDocumentUiScale(state.uiScale);
  applyDocumentAccentColor(state.accentColor);
  applyDocumentTheme(state.theme);

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (useSettingsStore.getState().theme === "system") {
      useSettingsStore.setState({ resolved: applyDocumentTheme("system") });
    }
  });
}

export const LOCALE_OPTIONS: { value: Locale; labelKey: "settings.language.zhCN" | "settings.language.enUS" }[] = [
  { value: "zh-CN", labelKey: "settings.language.zhCN" },
  { value: "en-US", labelKey: "settings.language.enUS" },
];
