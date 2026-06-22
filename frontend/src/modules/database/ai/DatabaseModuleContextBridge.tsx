import { useEffect, useRef } from "react";

import { mountModuleContextProvider, updateRegisteredProviderContext } from "../../../lib/ai/context";
import {
  databaseModuleContextProvider,
  DatabaseModuleContextProvider,
} from "./DatabaseModuleContextProvider";
import type { DatabaseModuleContext } from "./types";
import { isDatabaseModuleContextEmpty } from "./types";

export interface DatabaseModuleContextBridgeProps {
  /** 模块路由处于激活且未挂起时为 true */
  active: boolean;
  context: DatabaseModuleContext;
}

/**
 * 将 DatabasePanel 的实时状态同步到 {@link DatabaseModuleContextProvider}，
 * 供 AI 助手读取模块上下文。
 */
export function DatabaseModuleContextBridge({
  active,
  context,
}: DatabaseModuleContextBridgeProps) {
  const providerRef = useRef<DatabaseModuleContextProvider>(
    databaseModuleContextProvider,
  );

  useEffect(() => mountModuleContextProvider(providerRef.current), []);

  useEffect(() => {
    if (!active || isDatabaseModuleContextEmpty(context)) {
      updateRegisteredProviderContext(providerRef.current, null);
      return;
    }
    updateRegisteredProviderContext(providerRef.current, context);
  }, [active, context]);

  return null;
}
