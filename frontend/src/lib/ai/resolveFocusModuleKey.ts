import type { ModuleKey } from "../paths";
import { useStatusBarActionBarStore } from "../../stores/statusBarActionBarStore";

/**
 * 根据状态栏焦点 dock 推断当前主模块。
 * 与 AI moduleFilter / 「当前现场」条共用同一口径。
 *
 * @param dockScope `undefined` 时读取 activeDock；显式 `null` 表示无焦点。
 */
export function resolveFocusModuleKey(dockScope?: string | null): ModuleKey | null {
  const scope =
    dockScope === undefined
      ? useStatusBarActionBarStore.getState().activeDock?.dockScope ?? null
      : dockScope;
  if (!scope) return null;
  if (scope.startsWith("database")) return "database";
  if (scope.startsWith("terminal")) return "terminal";
  if (scope.startsWith("docker")) return "docker";
  if (scope.startsWith("files") || scope.startsWith("file")) return "files";
  if (scope.startsWith("ssh") || scope.startsWith("server")) return "ssh";
  return null;
}
