import { useSyncExternalStore } from "react";
import { FormDialog } from "../../components/ui/FormDialog";
import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { t, useI18n } from "../../i18n";
import { showToast } from "../../stores/toastStore";

const EXPORT_KEY = "omnipanel.spaceKeyExport";

export function markSpaceKeyExport(teamId: number) {
  if (teamId > 0) sessionStorage.setItem(EXPORT_KEY, String(teamId));
}

export type SpaceClaimAnswer = "merge" | "local_only" | "new_space";

let pending: ((choice: SpaceClaimAnswer | null) => void) | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function isOpen() {
  return pending != null;
}

export function askSpaceClaim(): Promise<SpaceClaimAnswer | null> {
  return new Promise((resolve) => {
    pending = resolve;
    emit();
  });
}

function answerSpaceClaim(choice: SpaceClaimAnswer | null) {
  const resolve = pending;
  pending = null;
  emit();
  resolve?.(choice);
}

/** 本机设备是否早已挂在账号上（退出再登 / 老设备），而不是刚绑定的新电脑。 */
async function isReturningAccountDevice(token: string): Promise<boolean> {
  try {
    const { fetchDeviceIdentity, fetchDevices } = await import("../../lib/auth/loginApi");
    const [identity, devices] = await Promise.all([
      fetchDeviceIdentity(),
      fetchDevices(token, { quiet: true }),
    ]);
    const mine = devices.find((d) => d.deviceId === identity.deviceId);
    if (!mine) return false;
    if (mine.syncTrusted) return true;
    if (String(mine.lastLogoutAt || "").trim()) return true;
    const created = Date.parse(String(mine.createdAt || ""));
    // 设备记录已存在超过几分钟：同机重登，不是首次装机扫码。
    if (Number.isFinite(created) && Date.now() - created > 3 * 60 * 1000) return true;
    return false;
  } catch {
    return false;
  }
}

async function applyClaimChoice(
  token: string,
  teamId: number | null,
  claimedTeam: number,
  choice: SpaceClaimAnswer,
): Promise<{ teamId: number | null; skip: boolean }> {
  if (choice === "new_space") {
    const { createTeam } = await import("../../lib/auth/teamApi");
    const created = await createTeam(token, "这台电脑");
    const publish = created.id;
    if (publish == null) return { teamId, skip: true };
    await unwrapCommand(
      commands.localSpaceClaimChoose({
        teamId: claimedTeam,
        decision: "new_space",
        publishTeamId: publish,
      }),
    );
    const { applyLocalTeamScope } = await import("../../lib/applyLocalTeamScope");
    const { useCurrentSyncTeamStore } = await import("../../stores/currentSyncTeamStore");
    useCurrentSyncTeamStore.getState().setTeamId(publish);
    await applyLocalTeamScope(String(publish));
    markSpaceKeyExport(publish);
    return { teamId: publish, skip: false };
  }
  if (choice === "merge") markSpaceKeyExport(claimedTeam);
  await unwrapCommand(
    commands.localSpaceClaimChoose({
      teamId: claimedTeam,
      decision: choice,
      publishTeamId: null,
    }),
  );
  return { teamId, skip: false };
}

/**
 * 两边都有数据且还没选过时：同设备重登直接并进空间；
 * 新设备才弹窗。关闭对话框则这次不同步，下次再问。
 * 另建空间会复制当前目录再切过去，返回要同步的团队 id。
 */
export async function resolveSpaceClaim(
  token: string,
  teamId: number | null,
): Promise<{ teamId: number | null; skip: boolean }> {
  const status = await unwrapCommand(commands.localSpaceClaimStatus(token, teamId), {
    quiet: true,
  });
  if (!(status.localCount > 0 && status.remoteHasRepo) || status.decision) {
    return { teamId, skip: false };
  }
  const claimedTeam = status.teamId > 0 ? status.teamId : (teamId ?? 0);
  if (await isReturningAccountDevice(token)) {
    // 同机重登：直接记 merge，不再弹认领窗，也不反复催导出密钥。
    await unwrapCommand(
      commands.localSpaceClaimChoose({
        teamId: claimedTeam,
        decision: "merge",
        publishTeamId: null,
      }),
    );
    return { teamId, skip: false };
  }
  const choice = await askSpaceClaim();
  if (!choice) return { teamId, skip: true };
  return applyClaimChoice(token, teamId, claimedTeam, choice);
}

