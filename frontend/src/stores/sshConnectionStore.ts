import { useEffect } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

export type PoolStatusEvent = {
  resourceId: string;
  status: "connecting" | "connected" | "disconnected" | "error";
  error?: string;
};

type SshConnectionState = {
  statusMap: Record<string, PoolStatusEvent>;
  setStatus: (ev: PoolStatusEvent) => void;
};

export const useSshConnectionStore = create<SshConnectionState>((set, get) => ({
  statusMap: {},
  setStatus: (ev) =>
    set((state) => ({
      statusMap: { ...state.statusMap, [ev.resourceId]: ev },
    })),
}));

let listening = false;
function ensureListener() {
  if (listening) return;
  listening = true;
  listen<PoolStatusEvent>("ssh-pool-status", (ev) => {
    useSshConnectionStore.getState().setStatus(ev.payload);
  }).catch(() => {
    listening = false;
  });
}

if (typeof window !== "undefined") {
  ensureListener();
}

/** 根据 resourceId 获取主机 SSH 端口可达状态（TCP 探测，非完整登录）。
 *  返回 "online" | "connecting" | "error" | "unknown" */
export function useHostOnlineStatus(
  resourceId: string | null,
): "online" | "connecting" | "error" | "unknown" {
  const statusMap = useSshConnectionStore((s) => s.statusMap);
  useEffect(() => {
    ensureListener();
  }, []);

  if (!resourceId) return "unknown";
  const entry = statusMap[resourceId];
  if (!entry) return "unknown";
  if (entry.status === "connected") return "online";
  if (entry.status === "connecting") return "connecting";
  if (entry.status === "error" || entry.status === "disconnected") return "error";
  return "unknown";
}
