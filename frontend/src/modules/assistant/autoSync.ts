import { commands } from "../../ipc/bindings";
import { unwrapCommand, formatIpcError } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";

const DEBOUNCE_MS = 5000;

let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let pendingAfterFlight = false;
let lastBindId: string | null = null;

/** 取消尚未发出的自动同步（登出时调用）。 */
export function cancelAssistantSnapshotSync(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pendingAfterFlight = false;
}

/**
 * 模块元数据变更后调度自动上传（debounce）。
 * 未登录时静默跳过；进行中再变更会排队一次。
 */
export function scheduleAssistantSnapshotSync(options?: {
  bindId?: string | null;
  /** 跳过 debounce，尽快推一次（绑定成功等） */
  immediate?: boolean;
}): void {
  if (options?.bindId !== undefined) {
    lastBindId = options.bindId;
  }

  const token = useAuthStore.getState().token;
  if (!token?.trim()) {
    return;
  }

  if (options?.immediate) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    void runPush();
    return;
  }

  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runPush();
  }, DEBOUNCE_MS);
}

async function runPush(): Promise<void> {
  const token = useAuthStore.getState().token;
  if (!token?.trim()) {
    return;
  }

  if (inFlight) {
    pendingAfterFlight = true;
    return;
  }

  inFlight = (async () => {
    try {
      await unwrapCommand(
        commands.assistantPushSnapshot({
          token,
          dryRun: false,
          bindId: lastBindId,
        }),
        { quiet: true },
      );
    } catch (err) {
      // 自动同步失败不打断主流程；控制台留痕便于联调
      console.warn("[assistant-auto-sync]", formatIpcError(err));
    } finally {
      inFlight = null;
      if (pendingAfterFlight) {
        pendingAfterFlight = false;
        scheduleAssistantSnapshotSync();
      }
    }
  })();

  await inFlight;
}