export function SpaceClaimHost() {
  const open = useSyncExternalStore(subscribe, isOpen, isOpen);
  const { t } = useI18n();
  const choices: Array<{
    key: SpaceClaimAnswer;
    title: string;
    hint: string;
    recommended?: boolean;
  }> = [
    {
      key: "merge",
      title: t("app.claim.merge"),
      hint: t("app.claim.mergeHint"),
      recommended: true,
    },
    {
      key: "local_only",
      title: t("app.claim.localOnly"),
      hint: t("app.claim.localOnlyHint"),
    },
    {
      key: "new_space",
      title: t("app.claim.newSpace"),
      hint: t("app.claim.newSpaceHint"),
    },
  ];
  return (
    <FormDialog
      open={open}
      onClose={() => answerSpaceClaim(null)}
      title={t("app.claim.title")}
      size="sm"
      showCloseButton
      cancelLabel={false}
      className="space-claim-dialog"
      bodyClassName="space-claim-dialog__body"
      footer={null}
    >
      <p className="space-claim-dialog__lead">{t("app.claim.body")}</p>
      <div className="space-claim-choices" role="list">
        {choices.map((choice) => (
          <button
            key={choice.key}
            type="button"
            role="listitem"
            className={[
              "space-claim-choice",
              choice.recommended ? "space-claim-choice--recommended" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => answerSpaceClaim(choice.key)}
          >
            <span className="space-claim-choice__title-row">
              <span className="space-claim-choice__title">{choice.title}</span>
              {choice.recommended ? (
                <span className="space-claim-choice__badge">{t("app.claim.recommended")}</span>
              ) : null}
            </span>
            <span className="space-claim-choice__hint">{choice.hint}</span>
          </button>
        ))}
      </div>
    </FormDialog>
  );
}

let exportWait: ((save: boolean) => void) | null = null;
const exportListeners = new Set<() => void>();

function emitExport() {
  exportListeners.forEach((listener) => listener());
}

export async function noticeSpaceSync(report: {
  skipped?: boolean;
  fileCount?: number;
  conflicts?: number;
}): Promise<void> {
  if (report.skipped) return;
  const raw = sessionStorage.getItem(EXPORT_KEY);
  if (!raw) return;
  sessionStorage.removeItem(EXPORT_KEY);
  const count = report.fileCount ?? 0;
  const conflicts = report.conflicts ?? 0;
  if (count > 0) {
    showToast(
      conflicts > 0
        ? t("app.claim.mergedConflicts", { count, conflicts })
        : t("app.claim.merged", { count }),
    );
  }
  const save = await new Promise<boolean>((resolve) => {
    exportWait = resolve;
    emitExport();
  });
  if (!save) return;
  const { save: saveFileDialog } = await import("@tauri-apps/plugin-dialog");
  const path = await saveFileDialog({
    defaultPath: "omnipanel-space.key",
    filters: [{ name: "key", extensions: ["key"] }],
  });
  if (typeof path !== "string" || !path.trim()) return;
  await unwrapCommand(commands.syncTeamKeyExportFile(Number(raw), path, null));
}

export function SpaceKeyExportHost() {
  const open = useSyncExternalStore(
    (listener) => {
      exportListeners.add(listener);
      return () => exportListeners.delete(listener);
    },
    () => exportWait != null,
    () => false,
  );
  const { t: label } = useI18n();
  return (
    <FormDialog
      open={open}
      onClose={() => {
        const resolve = exportWait;
        exportWait = null;
        emitExport();
        resolve?.(false);
      }}
      title={label("app.claim.exportTitle")}
      subtitle={label("app.claim.exportBody")}
      cancelLabel={label("app.claim.exportLater")}
      primaryAction={{
        label: label("app.claim.exportSave"),
        onClick: () => {
          const resolve = exportWait;
          exportWait = null;
          emitExport();
          resolve?.(true);
        },
      }}
    >
      {null}
    </FormDialog>
  );
}
