import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { formatTeamError, fetchTeams } from "../../lib/auth/teamApi";
import { isAuthSessionError } from "../../lib/auth/loginApi";
import {
  shareResourceKindLabelKey,
  type ResourceShareSnapshot,
  type ShareDialogPayload,
} from "../../modules/share/resourceShare";
import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";
import { useShareUiStore } from "../../stores/shareUiStore";
import { showToast } from "../../stores/toastStore";
import { WorkbenchActionButton } from "../ui/primitives/WorkbenchActionButton";
import { IconClose } from "../ui/icons/Icons";
import { Modal } from "../ui/overlay/Modal";

type ShareTeamRow = {
  id: number;
  name: string;
};

function resourceIdOf(snapshot: ResourceShareSnapshot): string {
  switch (snapshot.kind) {
    case "ssh-connection":
      return snapshot.connection.id;
    case "database-connection":
      return snapshot.connection.id;
    case "knowledge-entry":
      return snapshot.entry.id;
    case "http-request":
      return snapshot.request.id;
    case "custom-panel":
      return "";
  }
}

export interface TeamShareDialogProps {
  open: boolean;
  payload: ShareDialogPayload | null;
  onClose: () => void;
}

export function TeamShareDialog({ open, payload, onClose }: TeamShareDialogProps) {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState<ShareTeamRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [sharing, setSharing] = useState(false);

  const hasShareTarget = payload !== null;
  const resourceLabel = hasShareTarget ? t(shareResourceKindLabelKey(payload.kind)) : "";
  const resourceTitle = hasShareTarget ? payload.label : "";
  const selected = useMemo(
    () => teams.find((team) => team.id === selectedId) ?? null,
    [selectedId, teams],
  );

  const loadTeams = useCallback(async () => {
    if (!token || !open) return;
    setLoading(true);
    setError(null);
    setSelectedId(null);
    try {
      const currentId = getCurrentSyncTeamId();
      const list = await fetchTeams(token, { quiet: true });
      const rows = list
        .filter((team): team is typeof team & { id: number } => typeof team.id === "number")
        .filter((team) => team.id !== currentId)
        .map((team) => ({ id: team.id, name: team.name.trim() || String(team.id) }));
      setTeams(rows);
      setSelectedId(rows[0]?.id ?? null);
    } catch (e) {
      if (isAuthSessionError(e)) {
        setError(t("share.sessionExpired"));
      } else {
        setError(formatTeamError(e));
      }
      setTeams([]);
    } finally {
      setLoading(false);
    }
  }, [open, t, token]);

  useEffect(() => {
    if (!open) {
      setTeams([]);
      setSelectedId(null);
      setError(null);
      return;
    }
    void loadTeams();
  }, [loadTeams, open]);

  const handleShare = useCallback(async () => {
    if (!payload || !token || !selected) return;
    setSharing(true);
    try {
      await unwrapCommand(
        commands.teamCopyResourceToTeam({
          token,
          targetTeamId: selected.id,
          kind: payload.kind,
          resourceId: resourceIdOf(payload.snapshot),
          snapshotJson: payload.kind === "custom-panel" ? JSON.stringify(payload.snapshot) : null,
        }),
      );
      showToast(t("share.sentTeam", { team: selected.name }));
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : t("share.failed"));
    } finally {
      setSharing(false);
    }
  }, [onClose, payload, selected, t, token]);

  const canShare = hasShareTarget && selected !== null && !loading && !sharing;

  return (
    <Modal open={open} onClose={onClose}>
      <div
        className="team-share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-share-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="team-share-dialog__header">
          <div>
            <h3 id="team-share-dialog-title">
              {hasShareTarget
                ? t("share.titleWithPanel", { panel: resourceTitle })
                : t("share.title")}
            </h3>
            <p className="team-share-dialog__desc">
              {hasShareTarget
                ? t("share.descWithPanel", { panel: `${resourceLabel} · ${resourceTitle}` })
                : t("share.descGeneric")}
            </p>
          </div>
          <button
            type="button"
            className="team-share-dialog__close"
            onClick={onClose}
            aria-label={t("share.close")}
          >
            <IconClose size={16} />
          </button>
        </div>

        {!hasShareTarget ? (
          <p className="team-share-dialog__warn">{t("share.needPanelContext")}</p>
        ) : null}
        {error ? <p className="team-share-dialog__error">{error}</p> : null}

        <div className="team-share-dialog__list">
          {loading ? (
            <p className="team-share-dialog__empty">{t("share.loadingTeams")}</p>
          ) : teams.length === 0 ? (
            <p className="team-share-dialog__empty">{t("share.emptyTeams")}</p>
          ) : (
            <ul>
              {teams.map((team) => {
                const checked = team.id === selectedId;
                return (
                  <li key={team.id}>
                    <label className={`team-share-dialog__item${checked ? " is-selected" : ""}`}>
                      <input
                        type="radio"
                        name="share-target-team"
                        checked={checked}
                        disabled={!hasShareTarget || sharing}
                        onChange={() => setSelectedId(team.id)}
                      />
                      <span className="team-share-dialog__item-body">
                        <span className="team-share-dialog__item-name">{team.name}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="team-share-dialog__actions">
          <WorkbenchActionButton onClick={() => void loadTeams()} disabled={loading || sharing}>
            {t("share.refresh")}
          </WorkbenchActionButton>
          <WorkbenchActionButton onClick={onClose} disabled={sharing}>
            {t("share.cancel")}
          </WorkbenchActionButton>
          <WorkbenchActionButton disabled={!canShare} onClick={() => void handleShare()}>
            {sharing
              ? t("share.sending")
              : selected
                ? t("share.confirmTeam", { team: selected.name })
                : t("share.title")}
          </WorkbenchActionButton>
        </div>
      </div>
    </Modal>
  );
}

export function TeamShareDialogConnected() {
  const open = useShareUiStore((s) => s.open);
  const payload = useShareUiStore((s) => s.payload);
  const closeShareDialog = useShareUiStore((s) => s.closeShareDialog);
  return (
    <TeamShareDialog open={open} payload={payload} onClose={closeShareDialog} />
  );
}
