import { useMemo } from "react";
import { createBtPanelClient } from "../../../lib/btpanel";
import { createOnePanelClient } from "../../../lib/onepanel";
import type { ServerEntry } from "./serverConnection";
import { isOnePanelService } from "./panelPlugin";

export function usePanelClient(server: ServerEntry | null) {
  return useMemo(() => {
    if (!server) return null;
    if (isOnePanelService(server.serviceType)) {
      return createOnePanelClient(server.address, server.key, server.id);
    }
    return createBtPanelClient(server.address, server.key, server.id);
  }, [server?.id, server?.address, server?.key, server?.serviceType]);
}
