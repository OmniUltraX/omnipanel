import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { SuspendedModulePanel } from "../../components/ui/feedback";
import {
  collectPinnedKeepAliveIds,
  createInitialKeepAliveState,
  keepAliveIdFromPath,
  overlayMountedRecordFromKeepAlive,
  pluginKeysFromKeepAlive,
  resolveOverlayKeepAliveMounted,
  touchOverlayKeepAlive,
  type OverlayKeepAliveState,
} from "../../lib/overlayKeepAlive";
import {
  DASHBOARD_PATH,
  MODULE_PATHS,
  MODULE_PREFIX,
  PLUGINS_PATH,
  STUDIO_PATH,
  WORKSPACE_PATHS,
  isDashboardPath,
  isPluginsPath,
  isStudioPath,
  isWorkspacePath,
  moduleKeyFromPath,
  pluginsStudioHref,
} from "../../lib/paths";
import {
  OVERLAY_MODULE_KEYS,
  isOverlayModuleKey,
  isShellRoutePath,
} from "../../lib/routePanels";
import { LazyPluginsPanel, LazyUserWorkspace } from "../../routes/lazyModules";
import { useWorkspaceBottomDockStore } from "../../stores/workspaceBottomDockStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { prepareModuleLocale } from "../../i18n";
import { ModuleHost } from "./ModuleHost";
import { ensureBuiltinModulesRegistered } from "./builtinModules";
import { notifyModuleEvicted } from "./sessionServices";
import { noteRouteLayoutCommit, recordRouteSwitch } from "../../lib/moduleSwitchPerf";
import {
  listShellWarmRequested,
  subscribeModuleShellWarm,
} from "../../lib/moduleWarmup";

ensureBuiltinModulesRegistered();

/**
 * 叠层保活 + ModuleHost + shell Routes。
 * memo 且无 props：AppShell 因抽屉/设置等重渲时跳过本树，仅 pathname/pin 变化时更新。
 */
export const ModuleRuntimeOutlet = memo(function ModuleRuntimeOutlet() {
  const location = useLocation();
  const pathname = location.pathname;
  const locale = useSettingsStore((s) => s.locale);
  const isPlugins = isPluginsPath(pathname);
  const isShellRoute = isShellRoutePath(pathname) && !isDashboardPath(pathname);

  useEffect(() => {
    const key = moduleKeyFromPath(pathname);
    if (key && isOverlayModuleKey(key)) {
      void prepareModuleLocale(locale, key);
    } else if (isPluginsPath(pathname)) {
      void prepareModuleLocale(locale, "plugins");
    } else if (isStudioPath(pathname)) {
      // studio 文案在 plugins 分片（plugins.studio.*）+ routes 分片（routes.studio，后者随 boot 预载）
      void prepareModuleLocale(locale, "plugins");
    } else if (isDashboardPath(pathname)) {
      void prepareModuleLocale(locale, "dashboard");
    }
  }, [pathname, locale]);

  const [keepAlive, setKeepAlive] = useState<OverlayKeepAliveState>(() =>
    createInitialKeepAliveState(pathname),
  );
  // 路由已变时同步推进保活（勿等 useEffect）：否则首帧 overlayMounted[current]=false，
  // ModuleHost 直接 return null，表现为「点了模块却切不过去 / 空白一帧卡死」。
  const routeKeepAliveId = keepAliveIdFromPath(pathname);
  if (keepAlive.current !== routeKeepAliveId) {
    setKeepAlive((prev) => touchOverlayKeepAlive(prev, routeKeepAliveId));
  }
  const tabsByWorkspace = useWorkspaceBottomDockStore((s) => s.tabsByWorkspace);
  const pinnedKeepAlive = useMemo(
    () => collectPinnedKeepAliveIds(tabsByWorkspace),
    [tabsByWorkspace],
  );
  const keepAliveMounted = useMemo(
    () => resolveOverlayKeepAliveMounted(keepAlive, pinnedKeepAlive),
    [keepAlive, pinnedKeepAlive],
  );
  // 预挂壳（空闲/悬停预热）：并入挂载集，suspended 渲染；retain-all 下永不卸载。
  // 注意 ordered-set 语义：此处只读快照，re-render 由 warmTick 驱动。
  const [warmTick, setWarmTick] = useState(0);
  useEffect(() => subscribeModuleShellWarm(() => setWarmTick((t) => t + 1)), []);
  const mountedWithWarm = useMemo(() => {
    void warmTick;
    const merged = new Set(keepAliveMounted);
    for (const key of listShellWarmRequested()) merged.add(key);
    // 双保险：pathname 对应模块同帧必挂（含 keepAlive 尚未提交的那一帧）
    if (routeKeepAliveId) merged.add(routeKeepAliveId);
    return merged;
  }, [keepAliveMounted, warmTick, routeKeepAliveId]);
  const overlayMounted = useMemo(
    () => overlayMountedRecordFromKeepAlive(mountedWithWarm),
    [mountedWithWarm],
  );
  const keptPluginKeys = useMemo(
    () => pluginKeysFromKeepAlive(mountedWithWarm),
    [mountedWithWarm],
  );
  // 秒切回 P0 探针：记录每次路由切换的提交+首帧耗时与堆内存
  const prevPathRef = useRef(pathname);
  // layout 打点：DOM 落子时刻（区分 JS 提交 vs 布局绘制），必须同步调用
  useLayoutEffect(() => {
    noteRouteLayoutCommit();
  }, [pathname]);
  useEffect(() => {
    const from = prevPathRef.current;
    try {
      window.localStorage.setItem(
        "__omniNavDbg",
        JSON.stringify({ from, to: pathname, at: Date.now() }),
      );
    } catch {
      /* ignore */
    }
    if (from !== pathname) {
      recordRouteSwitch(from, pathname);
      prevPathRef.current = pathname;
    }
  }, [pathname]);

  const prevKeepAliveMountedRef = useRef(keepAliveMounted);
  useEffect(() => {
    const prev = prevKeepAliveMountedRef.current;
    prevKeepAliveMountedRef.current = keepAliveMounted;
    for (const id of prev) {
      if (!keepAliveMounted.has(id)) {
        notifyModuleEvicted(id);
      }
    }
  }, [keepAliveMounted]);

  return (
    <div className="content-routes">
      <ModuleHost
        pathname={pathname}
        overlayMounted={overlayMounted}
        keptPluginKeys={keptPluginKeys}
      />
      <div className={`route-panel${isShellRoute ? " route-panel--active" : ""}`}>
        <Routes>
          <Route path="/" element={<Navigate to={DASHBOARD_PATH} replace />} />
          <Route path={DASHBOARD_PATH} element={null} />
          <Route
            path={`${WORKSPACE_PATHS.list}/:workspaceId`}
            element={
              <SuspendedModulePanel active={isWorkspacePath(pathname)}>
                <LazyUserWorkspace />
              </SuspendedModulePanel>
            }
          />
          <Route
            path={PLUGINS_PATH}
            element={
              <SuspendedModulePanel active={isPlugins}>
                <LazyPluginsPanel />
              </SuspendedModulePanel>
            }
          />
          <Route
            path={STUDIO_PATH}
            element={<Navigate to={pluginsStudioHref()} replace />}
          />
          {OVERLAY_MODULE_KEYS.map((key) => (
            <Route key={key} path={MODULE_PATHS[key]} element={null} />
          ))}
          <Route path={`${MODULE_PREFIX}/:moduleKey`} element={null} />
          <Route path="*" element={<Navigate to={DASHBOARD_PATH} replace />} />
        </Routes>
      </div>
    </div>
  );
});
