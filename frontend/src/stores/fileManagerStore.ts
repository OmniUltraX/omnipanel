import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { commands } from "../ipc/bindings";
import { FILES_TRANSFER_PROGRESS } from "../ipc/events";
import { unwrapCommand } from "../ipc/result";
import { useSettingsStore } from "./settingsStore";
import {
  registerLocalBackgroundTaskCancel,
  upsertLocalBackgroundTask,
  type BackgroundTaskInfo,
  type BackgroundTaskStatus,
} from "./backgroundTaskStore";

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

/** 把 FileTransferJobView 转换为 BackgroundTaskInfo，接入后台任务系统 */
function jobToBackgroundTask(job: FileTransferJobView): BackgroundTaskInfo {
  const statusMap: Record<FileTransferJobView["state"], BackgroundTaskStatus> = {
    queued: "pending",
    probing: "pending",
    running: "running",
    done: "completed",
    error: "failed",
    cancelled: "cancelled",
  };
  const status = statusMap[job.state];
  const isTerminal = status === "completed" || status === "failed" || status === "cancelled";

  // 进度文案：百分比 + 已传/总量 + 速度
  const pct = Math.max(0, Math.min(100, Math.round(job.progress)));
  const doneStr = formatBytes(job.bytesDone);
  const totalStr = job.bytesTotal != null ? formatBytes(job.bytesTotal) : "?";
  const speedStr = job.speedBps != null && job.speedBps > 0 ? ` · ${formatSpeed(job.speedBps)}` : "";
  const progressText = job.state === "error"
    ? (job.error ?? "传输失败")
    : job.state === "cancelled"
      ? "已取消"
      : job.state === "done"
        ? `${doneStr} / ${totalStr}`
        : `${pct}% · ${doneStr} / ${totalStr}${speedStr}`;

  return {
    id: job.id,
    module: "files",
    kind: "file-transfer",
    title: `${job.source.name} → ${job.dest.name || job.dest.path}`,
    progress: progressText,
    status,
    index: 0,
    total: 0,
    startedAt: transfer_started_at_map.get(job.id) ?? Date.now(),
    finishedAt: isTerminal ? Date.now() : null,
    error: job.error,
  };
}

/** 记录每个传输任务的首次出现时间，作为 startedAt */
const transfer_started_at_map = new Map<string, number>();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

/** 同步单个 transfer 到后台任务系统（含取消句柄注册） */
function syncTransferToBackgroundTasks(job: FileTransferJobView): void {
  if (!transfer_started_at_map.has(job.id) && job.state !== "done" && job.state !== "error" && job.state !== "cancelled") {
    transfer_started_at_map.set(job.id, Date.now());
  }
  const task = jobToBackgroundTask(job);
  upsertLocalBackgroundTask(task);

  // 注册取消句柄（运行中才注册，终态后自动清理）
  if (task.status === "pending" || task.status === "running") {
    registerLocalBackgroundTaskCancel(job.id, () => {
      void useFileManagerStore.getState().cancelTransfer(job.id);
    });
  }
}

export async function ensureFileTransferListener(): Promise<void> {
  if (listening) return;
  listening = true;
  await listen(FILES_TRANSFER_PROGRESS, (event) => {
    const job = normalizeJob((event.payload ?? {}) as Record<string, unknown>);
    if (!job.id) return;
    useFileManagerStore.getState().upsertTransfer(job);
    syncTransferToBackgroundTasks(job);
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
      // 同步到后台任务系统（应用启动后恢复未完成的传输）
      for (const job of jobs) {
        syncTransferToBackgroundTasks(job);
      }
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
