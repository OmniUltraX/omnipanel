import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useSettingsStore, type Locale } from "../stores/settingsStore";
import { DASHBOARD_PATH, PLUGINS_PATH } from "../lib/paths";
import {
  ensureModuleLocale,
  getLocaleBag,
  getLocaleRevision,
  loadBootLocale,
  seedLocaleChunks,
  subscribeLocaleRevision,
} from "./loadLocale";

// 启动默认 locale：同步打入 boot 包，避免首屏闪 key
import tags from "./locales/zh-CN/tags";
import app from "./locales/zh-CN/app";
import common from "./locales/zh-CN/common";
import ui from "./locales/zh-CN/ui";
import shell from "./locales/zh-CN/shell";
import routes from "./locales/zh-CN/routes";
import env from "./locales/zh-CN/env";
import resourceType from "./locales/zh-CN/resourceType";
import notifications from "./locales/zh-CN/notifications";
import quickInput from "./locales/zh-CN/quickInput";
import sidebarTree from "./locales/zh-CN/sidebarTree";
import resourceTags from "./locales/zh-CN/resourceTags";
import resource from "./locales/zh-CN/resource";
import share from "./locales/zh-CN/share";
import contentPreview from "./locales/zh-CN/contentPreview";
import stepUp from "./locales/zh-CN/stepUp";
import skillPrompt from "./locales/zh-CN/skillPrompt";
import logViewer from "./locales/zh-CN/logViewer";
import settings from "./locales/zh-CN/settings";
import workspace from "./locales/zh-CN/workspace";
import dashboard from "./locales/zh-CN/dashboard";
import homeWorkspace from "./locales/zh-CN/homeWorkspace";
import plugins from "./locales/zh-CN/plugins";
import ai from "./locales/zh-CN/ai";
import knowledge from "./locales/zh-CN/knowledge";
import userCenter from "./locales/zh-CN/userCenter";
import dataSync from "./locales/zh-CN/dataSync";

export type TranslationDict = typeof import("./locales/zh-CN").zhCN;
export type { Locale };

type Path = string;

seedLocaleChunks("zh-CN", {
  tags,
  app,
  common,
  ui,
  shell,
  routes,
  env,
  resourceType,
  notifications,
  quickInput,
  sidebarTree,
  resourceTags,
  resource,
  share,
  contentPreview,
  stepUp,
  skillPrompt,
  logViewer,
  settings,
  workspace,
  dashboard,
  homeWorkspace,
  plugins,
  ai,
  knowledge,
  userCenter,
  dataSync,
});

function getByPath(dict: Record<string, unknown>, path: Path): string | undefined {
  const parts = path.split(".");
  let current: unknown = dict;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

export function createTranslator(locale: Locale) {
  const dict = getLocaleBag(locale);
  const fallback = getLocaleBag("zh-CN");

  return function t(key: Path, params?: Record<string, string | number>): string {
    const template = getByPath(dict, key) ?? getByPath(fallback, key) ?? key;
    if (!params) return template;
    return Object.entries(params).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      template,
    );
  };
}

/** 应用启动 / 切语言时调用：加载该语言全部分片 */
export async function prepareLocale(locale: Locale): Promise<void> {
  await loadBootLocale(locale);
}

export async function prepareModuleLocale(
  locale: Locale,
  moduleKey: string,
): Promise<void> {
  await ensureModuleLocale(locale, moduleKey);
}

export function useI18n() {
  const locale = useSettingsStore((s) => s.locale);
  // 分片异步加载完成后必须重渲，否则会一直显示 key 名
  const localeRevision = useSyncExternalStore(
    subscribeLocaleRevision,
    getLocaleRevision,
    getLocaleRevision,
  );
  useEffect(() => {
    void prepareLocale(locale);
  }, [locale]);
  const t = useCallback(
    (key: Path, params?: Record<string, string | number>) => {
      return createTranslator(locale)(key, params);
    },
    [locale, localeRevision],
  );

  return { locale, t };
}

export function t(key: Path, params?: Record<string, string | number>, locale?: Locale) {
  const active = locale ?? useSettingsStore.getState().locale;
  return createTranslator(active)(key, params);
}

export function getEnvLabel(envKey: keyof TranslationDict["env"], locale?: Locale) {
  return t(`env.${String(envKey)}`, undefined, locale);
}

export function getResourceTypeLabel(
  type: keyof TranslationDict["resourceType"],
  locale?: Locale,
) {
  return t(`resourceType.${String(type)}`, undefined, locale);
}

export function getRouteTitle(path: string, locale?: Locale) {
  const map: Record<string, Path> = {
    "/": "routes.dashboard",
    [DASHBOARD_PATH]: "routes.dashboard",
    [PLUGINS_PATH]: "routes.plugins",
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
    "/cloud": "routes.cloud",
    "/nacos": "routes.nacos",
  };
  if (map[path]) return t(map[path], undefined, locale);
  if (path.startsWith("/module/")) {
    const key = path.slice("/module/".length);
    const routeKey = map[`/${key}`];
    if (routeKey) return t(routeKey, undefined, locale);
  }
  if (path.startsWith("/workspace/")) return t("routes.workspace", undefined, locale);
  return t("routes.default", undefined, locale);
}

export { ensureLocaleChunks } from "./loadLocale";
export { prepareModuleLocale as warmModuleLocale };
