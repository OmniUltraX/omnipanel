import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Locale = "zh-CN" | "en-US";
export type UiDensity = "compact" | "standard" | "comfortable";
export type Theme = "system" | "light" | "dark";

interface SettingsState {
  locale: Locale;
  uiDensity: UiDensity;
  theme: Theme;
  resolved: "light" | "dark";
  setLocale: (locale: Locale) => void;
  setUiDensity: (density: UiDensity) => void;
  setTheme: (theme: Theme) => void;
}

function applyDocumentLocale(locale: Locale) {
  document.documentElement.lang = locale;
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
      theme: "system",
      resolved: resolveTheme("system"),
      setLocale: (locale) => {
        applyDocumentLocale(locale);
        set({ locale });
      },
      setUiDensity: (uiDensity) => set({ uiDensity }),
      setTheme: (theme) => {
        const resolved = applyDocumentTheme(theme);
        set({ theme, resolved });
      },
    }),
    {
      name: "omnipanel-settings",
      // resolved 为派生态（依赖系统主题），不持久化
      partialize: (state) => ({
        locale: state.locale,
        uiDensity: state.uiDensity,
        theme: state.theme,
      }),
      onRehydrateStorage: () => (state) => {
        applyDocumentLocale(state?.locale ?? "zh-CN");
        const resolved = applyDocumentTheme(state?.theme ?? "system");
        useSettingsStore.setState({ resolved });
      },
    }
  )
);

applyDocumentLocale(useSettingsStore.getState().locale);

/** 应用启动时调用：应用当前语言与主题，并监听系统主题变化。 */
export function initSettings() {
  const state = useSettingsStore.getState();
  applyDocumentLocale(state.locale);
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
