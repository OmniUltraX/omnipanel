import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { formatTeamError, fetchTeamMembers, fetchTeams } from "../../lib/auth/teamApi";
import { shareToTeamMembers } from "../../lib/auth/shareApi";
import { isAuthSessionError } from "../../lib/auth/loginApi";
import { buildCustomPanelShareSnapshot } from "../../modules/workspace/smallComponents/customPanelShare";
import { useAuthStore } from "../../stores/authStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import { useShareUiStore, type SharePayload } from "../../stores/shareUiStore";
import { showToast } from "../../stores/toastStore";
import { Button } from "../ui/Button";
import { IconClose } from "../ui/icons/Icons";
import { Modal } from "../ui/overlay/Modal";

type ShareMemberRow = {
  key: string;
  teamId: number;
  teamName: string;
  unionId: string;
  displayName: string;
};

function memberKey(teamId: number, email: string): string {
  return `${teamId}:${email.toLowerCase()}`;
}

export interface TeamShareDialogProps {
  open: boolean;
  payload: SharePayload;
  onClose: () => void;
}

export function TeamShareDialog({ open, payload, onClose }: TeamShareDialogProps) {
  const { t } = useI18n();
  const token = useAuthStore((s) => s.token);
  const myEmail = useUserProfileStore((s) => s.email);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<ShareMemberRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [sharing, setSharing] = useState(false);

  const sharingPanel = payload?.kind === "custom-panel";
  const panelLabel =
    sharingPanel && payload?.kind === "custom-panel" ? payload.label : "";

  const loadMembers = useCallback(async () => {
    if (!token || !open) return;
    setLoading(true);
    setError(null);
    setSelected(new Set());
    try {
      const teams = await fetchTeams(token, { quiet: true });
      const rows: ShareMemberRow[] = [];
      // 团队 id 缺失（null）时无法分享，直接跳过
      const shareable = teams.filter(
        (team): team is typeof team & { id: number } => typeof team.id === "number",
      );
      await Promise.all(
        shareable.map(async (team) => {
          const teamMembers = await fetchTeamMembers(token, team.id, { quiet: true });
          for (const member of teamMembers) {
            const email = member.email.trim();
            if (!email) continue;
            if (myEmail && email.toLowerCase() === myEmail.trim().toLowerCase()) continue;
            rows.push({
              key: memberKey(team.id, email),
              teamId: team.id,
              teamName: team.name,
              unionId: email,
              displayName:
                member.userTeamName.trim() ||
                email ||
                t("share.unnamedMember"),
            });
          }
        }),
      );
      rows.sort((a, b) => {
        const teamCmp = a.teamName.localeCompare(b.teamName, undefined, { sensitivity: "base" });
        if (teamCmp !== 0) return teamCmp;
        return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
      });
      setMembers(rows);
    } catch (e) {
      if (isAuthSessionError(e)) {
        setError(t("share.sessionExpired"));
      } else {
        setError(formatTeamError(e));
      }
      setMembers([]);
    } finally {
      setLoading(false);
    }
  }, [myEmail, open, t, token]);

  useEffect(() => {
    if (!open) {
      setMembers([]);
      setSelected(new Set());
      setError(null);
      return;
    }
    void loadMembers();
  }, [loadMembers, open]);

  const selectableKeys = useMemo(() => members.map((m) => m.key), [members]);
  const allSelected =
    selectableKeys.length > 0 && selectableKeys.every((key) => selected.has(key));
  const selectedCount = selected.size;

  const toggleMember = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(selectableKeys));
  };

  const handleShare = async () => {
    if (!sharingPanel || payload?.kind !== "custom-panel" || sharing || selectedCount === 0) {
      return;
    }
    const snapshot = buildCustomPanelShareSnapshot(payload.panelId);
    if (!snapshot) {
      showToast(t("share.panelMissing"));
      return;
    }

    const targets = members
      .filter((row) => selected.has(row.key))
      .map((row) => ({
        teamId: row.teamId,
        teamName: row.teamName,
        unionId: row.unionId,
        displayName: row.displayName,
      }));

    setSharing(true);
    try {
      if (!token) {
        showToast(t("share.sessionExpired"));
        return;
      }
      await shareToTeamMembers(token, { targets, snapshot });
      showToast(t("share.sent", { count: targets.length, panel: payload.label }));
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : t("share.failed"));
    } finally {
      setSharing(false);
    }
  };

  const canShare = sharingPanel && selectedCount > 0 && !loading && !sharing;

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
              {sharingPanel ? t("share.titleWithPanel", { panel: panelLabel }) : t("share.title")}
            </h3>
            <p className="team-share-dialog__desc">
              {sharingPanel
                ? t("share.descWithPanel", { panel: panelLabel })
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

        {!sharingPanel ? (
          <p className="team-share-dialog__warn">{t("share.needPanelContext")}</p>
        ) : null}

        {error ? <p className="team-share-dialog__error">{error}</p> : null}

        <div className="team-share-dialog__toolbar">
          <span className="team-share-dialog__count">
            {t("share.selectedCount", { count: selectedCount, total: members.length })}
          </span>
          <div className="team-share-dialog__toolbar-actions">
            <Button type="button" variant="ghost" size="sm" onClick={() => void loadMembers()} disabled={loading}>
              {t("share.refresh")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={toggleAll}
              disabled={loading || members.length === 0}
            >
              {allSelected ? t("share.deselectAll") : t("share.selectAll")}
            </Button>
          </div>
        </div>

        <div className="team-share-dialog__list">
          {loading ? (
            <p className="team-share-dialog__empty">{t("share.loading")}</p>
          ) : members.length === 0 ? (
            <p className="team-share-dialog__empty">{t("share.emptyMembers")}</p>
          ) : (
            <ul>
              {members.map((row) => {
                const checked = selected.has(row.key);
                return (
                  <li key={row.key}>
                    <label className={`team-share-dialog__item${checked ? " is-selected" : ""}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!sharingPanel || sharing}
                        onChange={() => toggleMember(row.key)}
                      />
                      <span className="team-share-dialog__item-body">
                        <span className="team-share-dialog__item-name">{row.displayName}</span>
                        <span className="team-share-dialog__item-meta">
                          {row.teamName} · {row.displayName}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="team-share-dialog__actions">
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={sharing}>
            {t("share.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!canShare}
            onClick={() => void handleShare()}
          >
            {sharing ? t("share.sending") : t("share.confirm", { count: selectedCount })}
          </Button>
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
