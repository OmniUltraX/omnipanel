import {
  lazy,
  useMemo,
  type LazyExoticComponent,
  type ReactElement,
  type ComponentType,
} from "react";
import { OverlayModuleRoutePanel } from "../../components/ui/feedback";
import {
  isDashboardPath,
  MODULE_PATHS,
  pluginModuleKeyFromPath,
} from "../../lib/paths";
import {
  isOverlayModuleKey,
  type OverlayModuleKey,
} from "../../lib/routePanels";
import { PluginModuleHost } from "../plugin-module/PluginModuleHost";
import { ensureBuiltinModulesRegistered } from "./builtinModules";
import { getModule, listModules } from "./registry";
import type { ModuleDescriptor, ModuleRegistryId } from "./types";

ensureBuiltinModulesRegistered();

const lazyViewCache = new Map<
  ModuleRegistryId,
  LazyExoticComponent<ComponentType<object>>
>();
const viewElementCache = new Map<ModuleRegistryId, ReactElement>();
const pluginElementCache = new Map<string, ReactElement>();

function getLazyView(
  descriptor: ModuleDescriptor,
): LazyExoticComponent<ComponentType<object>> {
  let cached = lazyViewCache.get(descriptor.id);
  if (!cached) {
    cached = lazy(descriptor.loadView);
    lazyViewCache.set(descriptor.id, cached);
  }
  return cached;
}

/** 稳定 children 引用，供 OverlayModuleRoutePanel memo 跳过无关重渲 */
function getViewElement(descriptor: ModuleDescriptor): ReactElement {
  let el = viewElementCache.get(descriptor.id);
  if (!el) {
    const Comp = getLazyView(descriptor);
    el = <Comp />;
    viewElementCache.set(descriptor.id, el);
  }
  return el;
}

function getPluginElement(moduleKey: string): ReactElement {
  let el = pluginElementCache.get(moduleKey);
  if (!el) {
    el = <PluginModuleHost moduleKey={moduleKey} />;
    pluginElementCache.set(moduleKey, el);
  }
  return el;
}

function isPathActive(pathname: string, descriptor: ModuleDescriptor): boolean {
  if (descriptor.id === "dashboard") {
    return isDashboardPath(pathname);
  }
  if (isOverlayModuleKey(descriptor.id)) {
    return pathname === MODULE_PATHS[descriptor.id];
  }
  // plugin:${key}
  const pluginKey = descriptor.id.startsWith("plugin:")
    ? descriptor.id.slice("plugin:".length)
    : null;
  if (pluginKey) {
    return pluginModuleKeyFromPath(pathname) === pluginKey;
  }
  return pathname === descriptor.path;
}

export interface ModuleHostProps {
  pathname: string;
  /** 叠层内核模块挂载表（由 App keepAlive 计算） */
  overlayMounted: Record<OverlayModuleKey, boolean>;
  /** 当前保活集合中的插件 moduleKey */
  keptPluginKeys: string[];
}

/**
 * 按 registry 渲染叠层模块壳。
 * keepAlive / pin 仍由 App 计算后传入，P0 只统一渲染入口。
 */
export function ModuleHost({
  pathname,
  overlayMounted,
  keptPluginKeys,
}: ModuleHostProps) {
  const overlayDescriptors = useMemo(() => {
    return listModules().filter(
      (d): d is ModuleDescriptor & { id: OverlayModuleKey } =>
        isOverlayModuleKey(d.id),
    );
  }, []);

  const dashboard = getModule("dashboard");
  const pluginActiveKey = pluginModuleKeyFromPath(pathname);

  return (
    <>
      {dashboard ? (
        <OverlayModuleRoutePanel
          active={isPathActive(pathname, dashboard)}
          mounted
          keepLayout={dashboard.keepLayout}
          panelId="dashboard"
        >
          {getViewElement(dashboard)}
        </OverlayModuleRoutePanel>
      ) : null}

      {overlayDescriptors.map((descriptor) => (
        <OverlayModuleRoutePanel
          key={descriptor.id}
          active={isPathActive(pathname, descriptor)}
          mounted={overlayMounted[descriptor.id] === true}
          keepLayout={descriptor.keepLayout}
          panelId={descriptor.id}
        >
          {getViewElement(descriptor)}
        </OverlayModuleRoutePanel>
      ))}

      {keptPluginKeys.map((key) => (
        <OverlayModuleRoutePanel
          key={`plugin:${key}`}
          active={pluginActiveKey === key}
          mounted
          panelId={`plugin:${key}`}
        >
          {getPluginElement(key)}
        </OverlayModuleRoutePanel>
      ))}
    </>
  );
}
