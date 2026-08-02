import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { commands } from "../ipc/bindings";
import { FILES_TRANSFER_PROGRESS } from "../ipc/events";
import { unwrapCommand } from "../ipc/result";
import { useSettingsStore } from "./settingsStore";

export type FileTransferJobView = {
  id: string;
  batchId: string;
  op: "copy" | "move";
  source: { connectionId: string; path: string; kind: string; name: string };
  dest: { connectionId: string; path: string; kind: string; name: string };
  route: "fastpath" | "remoteDirect" | "relay";
  routeReason: string;
  state: "queued" | "probing" | "running" | "done" | "error" | "cancelled";
  bytesDone: number;
  bytesTotal: number | null;
  speedBps: number | null;
  error: string | null;
  progress: number;
};

type FileManagerState = {
  transfers: FileTransferJobView[];
  hydrated: boolean;
  upsertTransfer: (job: FileTransferJobView) => void;
  hydrateTransfers: () => Promise<void>;
  clearDoneTransfers: () => Promise<void>;
  cancelTransfer: (jobId: string) => Promise<void>;
  retryTransfer: (jobId: string) => Promise<void>;
};

function normalizeJob(raw: Record<string, unknown>): FileTransferJobView {
  const source = (raw.source ?? {}) as Record<string, unknown>;
  const dest = (raw.dest ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.id ?? ""),
    batchId: String(raw.batchId ?? raw.batch_id ?? ""),
    op: (raw.op as FileTransferJobView["op"]) ?? "copy",
    source: {
      connectionId: String(source.connectionId ?? source.connection_id ?? ""),
      path: String(source.path ?? ""),
      kind: String(source.kind ?? "file"),
      name: String(source.name ?? ""),
    },
    dest: {
      connectionId: String(dest.connectionId ?? dest.connection_id ?? ""),
      path: String(dest.path ?? ""),
      kind: String(dest.kind ?? "file"),
      name: String(dest.name ?? ""),
    },
    route: (raw.route as FileTransferJobView["route"]) ?? "relay",
    routeReason: String(raw.routeReason ?? raw.route_reason ?? ""),
    state: (raw.state as FileTransferJobView["state"]) ?? "queued",
    bytesDone: Number(raw.bytesDone ?? raw.bytes_done ?? 0),
    bytesTotal:
      raw.bytesTotal == null && raw.bytes_total == null
        ? null
        : Number(raw.bytesTotal ?? raw.bytes_total),
    speedBps:
      raw.speedBps == null && raw.speed_bps == null
        ? null
        : Number(raw.speedBps ?? raw.speed_bps),
    error: (raw.error as string | null) ?? null,
    progress: Number(raw.progress ?? 0),
  };
}

let listening = false;

export async function ensureFileTransferListener(): Promise<void> {
  if (listening) return;
  listening = true;
  await listen(FILES_TRANSFER_PROGRESS, (event) => {
    const job = normalizeJob((event.payload ?? {}) as Record<string, unknown>);
    if (!job.id) return;
    useFileManagerStore.getState().upsertTransfer(job);
  });
  try {
    const { fileTransferConcurrency, fileTransferRateLimitBps } = useSettingsStore.getState();
    await unwrapCommand(commands.fileTransferSetConcurrency(fileTransferConcurrency));
    await unwrapCommand(commands.fileTransferSetRateLimit(fileTransferRateLimitBps));
  } catch {
    /* ignore */
  }
}

export const useFileManagerStore = create<FileManagerState>((set) => ({
  transfers: [],
  hydrated: false,
  upsertTransfer: (job) => {
    set((s) => {
      const idx = s.transfers.findIndex((t) => t.id === job.id);
      if (idx >= 0) {
        const next = [...s.transfers];
        next[idx] = job;
        return { transfers: next };
      }
      return { transfers: [job, ...s.transfers].slice(0, 40) };
    });
  },
  hydrateTransfers: async () => {
    await ensureFileTransferListener();
    try {
      const res = await unwrapCommand(commands.fileTransferList());
      const jobs = (res.jobs ?? []).map((j) =>
        normalizeJob(j as unknown as Record<string, unknown>),
      );
      set({ transfers: jobs, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },
  clearDoneTransfers: async () => {
    try {
      await unwrapCommand(commands.fileTransferClearFinished());
    } catch {
      /* ignore */
    }
    set((s) => ({
      transfers: s.transfers.filter((t) =>
        t.state === "queued" || t.state === "probing" || t.state === "running",
      ),
    }));
  },
  cancelTransfer: async (jobId) => {
    await unwrapCommand(commands.fileTransferCancel(jobId));
  },
  retryTransfer: async (jobId) => {
    await unwrapCommand(commands.fileTransferRetry(jobId));
  },
}));

export type EnqueueTransferInput = {
  items: {
    connectionId: string;
    path: string;
    kind: string;
    name: string;
    size?: number | null;
  }[];
  destConnectionId: string;
  destDir: string;
  op: "copy" | "move";
  conflictPolicy: "skip" | "overwrite" | "rename";
  forceRoute?: "fastpath" | "remoteDirect" | "relay" | null;
  remoteDirectPolicy?: "ask" | "always" | "never";
};

export async function planFileTransfer(input: {
  sourceConnectionId: string;
  destConnectionId: string;
  forceRoute?: "fastpath" | "remoteDirect" | "relay" | null;
  remoteDirectPolicy?: "ask" | "always" | "never";
}) {
  await ensureFileTransferListener();
  return unwrapCommand(
    commands.fileTransferPlan({
      sourceConnectionId: input.sourceConnectionId,
      destConnectionId: input.destConnectionId,
      forceRoute: input.forceRoute ?? null,
      remoteDirectPolicy: input.remoteDirectPolicy ?? "ask",
    }),
  );
}

export async function enqueueFileTransfer(input: EnqueueTransferInput): Promise<string> {
  await ensureFileTransferListener();
  return unwrapCommand(
    commands.fileTransferEnqueue({
      items: input.items.map((it) => ({
        connectionId: it.connectionId,
        path: it.path,
        kind: it.kind,
        name: it.name,
        size: it.size ?? null,
      })),
      destConnectionId: input.destConnectionId,
      destDir: input.destDir,
      op: input.op,
      conflictPolicy: input.conflictPolicy,
      forceRoute: input.forceRoute ?? null,
      remoteDirectPolicy: input.remoteDirectPolicy ?? "ask",
    }),
  );
}

/** @deprecated 旧假进度 API，保留空实现避免瞬时破坏调用方；请改用 enqueueFileTransfer */
export function addTransfer(name: string): string {
  const id = `legacy-${Date.now()}`;
  useFileManagerStore.getState().upsertTransfer({
    id,
    batchId: id,
    op: "copy",
    source: { connectionId: "", path: "", kind: "file", name },
    dest: { connectionId: "", path: "", kind: "file", name },
    route: "relay",
    routeReason: "",
    state: "running",
    bytesDone: 0,
    bytesTotal: null,
    speedBps: null,
    error: null,
    progress: 0,
  });
  return id;
}

export function updateTransfer(
  id: string,
  patch: Partial<{ progress: number; status: string; error?: string }>,
): void {
  const cur = useFileManagerStore.getState().transfers.find((t) => t.id === id);
  if (!cur) return;
  const state =
    patch.status === "done"
      ? "done"
      : patch.status === "error"
        ? "error"
        : cur.state;
  useFileManagerStore.getState().upsertTransfer({
    ...cur,
    progress: patch.progress ?? cur.progress,
    state,
    error: patch.error ?? cur.error,
  });
}
