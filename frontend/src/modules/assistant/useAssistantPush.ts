import { useCallback, useState } from "react";
import { formatIpcError } from "../../ipc/result";
import { pushAssistantSnapshot, type PushSnapshotResult } from "./api";

export type AssistantPushPhase = "idle" | "pushing" | "success" | "error";

export function useAssistantPush() {
  const [phase, setPhase] = useState<AssistantPushPhase>("idle");
  const [result, setResult] = useState<PushSnapshotResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const push = useCallback(async (opts?: { dryRun?: boolean; bindId?: string | null }) => {
    setPhase("pushing");
    setError(null);
    setResult(null);
    try {
      const next = await pushAssistantSnapshot(opts);
      setResult(next);
      setPhase("success");
      return next;
    } catch (err) {
      const message = formatIpcError(err);
      setError(message);
      setPhase("error");
      throw err;
    }
  }, []);

  const reset = useCallback(() => {
    setPhase("idle");
    setResult(null);
    setError(null);
  }, []);

  return { phase, result, error, push, reset };
}
