import { useCallback, useState } from "react";
import { commands, type SshExecOutput } from "../../../../ipc/bindings";
import type { WorkspaceResource } from "../../../../lib/resourceRegistry";
import { useConnectionStore } from "../../../../stores/connectionStore";
import { confirmBatchCommand } from "../utils/sshProdGuard";
import { resolveSshExecToken } from "../../../../lib/sshPresence";

export type BatchHostResult = {
  hostId: string;
  hostName: string;
  status: "pending" | "running" | "success" | "error";
  output?: SshExecOutput;
  error?: string;
  durationMs?: number;
};

export function useSshBatchCommand() {
  const connections = useConnectionStore((s) => s.connections);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<BatchHostResult[]>([]);

  const runBatch = useCallback(
    async (hosts: WorkspaceResource[], command: string) => {
      const trimmed = command.trim();
      if (!trimmed || hosts.length === 0) return;

      const ok = await confirmBatchCommand(trimmed, hosts, connections);
      if (!ok) return;
      const presenceToken = await resolveSshExecToken(hosts[0]!.id, trimmed);
      if (presenceToken === null) return;

      setRunning(true);
      const initial: BatchHostResult[] = hosts.map((h) => ({
        hostId: h.id,
        hostName: h.name,
        status: "pending",
      }));
      setResults(initial);

      await Promise.all(
        hosts.map(async (host, index) => {
          const started = Date.now();
          setResults((prev) =>
            prev.map((r, i) => (i === index ? { ...r, status: "running" } : r)),
          );
          try {
            const res = await commands.sshPoolExecCommand(
              host.id,
              trimmed,
              presenceToken ?? null,
            );
            const durationMs = Date.now() - started;
            if (res.status === "ok") {
              setResults((prev) =>
                prev.map((r, i) =>
                  i === index
                    ? { ...r, status: "success", output: res.data, durationMs }
                    : r,
                ),
              );
            } else {
              setResults((prev) =>
                prev.map((r, i) =>
                  i === index
                    ? { ...r, status: "error", error: res.error.message, durationMs }
                    : r,
                ),
              );
            }
          } catch (e) {
            setResults((prev) =>
              prev.map((r, i) =>
                i === index
                  ? {
                      ...r,
                      status: "error",
                      error: e instanceof Error ? e.message : String(e),
                      durationMs: Date.now() - started,
                    }
                  : r,
              ),
            );
          }
        }),
      );

      setRunning(false);
    },
    [connections],
  );

  const reset = useCallback(() => setResults([]), []);

  return { running, results, runBatch, reset };
}
