import { useCallback, useEffect, useState } from "react";
import { createBtPanelClient } from "../../../lib/btpanel";
import { createOnePanelClient } from "../../../lib/onepanel";
import type { ServerEntry } from "./serverConnection";

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

interface UseServerCertificatesResult {
  items: Record<string, unknown>[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useServerCertificates(server: ServerEntry | null): UseServerCertificatesResult {
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!server) {
      setItems([]);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      if (server.serviceType === "1panel") {
        const client = createOnePanelClient(server.address, server.key);
        const rows = await client.searchCertificates();
        setItems(rows as Record<string, unknown>[]);
        return;
      }
      if (server.serviceType === "bt") {
        const client = createBtPanelClient(server.address, server.key);
        const rows = await client.getSslList();
        setItems(rows);
        return;
      }
      setItems([]);
    } catch (err) {
      setError(formatError(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [server]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { items, loading, error, refresh };
}
