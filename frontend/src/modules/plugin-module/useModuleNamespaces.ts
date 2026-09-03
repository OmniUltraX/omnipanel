import { useCallback, useEffect, useState } from "react";
import type { Connection } from "../../ipc/bindings";
import { invokeModuleMethod } from "./moduleInvoke";
import type { ModuleNamespaceRow } from "./moduleNamespaces";

export type { ModuleNamespaceRow } from "./moduleNamespaces";
export {
  PUBLIC_NAMESPACE_SELECT,
  isPublicNamespace,
  namespaceIdFromSelect,
  namespaceSelectValue,
} from "./moduleNamespaces";

export function useModuleNamespaces(pluginId: string, connection: Connection | null) {
  const [items, setItems] = useState<ModuleNamespaceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!pluginId || !connection) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const row = await invokeModuleMethod<{ items?: ModuleNamespaceRow[] }>(
        pluginId,
        "listNamespaces",
        {},
        { connection },
      );
      setItems(row.items ?? []);
      setError(null);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [pluginId, connection]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { items, error, loading, reload };
}
