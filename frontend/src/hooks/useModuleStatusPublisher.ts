import { useCallback } from "react";
import type { ModuleKey } from "../lib/paths";
import { publishModuleStatusLog, clearModuleStatusLog } from "../lib/moduleStatusLog";
import type { StatusBarLogLevel } from "../stores/statusBarLogStore";

/** 模块内向状态栏发布运行日志（仅当前激活模块生效） */
export function useModuleStatusPublisher(moduleKey: ModuleKey) {
  const publish = useCallback(
    (message: string, level?: StatusBarLogLevel) => {
      publishModuleStatusLog(moduleKey, message, level);
    },
    [moduleKey],
  );

  const clear = useCallback(() => {
    clearModuleStatusLog(moduleKey);
  }, [moduleKey]);

  return { publish, clear };
}
