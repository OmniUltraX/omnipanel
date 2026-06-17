import { useCallback } from "react";
import { useSettingsStore, type Locale } from "../stores/settingsStore";
import { zhCN, type TranslationDict } from "./zh-CN";
import { enUS } from "./en-US";

export type { Locale, TranslationDict };

export const messages: Record<Locale, TranslationDict> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

type Path = string;

function getByPath(dict: TranslationDict, path: Path): string | undefined {
  const parts = path.split(".");
  let current: unknown = dict;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

export function createTranslator(locale: Locale) {
  const dict = messages[locale] ?? messages["zh-CN"];

  return function t(key: Path, params?: Record<string, string | number>): string {
    const template = getByPath(dict, key) ?? getByPath(messages["zh-CN"], key) ?? key;
    if (!params) return template;
    return Object.entries(params).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      template
    );
  };
}

export function useI18n() {
  const locale = useSettingsStore((s) => s.locale);
  const t = useCallback((key: Path, params?: Record<string, string | number>) => {
    return createTranslator(locale)(key, params);
  }, [locale]);

  return { locale, t };
}

export function t(key: Path, params?: Record<string, string | number>, locale?: Locale) {
  const active = locale ?? useSettingsStore.getState().locale;
  return createTranslator(active)(key, params);
}

export function getEnvLabel(env: keyof TranslationDict["env"], locale?: Locale) {
  return t(`env.${env}`, undefined, locale);
}

export function getResourceTypeLabel(type: keyof TranslationDict["resourceType"], locale?: Locale) {
  return t(`resourceType.${type}`, undefined, locale);
}

export function getRouteTitle(path: string, locale?: Locale) {
  const map: Record<string, Path> = {
    "/": "routes.workspace",
    "/terminal": "routes.terminal",
    "/database": "routes.database",
    "/docker": "routes.docker",
    "/ssh": "routes.ssh",
    "/server": "routes.server",
    "/protocol": "routes.protocol",
    "/workflow": "routes.workflow",
    "/knowledge": "routes.knowledge",
    "/files": "routes.files",
    "/settings": "routes.settings",
  };
  return t(map[path] ?? "routes.default", undefined, locale);
}
