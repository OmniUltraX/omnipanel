import { syncAuthProfile } from "./syncAuthProfile";
import { useAuthStore } from "../../stores/authStore";
import type { PullCloudSnapshotResult } from "../../modules/clientSync/pullCloudSnapshot";

/** 合并 Bootstrap + AuthProfileSync 并发，避免登录瞬间连拉两次。 */
let inflight: Promise<PullCloudSnapshotResult | null> | null = null;

/**
 * 登录后 / 冷启动已登录：同步资料 → 对齐本机团队存储目录 → 拉取云端快照。
 *
 * Bootstrap（LoginPage → splash）与 AuthProfileSync（App 内重新登录）必须走同一套顺序：
 * 缺 `alignLocalStorageTeam` 时会把快照写进登出后的 `local` 桶，表现为「登录了但没数据」。
 */
export async function hydrateCloudAfterLogin(): Promise<PullCloudSnapshotResult | null> {
  const token = useAuthStore.getState().token?.trim();
  if (!token) return null;

  if (inflight) return inflight;

  inflight = (async () => {
    try {
      // teams / ossPath 就绪后再拉；密文库依赖 ossPath
      await syncAuthProfile();
      try {
        const { alignLocalStorageTeam } = await import("../applyLocalTeamScope");
        await alignLocalStorageTeam();
      } catch (err) {
        console.warn("[auth] alignLocalStorageTeam failed:", err);
      }
      const { pullCloudSnapshot } = await import("../../modules/clientSync");
      return await pullCloudSnapshot();
    } catch (err) {
      console.warn("[auth] hydrateCloudAfterLogin failed:", err);
      return null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
