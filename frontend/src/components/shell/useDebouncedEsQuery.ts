import { useEffect, useRef, useState } from "react";
import { formatIpcError, ipcErrorCode } from "../../ipc/result";
import { searchEverything } from "../../lib/everythingSearch";
import type { QuickLaunchMatchRow } from "../../lib/quickLauncherMatch";
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
      void searchEverything(filter || "*", 12)
        .then((hits) => {
          if (seq !== seqRef.current) return;
          notRunningNotifiedRef.current = false;
          setRows(
            hits.map((hit, index) => ({
              type: "everything-path" as const,
              id: `es:${hit.path}:${index}`,
              path: hit.path,
              isFolder: hit.isFolder,
              label: hit.path.split(/[/\\]/).pop() || hit.path,
              subtitle: hit.path,
              score: 80,
            })),
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
