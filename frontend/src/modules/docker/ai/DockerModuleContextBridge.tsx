import { useEffect, useRef } from "react";

import { mountModuleContextProvider, updateRegisteredProviderContext } from "../../../lib/ai/context";
import {
  dockerModuleContextProvider,
  DockerModuleContextProvider,
} from "./DockerModuleContextProvider";
import type { DockerModuleContext } from "./types";
import { isDockerModuleContextEmpty } from "./types";

export interface DockerModuleContextBridgeProps {
  active: boolean;
  context: DockerModuleContext;
}

export function DockerModuleContextBridge({ active, context }: DockerModuleContextBridgeProps) {
  const providerRef = useRef<DockerModuleContextProvider>(dockerModuleContextProvider);

  useEffect(() => mountModuleContextProvider(providerRef.current), []);

  useEffect(() => {
    if (!active || isDockerModuleContextEmpty(context)) {
      updateRegisteredProviderContext(providerRef.current, null);
      return;
    }
    updateRegisteredProviderContext(providerRef.current, context);
  }, [active, context]);

  return null;
}
