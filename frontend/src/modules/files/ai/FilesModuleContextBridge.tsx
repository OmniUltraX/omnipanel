import { useEffect, useRef } from "react";

import { mountModuleContextProvider, updateRegisteredProviderContext } from "../../../lib/ai/context";
import {
  filesModuleContextProvider,
  FilesModuleContextProvider,
} from "./FilesModuleContextProvider";
import type { FilesModuleContext } from "./types";
import { isFilesModuleContextEmpty } from "./types";

export interface FilesModuleContextBridgeProps {
  active: boolean;
  context: FilesModuleContext;
}

export function FilesModuleContextBridge({ active, context }: FilesModuleContextBridgeProps) {
  const providerRef = useRef<FilesModuleContextProvider>(filesModuleContextProvider);

  useEffect(() => mountModuleContextProvider(providerRef.current), []);

  useEffect(() => {
    if (!active || isFilesModuleContextEmpty(context)) {
      updateRegisteredProviderContext(providerRef.current, null);
      return;
    }
    updateRegisteredProviderContext(providerRef.current, context);
  }, [active, context]);

  return null;
}
