import { useCallback, useEffect, useState } from "react";
import { createOnePanelClient, OnePanelApiError } from "../../lib/onepanel";
import type { ServerEntry } from "./CreateServerDialog";
import { getAppComposePath } from "./appCompose";
import type { ServerInstalledApp } from "./serverApp";

function formatError(err: unknown): string {
  if (err instanceof OnePanelApiError) {
    return err.body ? `${err.message}：${err.body}` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function useAppComposeLogs(
  server: ServerEntry,
  app: ServerInstalledApp | null,
  enabled: boolean,
) {
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!app || !enabled) return;

    const composePath = getAppComposePath(app);
    if (!composePath) {
      setLogs("");
      setError("缺少应用安装路径，无法加载日志");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const client = createOnePanelClient(server.address, server.key);
      const text = await client.downloadComposeLogs(composePath);
      setLogs(text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ""));
    } catch (err) {
      setLogs("");
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [app, enabled, server.address, server.key]);

  useEffect(() => {
    if (enabled && app) {
      void refresh();
    } else {
      setLogs("");
      setError(null);
      setLoading(false);
    }
  }, [enabled, app, refresh]);

  const clear = useCallback(() => {
    setLogs("");
    setError(null);
  }, []);

  return { logs, loading, error, refresh, clear };
}
