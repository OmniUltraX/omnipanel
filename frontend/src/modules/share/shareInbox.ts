import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";
import { t } from "../../i18n";
import { fetchTeams } from "../../lib/auth/teamApi";
import { fetchTeamShare, listTeamShares } from "../../lib/auth/teamSyncApi";
import { appConfirm } from "../../lib/appConfirm";
import { DASHBOARD_PATH, MODULE_PATHS } from "../../lib/paths";
import { isTauriRuntime } from "../../lib/isTauriRuntime";
import { safeTauriUnlisten } from "../../lib/safeTauriUnlisten";
import { commands, type TeamShareSummary } from "../../ipc/bindings";
import { TEAM_SHARE_INBOUND } from "../../ipc/events";
import { unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import { showToast } from "../../stores/toastStore";
import {
  importResourceShareSnapshot,
  shareResourceKindLabelKey,
  type ResourceShareSnapshot,
} from "./resourceShare";

const SEEN_KEY_PREFIX = "omnipanel-share-inbox-seen.v1";
const SEEN_MAX = 200;
/** SSE 断线期间的兜底轮询间隔。 */
const FALLBACK_POLL_MS = 5 * 60_000;
/** 冷启动延迟：等待用户资料（email）与云端索引就绪。 */
const COLD_START_DELAY_MS = 3_000;

type PendingShare = {
  teamId: number;
  share: TeamShareSummary;
};

let unlistenInbound: UnlistenFn | null = null;
let startedToken: string | null = null;
let startPromise: Promise<void> | null = null;
let pollTimer: number | null = null;
let checkInFlight = false;

function seenKey(openid: string): string {
  return `${SEEN_KEY_PREFIX}:${openid}`;
}

function loadSeenShareIds(openid: string): Set<string> {
  try {
    const raw = localStorage.getItem(seenKey(openid));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((x): x is string => typeof x === "string" && x.length > 0),
    );
  } catch {
    return new Set();
  }
}

function persistSeenShareIds(openid: string, ids: Set<string>): void {
  const list = Array.from(ids);
  const trimmed = list.length > SEEN_MAX ? list.slice(list.length - SEEN_MAX) : list;
  try {
    localStorage.setItem(seenKey(openid), JSON.stringify(trimmed));
  } catch {
    // ignore quota
  }
}

function markSeen(openid: string, shareId: string): void {
  if (!shareId) return;
  const seen = loadSeenShareIds(openid);
  if (seen.has(shareId)) return;
  seen.add(shareId);
  persistSeenShareIds(openid, seen);
}

/** 分享资源类型 → 接收后要打开的模块路径。 */
export function modulePathForShareKind(kind: string): string {
  switch (kind) {
    case "knowledge-entry":
      return MODULE_PATHS.knowledge;
    case "http-request":
      return MODULE_PATHS.protocol;
    case "ssh-connection":
      return MODULE_PATHS.ssh;
    case "database-connection":
      return MODULE_PATHS.database;
    default:
      return DASHBOARD_PATH;
  }
}

function navigateToModule(path: string): void {
  window.dispatchEvent(
    new CustomEvent("omnipanel-navigate", { detail: { path } }),
  );
}

/** 系统通知（tauri-plugin-notification）；失败不影响应用内确认流程。 */
async function sendSystemNotification(title: string, body: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const notification = await import("@tauri-apps/plugin-notification");
    let granted = await notification.isPermissionGranted();
    if (!granted) {
      granted = (await notification.requestPermission()) === "granted";
    }
    if (!granted) return;
    notification.sendNotification({ title, body });
  } catch {
    // ignore
  }
}

/** 分享是否发给我：非本人发出，且接收人列表为空（群发）或包含我的邮箱。 */
function isShareForMe(share: TeamShareSummary, openid: string): boolean {
  if (share.fromUnionId.trim() === openid) return false;
  const recipients = share.recipientUnionIds
    .map((r) => r.trim().toLowerCase())
    .filter((r) => r.length > 0);
  if (recipients.length === 0) return true;
  const myEmail = useUserProfileStore.getState().email?.trim().toLowerCase();
  if (!myEmail) return true;
  return recipients.includes(myEmail);
}

