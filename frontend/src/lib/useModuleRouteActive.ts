import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { MODULE_PATHS, type ModuleKey } from "./paths";
import { parseModuleWindowParams } from "./moduleWindow";
import { useModuleSuspended } from "./moduleVisibility";

/** 独立窗生命周期内不变，避免每次 render 重复解析 window label。 */
let cachedModuleWindowKey: ModuleKey | null | undefined;

function currentModuleWindowKey(): ModuleKey | null {
  if (cachedModuleWindowKey === undefined) {
    cachedModuleWindowKey = parseModuleWindowParams()?.moduleKey ?? null;
  }
  return cachedModuleWindowKey;
}

/**
 * 模块面板是否处于「激活路由 / live」状态。
 * 独立窗内恒为该模块 live（不依赖 MemoryRouter pathname），
 * 避免 UI Follow 误导航后顶栏 `enabled={false}` 把 Tab 栏藏掉。
 */
export function useModuleRouteActive(moduleKey: ModuleKey): {
  isActiveRoute: boolean;
  moduleLive: boolean;
} {
  const location = useLocation();
  const moduleSuspended = useModuleSuspended();
  const modulePath = MODULE_PATHS[moduleKey];

  const standalone = useMemo(
    () => currentModuleWindowKey() === moduleKey,
    [moduleKey],
  );

  const isActiveRoute =
    standalone ||
    location.pathname === modulePath ||
    location.pathname.startsWith(`${modulePath}/`);

  const moduleLive = isActiveRoute && !moduleSuspended;
  return { isActiveRoute, moduleLive };
}
