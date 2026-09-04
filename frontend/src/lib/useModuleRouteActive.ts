import type { ModuleKey } from "./paths";
import { parseModuleWindowParams } from "./moduleWindow";
import { useModuleVisibility } from "./moduleVisibility";

/**
 * 独立窗 moduleKey 缓存：只缓存解析成功的值。
 * 禁止把 null 永久写进缓存——首帧若注入/URL 尚未可读，会把整窗误判成「非独立窗」，
 * 之后 MemoryRouter 一旦被误导航，顶栏 `enabled={false}` 就会把窗口控制一并藏掉。
 */
let cachedModuleWindowKey: ModuleKey | undefined;

function currentModuleWindowKey(): ModuleKey | null {
  if (cachedModuleWindowKey !== undefined) {
    return cachedModuleWindowKey;
  }
  const parsed = parseModuleWindowParams()?.moduleKey ?? null;
  if (parsed != null) {
    cachedModuleWindowKey = parsed;
  }
  return parsed;
}

/**
 * 模块面板是否处于「激活路由 / live」状态。
 *
 * 主窗内用 ModuleVisibility.active（由叠层 Overlay 注入），**不订阅 useLocation**，
 * 避免路由切换时所有 keepLayout 模块因 Router context 全量重渲。
 * 独立窗内恒为该模块 live（不依赖 MemoryRouter pathname / suspended），
 * 避免 UI Follow 误导航或交互抖动后顶栏 `enabled={false}` 把 Tab 栏（含窗口控制）藏掉。
 */
export function useModuleRouteActive(moduleKey: ModuleKey): {
  isActiveRoute: boolean;
  moduleLive: boolean;
  /** 当前 WebView 是否为该模块的独立窗 */
  standalone: boolean;
} {
  const { active, suspended: moduleSuspended } = useModuleVisibility();

  // 不走 useMemo：解析结果可能从「暂不可用」变为可用，依赖 [moduleKey] 会卡在 false
  const standalone = currentModuleWindowKey() === moduleKey;

  // 独立窗：不依赖 Overlay active。主窗：与 Overlay 的 active 对齐。
  const isActiveRoute = standalone || active;

  // 独立窗始终 live：Tab 栏即标题栏，不能因 suspended / 路由抖动关掉
  const moduleLive = standalone || (isActiveRoute && !moduleSuspended);
  return { isActiveRoute, moduleLive, standalone };
}
