import { memo, useEffect, useMemo, useRef, useState } from "react";
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
  WORKSPACE_PATHS,
  isDashboardPath,
  isPluginsPath,
  isWorkspacePath,
  moduleKeyFromPath,
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
    } else if (isDashboardPath(pathname)) {
      void prepareModuleLocale(locale, "dashboard");
    }
  }, [pathname, locale]);

  const [keepAlive, setKeepAlive] = useState<OverlayKeepAliveState>(() =>
    createInitialKeepAliveState(pathname),
  );
  const tabsByWorkspace = useWorkspaceBottomDockStore((s) => s.tabsByWorkspace);
  const pinnedKeepAlive = useMemo(
    () => collectPinnedKeepAliveIds(tabsByWorkspace),
    [tabsByWorkspace],
  );
  const keepAliveMounted = useMemo(
    () => resolveOverlayKeepAliveMounted(keepAlive, pinnedKeepAlive),
    [keepAlive, pinnedKeepAlive],
  );
  const overlayMounted = useMemo(
    () => overlayMountedRecordFromKeepAlive(keepAliveMounted),
    [keepAliveMounted],
  );
  const keptPluginKeys = useMemo(
    () => pluginKeysFromKeepAlive(keepAliveMounted),
    [keepAliveMounted],
  );

  useEffect(() => {
    const nextId = keepAliveIdFromPath(pathname);
    setKeepAlive((prev) => touchOverlayKeepAlive(prev, nextId));
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
