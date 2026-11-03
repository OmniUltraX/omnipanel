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

/**
 * 两边都有数据且还没选过时先问。关闭对话框则这次不同步，下次再问。
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
  const choice = await askSpaceClaim();
  if (!choice) return { teamId, skip: true };
  const claimedTeam = status.teamId > 0 ? status.teamId : (teamId ?? 0);
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

export function SpaceClaimHost() {
  const open = useSyncExternalStore(subscribe, isOpen, isOpen);
  const { t } = useI18n();
  return (
    <FormDialog
      open={open}
      onClose={() => answerSpaceClaim(null)}
      title={t("app.claim.title")}
      subtitle={t("app.claim.body")}
      showCloseButton
      cancelLabel={false}
      primaryAction={{
        label: t("app.claim.merge"),
        onClick: () => answerSpaceClaim("merge"),
      }}
      actions={[
        {
          key: "local",
          label: t("app.claim.localOnly"),
          onClick: () => answerSpaceClaim("local_only"),
        },
        {
          key: "new",
          label: t("app.claim.newSpace"),
          onClick: () => answerSpaceClaim("new_space"),
        },
      ]}
    >
      {null}
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