async function handleNewShare(token: string, openid: string, pending: PendingShare): Promise<void> {
  const { share } = pending;
  const kindLabel = t(shareResourceKindLabelKey(share.resourceKind));
  const fromName = share.fromDisplayName.trim() || share.fromUnionId;
  const label = share.panelLabel;

  await sendSystemNotification(
    t("share.notifyTitle"),
    t("share.notifyBody", { name: fromName, kind: kindLabel, label }),
  );

  const accept = await appConfirm(
    t("share.receiveConfirmMessage", { name: fromName, kind: kindLabel, label }),
    t("share.receiveConfirmTitle"),
    {
      confirmLabel: t("share.receiveAccept"),
      cancelLabel: t("share.receiveDecline"),
    },
  );
  // 接收与否都标记已处理，避免重复打扰；拒绝后仍可在用户中心手动导入
  markSeen(openid, share.shareId);
  if (!accept) return;

  try {
    const fetched = await fetchTeamShare(token, pending.teamId, share.shareId);
    const envelope = JSON.parse(fetched.bodyJson) as { snapshot?: ResourceShareSnapshot };
    if (!envelope.snapshot) {
      showToast(t("share.receiveInvalid"));
      return;
    }
    const imported = await importResourceShareSnapshot(envelope.snapshot);
    if (!imported) {
      showToast(t("share.receiveInvalid"));
      return;
    }
    showToast(t("share.receiveSuccess", { name: imported.name }));
    if (imported.panelId) {
      const { useDashboardStore } = await import("../workspace/useDashboardStore");
      useDashboardStore.getState().openHomeTab(imported.panelId);
    }
    navigateToModule(modulePathForShareKind(share.resourceKind));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    showToast(t("share.receiveFailed", { error: message }));
  }
}

/** 遍历所有团队分享索引，对「新的、发给我的」逐个弹通知与接收确认。 */
export async function checkNewShares(): Promise<void> {
  if (checkInFlight) return;
  const token = useAuthStore.getState().token?.trim();
  const openid = useAuthStore.getState().openid?.trim();
  if (!token || !openid) return;

  checkInFlight = true;
  try {
    const teams = await fetchTeams(token, { quiet: true });
    const shareable = teams.filter((team): team is typeof team & { id: number } =>
      typeof team.id === "number",
    );
    const seen = loadSeenShareIds(openid);
    const pendingList: PendingShare[] = [];
    for (const team of shareable) {
      try {
        const shares = await listTeamShares(token, team.id);
        for (const share of shares) {
          if (seen.has(share.shareId)) continue;
          if (!isShareForMe(share, openid)) continue;
          pendingList.push({ teamId: team.id, share });
        }
      } catch {
        // 单个团队拉取失败不阻断其他团队
      }
    }
    for (const pending of pendingList) {
      await handleNewShare(token, openid, pending);
    }
  } finally {
    checkInFlight = false;
  }
}

/**
 * 启动团队分享收件箱：SSE 事件驱动 + 冷启动检查 + 低频兜底轮询。
 * 登录 / token 变化后由 AuthProfileSync 调用。
 */
export async function startShareInbox(): Promise<void> {
  const token = useAuthStore.getState().token?.trim() ?? "";
  if (!token) return;

  if (startedToken === token && unlistenInbound) return;

  if (startPromise) {
    await startPromise;
    if (startedToken === token && unlistenInbound) return;
  }

  startPromise = (async () => {
    await stopShareInbox();

    unlistenInbound = await listen<{ teamId: number; shareId: string }>(
      TEAM_SHARE_INBOUND,
      () => {
        void checkNewShares();
      },
    );

    try {
      await unwrapCommand(commands.teamShareInboxStart(token), { quiet: true });
      startedToken = token;
    } catch (err) {
      safeTauriUnlisten(unlistenInbound);
      unlistenInbound = null;
      startedToken = null;
      console.warn("[share-inbox] start failed", err);
      return;
    }

    window.setTimeout(() => {
      void checkNewShares();
    }, COLD_START_DELAY_MS);

    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
    }
    pollTimer = window.setInterval(() => {
      void checkNewShares();
    }, FALLBACK_POLL_MS);
  })();

  try {
    await startPromise;
  } finally {
    startPromise = null;
  }
}

/** 登出 / token 清空时停止收件箱。 */
export async function stopShareInbox(): Promise<void> {
  startedToken = null;
  safeTauriUnlisten(unlistenInbound);
  unlistenInbound = null;
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!isTauriRuntime()) return;
  try {
    await unwrapCommand(commands.teamShareInboxStop(), { quiet: true });
  } catch {
    // ignore
  }
}
