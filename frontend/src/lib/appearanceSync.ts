/**
 * 跨独立 WebView 同步外观（主题 / 强调色 / 语言 / 缩放 / 密度）
 * 以及 AI 助手场景默认模型（与设置 → AI 场景一致）。
 *
 * Windows 下子窗必须使用独立 `data_directory`，与主窗 localStorage 隔离；
 * `storage` 事件与 zustand rehydrate 无法跨 profile，需走 Tauri App Event。
 */

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./isTauriRuntime";
import {
  useSettingsStore,
  type AccentColor,
  type Locale,
  type Theme,
  type UiDensity,
} from "../stores/settingsStore";

export const APPEARANCE_SYNC_EVENT = "omnipanel:appearance-sync";
export const APPEARANCE_REQUEST_EVENT = "omnipanel:appearance-request";

export interface AppearanceSnapshot {
  theme: Theme;
  themePackId?: string;
  accentColor: AccentColor;
  locale: Locale;
  uiScale: number;
  uiDensity: UiDensity;
  /** 助手场景默认模型；缺省字段表示旧主窗未广播，子窗保持本地值 */
  aiScenarioAssistantModelSelectionId?: string | null;
  /** 终端内联 AI 场景默认模型 */
  aiScenarioTerminalModelSelectionId?: string | null;
}

function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isAppearanceSnapshot(value: unknown): value is AppearanceSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    isTheme(v.theme) &&
    (typeof v.themePackId === "string" || v.themePackId === undefined) &&
    typeof v.accentColor === "string" &&
    typeof v.locale === "string" &&
    typeof v.uiScale === "number" &&
    typeof v.uiDensity === "string" &&
    (v.aiScenarioAssistantModelSelectionId === undefined ||
      isNullableString(v.aiScenarioAssistantModelSelectionId)) &&
    (v.aiScenarioTerminalModelSelectionId === undefined ||
      isNullableString(v.aiScenarioTerminalModelSelectionId))
  );
}

export function collectAppearanceSnapshot(): AppearanceSnapshot {
  const s = useSettingsStore.getState();
  return {
    theme: s.theme,
    themePackId: s.themePackId,
    accentColor: s.accentColor,
    locale: s.locale,
    uiScale: s.uiScale,
    uiDensity: s.uiDensity,
    aiScenarioAssistantModelSelectionId: s.aiScenarioAssistantModelSelectionId,
    aiScenarioTerminalModelSelectionId: s.aiScenarioTerminalModelSelectionId,
  };
}

export function applyAppearanceSnapshot(snapshot: AppearanceSnapshot): void {
  const store = useSettingsStore.getState();
  if (store.theme !== snapshot.theme) store.setTheme(snapshot.theme);
  if (snapshot.themePackId && store.themePackId !== snapshot.themePackId) {
    store.setThemePackId(snapshot.themePackId);
  }
  if (store.accentColor !== snapshot.accentColor) {
    store.setAccentColor(snapshot.accentColor);
  }
  if (store.locale !== snapshot.locale) store.setLocale(snapshot.locale);
  if (store.uiScale !== snapshot.uiScale) store.setUiScale(snapshot.uiScale);
  if (store.uiDensity !== snapshot.uiDensity) store.setUiDensity(snapshot.uiDensity);

  const scenarioPatch: {
    aiScenarioAssistantModelSelectionId?: string | null;
    aiScenarioTerminalModelSelectionId?: string | null;
  } = {};
  if (
    snapshot.aiScenarioAssistantModelSelectionId !== undefined &&
    store.aiScenarioAssistantModelSelectionId !== snapshot.aiScenarioAssistantModelSelectionId
  ) {
    scenarioPatch.aiScenarioAssistantModelSelectionId =
      snapshot.aiScenarioAssistantModelSelectionId;
  }
  if (
    snapshot.aiScenarioTerminalModelSelectionId !== undefined &&
    store.aiScenarioTerminalModelSelectionId !== snapshot.aiScenarioTerminalModelSelectionId
  ) {
    scenarioPatch.aiScenarioTerminalModelSelectionId =
      snapshot.aiScenarioTerminalModelSelectionId;
  }
  if (Object.keys(scenarioPatch).length > 0) {
    store.setAiScenarioSettings(scenarioPatch);
  }
}

export async function broadcastAppearance(
  snapshot: AppearanceSnapshot = collectAppearanceSnapshot(),
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await emit(APPEARANCE_SYNC_EVENT, snapshot);
  } catch (e) {
    console.warn("[appearanceSync] broadcast failed", e);
  }
}

/** 子窗主动向主窗请求当前外观（显示时 / 启动时）。 */
export async function requestAppearanceSync(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await emit(APPEARANCE_REQUEST_EVENT);
  } catch (e) {
    console.warn("[appearanceSync] request failed", e);
  }
}

/**
 * 主窗：设置变更时广播，并响应子窗请求。
 * 须在 settings persist 水合之后调用。
 */
export function initAppearanceSyncPublisher(): () => void {
  if (!isTauriRuntime()) return () => {};

  void broadcastAppearance();

  const unsubStore = useSettingsStore.subscribe((state, prev) => {
    if (
      state.theme === prev.theme &&
      state.themePackId === prev.themePackId &&
      state.accentColor === prev.accentColor &&
      state.locale === prev.locale &&
      state.uiScale === prev.uiScale &&
      state.uiDensity === prev.uiDensity &&
      state.aiScenarioAssistantModelSelectionId === prev.aiScenarioAssistantModelSelectionId &&
      state.aiScenarioTerminalModelSelectionId === prev.aiScenarioTerminalModelSelectionId
    ) {
      return;
    }
    void broadcastAppearance(collectAppearanceSnapshot());
  });

  let unlistenReq: UnlistenFn | undefined;
  void listen(APPEARANCE_REQUEST_EVENT, () => {
    void broadcastAppearance();
  }).then((fn) => {
    unlistenReq = fn;
  });

  return () => {
    unsubStore();
    unlistenReq?.();
  };
}

/**
 * 独立 WebView：监听主窗广播并应用；启动时主动请求一次。
 */
export function initAppearanceSyncSubscriber(): () => void {
  if (!isTauriRuntime()) return () => {};

  let unlisten: UnlistenFn | undefined;
  void listen<AppearanceSnapshot>(APPEARANCE_SYNC_EVENT, (event) => {
    if (!isAppearanceSnapshot(event.payload)) return;
    applyAppearanceSnapshot(event.payload);
  }).then((fn) => {
    unlisten = fn;
  });

  void requestAppearanceSync();

  return () => {
    unlisten?.();
  };
}
