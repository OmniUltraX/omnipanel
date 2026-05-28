import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Locale = "zh-CN" | "en-US";
export type UiDensity = "compact" | "standard" | "comfortable";

interface SettingsState {
  locale: Locale;
  uiDensity: UiDensity;
  setLocale: (locale: Locale) => void;
  setUiDensity: (density: UiDensity) => void;
}

function applyDocumentLocale(locale: Locale) {
  document.documentElement.lang = locale;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      locale: "zh-CN",
      uiDensity: "standard",
      setLocale: (locale) => {
        applyDocumentLocale(locale);
        set({ locale });
      },
      setUiDensity: (uiDensity) => set({ uiDensity }),
    }),
    {
      name: "omnipanel-settings",
      onRehydrateStorage: () => (state) => {
        if (state?.locale) {
          applyDocumentLocale(state.locale);
        }
      },
    }
  )
);

applyDocumentLocale(useSettingsStore.getState().locale);

export const LOCALE_OPTIONS: { value: Locale; labelKey: "settings.language.zhCN" | "settings.language.enUS" }[] = [
  { value: "zh-CN", labelKey: "settings.language.zhCN" },
  { value: "en-US", labelKey: "settings.language.enUS" },
];
