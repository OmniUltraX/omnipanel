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
 * 将 DatabasePanel 的实时状态同步到 {@link DatabaseModuleContextProvider}。
 *
 * ContextBridge 契约：active+非空 → 注册上下文；否则传 null 清理。
 * 子会话不由本桥自动推送，继承由 subConversationRunner 处理。
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
