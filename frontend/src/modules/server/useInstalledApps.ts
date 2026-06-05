import { useCallback, useEffect, useState } from "react";
import { createBtPanelClient, BtPanelApiError } from "../../lib/btpanel";
import { createOnePanelClient, OnePanelApiError } from "../../lib/onepanel";
import type { ServerEntry } from "./CreateServerDialog";
import { mapBtInstalledApp, toServerInstalledApp, type ServerInstalledApp } from "./serverApp";

function formatError(err: unknown): string {
  if (err instanceof OnePanelApiError || err instanceof BtPanelApiError) {
    return err.body ? `${err.message}：${err.body}` : err.message;
  }
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    if (typeof record.message === "string") {
      return typeof record.cause === "string" ? `${record.message}（${record.cause}）` : record.message;
    }
  }
  return String(err);
}

interface UseInstalledAppsResult {
  apps: ServerInstalledApp[];
  total: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useInstalledApps(server: ServerEntry | null): UseInstalledAppsResult {
  const [apps, setApps] = useState<ServerInstalledApp[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!server) {
      setApps([]);
      setTotal(0);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      if (server.serviceType === "1panel") {
        const client = createOnePanelClient(server.address, server.key);
        const result = await client.searchInstalledApps({
          page: 1,
          pageSize: 200,
          all: true,
          sync: false,
        });
        setApps(result.items.map(toServerInstalledApp));
        setTotal(result.total);
        return;
      }

      if (server.serviceType === "bt") {
        const client = createBtPanelClient(server.address, server.key);
        const result = await client.getInstalledApps({
          appType: "all",
          p: 1,
          row: 200,
          query: "",
        });
        const items = result.items.map(mapBtInstalledApp);
        setApps(items);
        setTotal(result.total || items.length);
        return;
      }

      setApps([]);
      setTotal(0);
      setError(null);
    } catch (err) {
      setApps([]);
      setTotal(0);
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [server]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { apps, total, loading, error, refresh };
}
