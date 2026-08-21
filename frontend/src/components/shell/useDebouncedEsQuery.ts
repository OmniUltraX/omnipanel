import { useEffect, useRef, useState } from "react";
import { commands } from "../../ipc/bindings";
import { formatIpcError, ipcErrorCode, unwrapCommand } from "../../ipc/result";
import type { QuickLaunchMatchRow } from "../../lib/quickLauncherMatch";
import { PLUGIN_ID_EVERYTHING } from "../../stores/pluginRuntimeStore";
import { showToast } from "../../stores/toastStore";

const ES_DEBOUNCE_MS = 250;

/** Everything 未运行 / 非 Windows：后端归为 connection。 */
export function isEverythingUnavailableError(error: unknown): boolean {
  return ipcErrorCode(error) === "connection";
}

export function useDebouncedEsQuery(
  filter: string,
  enabled: boolean,
): QuickLaunchMatchRow[] {
  const [rows, setRows] = useState<QuickLaunchMatchRow[]>([]);
  const seqRef = useRef(0);
  const notRunningNotifiedRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setRows([]);
      return;
    }
    const handle = window.setTimeout(() => {
      const seq = ++seqRef.current;
      void unwrapCommand(
        commands.pluginInvoke(PLUGIN_ID_EVERYTHING, "search", {
          query: filter || "*",
          max_results: 12,
        }),
      )
        .then((value) => {
          if (seq !== seqRef.current) return;
          notRunningNotifiedRef.current = false;
          const hits = Array.isArray(value) ? value : [];
          setRows(
            hits.map((hit, index) => {
              const rec = hit && typeof hit === "object" ? (hit as { path?: unknown }) : {};
              const path = typeof rec.path === "string" ? rec.path : String(hit);
              return {
                type: "everything-path" as const,
                id: `es:${path}:${index}`,
                path,
                label: path.split(/[/\\]/).pop() || path,
                subtitle: path,
                score: 80,
              };
            }),
          );
        })
        .catch((err) => {
          if (seq !== seqRef.current) return;
          setRows([]);
          if (isEverythingUnavailableError(err)) {
            if (!notRunningNotifiedRef.current) {
              notRunningNotifiedRef.current = true;
              showToast(formatIpcError(err));
            }
            return;
          }
          showToast(formatIpcError(err));
        });
    }, ES_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(handle);
    };
  }, [filter, enabled]);

  return rows;
}
