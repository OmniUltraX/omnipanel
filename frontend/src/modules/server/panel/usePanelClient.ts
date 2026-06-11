import { useMemo } from "react";
import { createBtPanelClient } from "../../../lib/btpanel";
import { createOnePanelClient } from "../../../lib/onepanel";
import type { ServerEntry } from "./serverConnection";

export function usePanelClient(server: ServerEntry | null) {
  return useMemo(() => {
    if (!server) return null;
    if (server.serviceType === "1panel") {
      return createOnePanelClient(server.address, server.key);
    }
    return createBtPanelClient(server.address, server.key);
  }, [server?.address, server?.key, server?.serviceType]);
}
