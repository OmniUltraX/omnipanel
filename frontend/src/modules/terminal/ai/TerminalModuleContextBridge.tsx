import { useEffect, useRef } from "react";
import { mountModuleContextProvider, updateRegisteredProviderContext } from "../../../lib/ai/context";
import {
  terminalModuleContextProvider,
  TerminalModuleContextProvider,
} from "./TerminalModuleContextProvider";
import type { TerminalModuleContext } from "./types";
import { isTerminalModuleContextEmpty } from "./types";

export interface TerminalModuleContextBridgeProps {
  active: boolean;
  context: TerminalModuleContext;
}

/**
 * ContextBridge 契约（各模块共用）：
 * 1. mount 时 `mountModuleContextProvider(provider)` 一次；
 * 2. `active === true` 且上下文非空 → `updateRegisteredProviderContext(provider, ctx)`；
 * 3. 非 active 或空上下文 → 传 `null` 清理，避免模块串台；
 * 4. 子会话继承：由 subConversationRunner 复制父 AiContextBundle，模块桥不自动跨会话推送。
 */
export function TerminalModuleContextBridge({ active, context }: TerminalModuleContextBridgeProps) {
  const providerRef = useRef<TerminalModuleContextProvider>(terminalModuleContextProvider);

  useEffect(() => mountModuleContextProvider(providerRef.current), []);

  useEffect(() => {
    if (!active || isTerminalModuleContextEmpty(context)) {
      updateRegisteredProviderContext(providerRef.current, null);
      return;
    }
    updateRegisteredProviderContext(providerRef.current, context);
  }, [active, context]);

  return null;
}
