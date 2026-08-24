import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import {
  addTeamMember,
  createTeam,
  dissolveTeam,
  fetchTeamMembers,
  fetchTeams,
  formatTeamError,
  removeTeamMember,
  updateTeamMember,
  isPersonalTeam,
  type TeamMember,
  type TeamSummary,
} from "../../lib/auth/teamApi";
import {
  fetchTeamShare,
  formatTeamSyncError,
  listTeamShares,
  peekTeamModules,
  pullTeamModules,
  pushTeamModules,
  type TeamShareSummary,
  type TeamSyncPeekResult,
} from "../../lib/auth/teamSyncApi";
import {
  importCustomPanelShareSnapshot,
  type CustomPanelShareSnapshot,
} from "../../modules/workspace/smallComponents/customPanelShare";
import { isAuthSessionError } from "../../lib/auth/loginApi";
import { quickInput } from "../../lib/quickInput";
import { useAuthStore } from "../../stores/authStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import { showToast } from "../../stores/toastStore";
import { Button } from "../ui/Button";
import { FormDialog, FormField } from "../ui/form/FormDialog";
import { TextInput } from "../ui/form/TextInput";
import { Select } from "../ui/form/Select";
import { IconChevronRight, IconPlus, IconTrash, IconUsers } from "../ui/icons/Icons";
import { TeamDataTree } from "./TeamDataTree";

type TeamRoleCode = "creator" | "manager" | "user";
type TeamDetailTab = "members" | "data";

/** 团队 id 缺失（null）时无法执行任何团队操作。 */
function numericTeamId(team: TeamSummary | null | undefined): number | null {
  return team && typeof team.id === "number" ? team.id : null;
}

function normalizeRole(role: string | undefined): TeamRoleCode {
  const key = role?.trim().toLowerCase();
  if (key === "creator" || key === "manager") return key;
  return "user";
}

function canManageMembers(role: TeamRoleCode): boolean {
  return role === "creator" || role === "manager";
}

function formatTime(value: string, locale: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "—";
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return trimmed;
  return date.toLocaleString(locale);
}

function emailsEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function maskUnionId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return trimmed;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export function UserCenterTeams({
  initialTeamId = null,
}: {
  /** 打开弹窗时自动进入该团队详情 */
  initialTeamId?: number | null;
} = {}) {
  const { t, locale } = useI18n();
  const token = useAuthStore((s) => s.token);
  const logout = useAuthStore((s) => s.logout);
  const clearProfile = useUserProfileStore((s) => s.clearProfile);
  const myUnionId = useUserProfileStore((s) => s.openid);
  const myEmail = useUserProfileStore((s) => s.email);

  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<TeamSummary | null>(null);

  const [members, setMembers] = useState<TeamMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);

  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [addMemberEmail, setAddMemberEmail] = useState("");
  const [memberSearchResults, setMemberSearchResults] = useState<string[]>([]);
  const [memberSearchLoading, setMemberSearchLoading] = useState(false);
  const [memberSearchError, setMemberSearchError] = useState<string | null>(null);
  const [memberSearchDone, setMemberSearchDone] = useState(false);
  const [addingMember, setAddingMember] = useState(false);

  const [editMember, setEditMember] = useState<TeamMember | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editRole, setEditRole] = useState<"manager" | "user">("user");
  const [savingMember, setSavingMember] = useState(false);

  const [busyMemberEmail, setBusyMemberEmail] = useState<string | null>(null);
  const [dissolving, setDissolving] = useState(false);

  const [teamShares, setTeamShares] = useState<TeamShareSummary[]>([]);
  const [sharesLoading, setSharesLoading] = useState(false);
  const [sharesError, setSharesError] = useState<string | null>(null);
  const [syncModulesPushing, setSyncModulesPushing] = useState(false);
  const [syncModulesPulling, setSyncModulesPulling] = useState(false);
  const [importingShareId, setImportingShareId] = useState<string | null>(null);

  const [detailTab, setDetailTab] = useState<TeamDetailTab>("members");
  const [dataPeek, setDataPeek] = useState<TeamSyncPeekResult | null>(null);
  const [dataPeekLoading, setDataPeekLoading] = useState(false);
  const [dataPeekError, setDataPeekError] = useState<string | null>(null);

  const roleLabel = useCallback(
    (role: string) => {
      const normalized = normalizeRole(role);
      return t(`userCenter.teams.roles.${normalized}`);
    },
    [t],
  );

  const handleSessionExpired = useCallback(() => {
    clearProfile();
    logout();
    showToast(t("userCenter.profile.sessionExpired"));
  }, [clearProfile, logout, t]);

  const loadTeams = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const list = await fetchTeams(token);
      setTeams(list);
    } catch (e) {
      if (isAuthSessionError(e)) {
        handleSessionExpired();
        return;
      }
      setError(formatTeamError(e));
    } finally {
      setLoading(false);
    }
  }, [handleSessionExpired, token]);

  const loadMembers = useCallback(
    async (team: TeamSummary) => {
      const teamId = numericTeamId(team);
      if (!token || teamId === null) return;
      setMembersLoading(true);
      setMembersError(null);
      try {
        const list = await fetchTeamMembers(token, teamId);
        setMembers(list);
      } catch (e) {
        if (isAuthSessionError(e)) {
          handleSessionExpired();
          return;
        }
        setMembersError(formatTeamError(e));
      } finally {
        setMembersLoading(false);
      }
    },
    [handleSessionExpired, token],
  );

  const loadTeamShares = useCallback(
    async (team: TeamSummary) => {
      const teamId = numericTeamId(team);
      if (!token || teamId === null) return;
      setSharesLoading(true);
      setSharesError(null);
      try {
        const list = await listTeamShares(token, teamId);
        setTeamShares(list);
      } catch (e) {
        if (isAuthSessionError(e)) {
          handleSessionExpired();
          return;
        }
        setSharesError(formatTeamSyncError(e));
      } finally {
        setSharesLoading(false);
      }
    },
    [handleSessionExpired, token],
  );

  const loadTeamDataPeek = useCallback(
    async (team: TeamSummary, options?: { silent?: boolean; afterUpload?: boolean }) => {
      const teamId = numericTeamId(team);
      if (!token || teamId === null) return;
      const silent = options?.silent === true;
      if (!silent) {
        setDataPeekLoading(true);
      }
      setDataPeekError(null);
      try {
        const result = await peekTeamModules(token, teamId, {
          afterUpload: options?.afterUpload === true,
        });
        setDataPeek(result);
      } catch (e) {
        if (isAuthSessionError(e)) {
          handleSessionExpired();
          return;
        }
        if (!silent) {
          setDataPeek(null);
        }
        setDataPeekError(formatTeamSyncError(e));
      } finally {
        if (!silent) {
          setDataPeekLoading(false);
        }
      }
    },
    [handleSessionExpired, token],
  );

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  // 从侧栏「编辑」带入的 teamId：列表加载后自动进入详情
  useEffect(() => {
    if (initialTeamId == null || initialTeamId <= 0 || teams.length === 0) return;
    const team = teams.find((item) => item.id === initialTeamId);
    if (team) {
      setSelectedTeam(team);
    }
  }, [initialTeamId, teams]);

  useEffect(() => {
    if (!selectedTeam) {
      setMembers([]);
      setMembersError(null);
      setTeamShares([]);
      setSharesError(null);
      setDataPeek(null);
      setDataPeekError(null);
      setDetailTab("members");
      return;
    }
    void loadMembers(selectedTeam);
    if (detailTab === "data") {
      void loadTeamShares(selectedTeam);
      void loadTeamDataPeek(selectedTeam);
    }
  }, [detailTab, loadMembers, loadTeamDataPeek, loadTeamShares, selectedTeam]);

  const selectedRole = normalizeRole(selectedTeam?.roleCode);
  const canManage = canManageMembers(selectedRole);
  const canDissolve = selectedRole === "creator" && !isPersonalTeam(selectedTeam);

  const memberRoleOptions = useMemo(
    () => [
      { value: "user", label: t("userCenter.teams.roles.user") },
      { value: "manager", label: t("userCenter.teams.roles.manager") },
    ],
    [t],
  );

  const handleCreateTeam = useCallback(async () => {
    if (!token || creating) return;
    const name = await quickInput({
      title: t("userCenter.teams.createTitle"),
      subtitle: t("userCenter.teams.createSubtitle"),
      placeholder: t("userCenter.teams.teamNamePlaceholder"),
      validate: (value) =>
        value.trim() ? null : t("userCenter.teams.createNameRequired"),
    });
    if (!name) return;

    setCreating(true);
    try {
      await createTeam(token, name.trim());
      showToast(t("userCenter.teams.createSuccess"));
      await loadTeams();
    } catch (e) {
      if (isAuthSessionError(e)) {
        handleSessionExpired();
      } else {
        showToast(formatTeamError(e));
      }
    } finally {
      setCreating(false);
    }
  }, [creating, handleSessionExpired, loadTeams, t, token]);

  const resetAddMemberDialog = useCallback(() => {
    setAddMemberEmail("");
    setMemberSearchResults([]);
    setMemberSearchLoading(false);
    setMemberSearchError(null);
    setMemberSearchDone(false);
  }, []);

  const openAddMemberDialog = useCallback(() => {
    resetAddMemberDialog();
    setAddMemberOpen(true);
  }, [resetAddMemberDialog]);

  const closeAddMemberDialog = useCallback(() => {
    if (addingMember) return;
    setAddMemberOpen(false);
    resetAddMemberDialog();
  }, [addingMember, resetAddMemberDialog]);

  const handleSearchMemberByEmail = () => {
    if (!selectedTeam || memberSearchLoading) return;
    const email = addMemberEmail.trim();
    if (!email || !email.includes("@")) {
      showToast(t("userCenter.teams.emailRequired"));
      return;
    }

    setMemberSearchLoading(true);
    setMemberSearchError(null);
    setMemberSearchResults([]);
    setMemberSearchDone(false);

    const existingEmails = new Set(
      members.map((member) => member.email.trim().toLowerCase()).filter(Boolean),
    );
    if (existingEmails.has(email.toLowerCase())) {
      setMemberSearchError(t("userCenter.teams.memberAlreadyInTeam"));
      setMemberSearchDone(true);
      setMemberSearchLoading(false);
      return;
    }
    if (myEmail && emailsEqual(email, myEmail)) {
      setMemberSearchError(t("userCenter.teams.memberCannotAddSelf"));
      setMemberSearchDone(true);
      setMemberSearchLoading(false);
      return;
    }

    setMemberSearchResults([email]);
    setMemberSearchDone(true);
    setMemberSearchLoading(false);
  };

  const handleSelectMemberCandidate = async (email: string) => {
    const teamId = numericTeamId(selectedTeam);
    if (!token || !selectedTeam || teamId === null || addingMember) return;
    setAddingMember(true);
    try {
      await addTeamMember(token, teamId, {
        email,
        roleCode: "user",
      });
      showToast(t("userCenter.teams.addMemberSuccess"));
      setAddMemberOpen(false);
      resetAddMemberDialog();
      await loadMembers(selectedTeam);
    } catch (e) {
      if (isAuthSessionError(e)) {
        handleSessionExpired();
      } else {
        showToast(formatTeamError(e));
      }
    } finally {
      setAddingMember(false);
    }
  };

  const handleDissolveTeam = async () => {
    const teamId = numericTeamId(selectedTeam);
    if (!token || !selectedTeam || teamId === null || dissolving) return;
    const confirmed = await appConfirm(
      t("userCenter.teams.dissolveConfirm", { name: selectedTeam.name }),
      t("userCenter.teams.dissolveTitle"),
      { kind: "warning", confirmLabel: t("userCenter.teams.dissolve") },
    );
    if (!confirmed) return;

    setDissolving(true);
    try {
      await dissolveTeam(token, teamId);
      showToast(t("userCenter.teams.dissolveSuccess"));
      setSelectedTeam(null);
      await loadTeams();
    } catch (e) {
      if (isAuthSessionError(e)) {
        handleSessionExpired();
      } else {
        showToast(formatTeamError(e));
      }
    } finally {
      setDissolving(false);
    }
  };

  const openEditMember = (member: TeamMember) => {
    setEditMember(member);
    setEditDisplayName(member.userTeamName);
    setEditRole(normalizeRole(member.roleCode) === "manager" ? "manager" : "user");
  };

  const handleSaveMember = async () => {
    const teamId = numericTeamId(selectedTeam);
    if (!token || !selectedTeam || teamId === null || !editMember || savingMember) return;
    setSavingMember(true);
    try {
      await updateTeamMember(token, teamId, editMember.email, {
        roleCode: editRole,
        userTeamName: editDisplayName.trim() || null,
      });
      showToast(t("userCenter.teams.updateMemberSuccess"));
      setEditMember(null);
      await loadMembers(selectedTeam);
    } catch (e) {
      if (isAuthSessionError(e)) {
        handleSessionExpired();
      } else {
        showToast(formatTeamError(e));
      }
    } finally {
      setSavingMember(false);
    }
  };

  const handleRemoveMember = async (member: TeamMember) => {
    if (!token || !selectedTeam || busyMemberEmail) return;
    const name =
      member.userTeamName.trim() ||
      member.email.trim() ||
      t("userCenter.teams.unnamedMember");
    const confirmed = await appConfirm(
      t("userCenter.teams.removeMemberConfirm", { name }),
      t("userCenter.teams.removeMemberTitle"),
      { kind: "warning", confirmLabel: t("userCenter.teams.removeMember") },
    );
    if (!confirmed) return;

    setBusyMemberEmail(member.email);
    try {
      const teamId = numericTeamId(selectedTeam);
      if (teamId === null) return;
      await removeTeamMember(token, teamId, member.email);
      showToast(t("userCenter.teams.removeMemberSuccess"));
      await loadMembers(selectedTeam);
    } catch (e) {
      if (isAuthSessionError(e)) {
        handleSessionExpired();
      } else {
        showToast(formatTeamError(e));
      }
    } finally {
      setBusyMemberEmail(null);
    }
  };

  const handlePushTeamModules = async () => {
    if (!token || numericTeamId(selectedTeam) === null || syncModulesPushing) return;
    setSyncModulesPushing(true);
    try {
      const teamId = numericTeamId(selectedTeam);
      if (teamId === null) return;
      const result = await pushTeamModules(token, teamId);
      showToast(
        t("userCenter.teams.syncModulesPushSuccess", {
          size: Math.max(1, Math.round((result.bytes ?? 0) / 1024)),
        }),
      );
      if (selectedTeam) {
        await loadTeamDataPeek(selectedTeam, { afterUpload: true });
      }
    } catch (e) {
      if (isAuthSessionError(e)) {
        handleSessionExpired();
      } else {
        showToast(formatTeamSyncError(e));
      }
    } finally {
      setSyncModulesPushing(false);
    }
  };

  const handlePullTeamModules = async () => {
    if (!token || numericTeamId(selectedTeam) === null || syncModulesPulling) return;
    setSyncModulesPulling(true);
    try {
      const teamId = numericTeamId(selectedTeam);
      if (teamId === null) return;
      const result = await pullTeamModules(token, teamId);
      let detail = "";
      try {
        const parsed = JSON.parse(result.bodyJson) as {
          connections?: unknown[];
          databaseConnections?: unknown[];
        };
        detail = t("userCenter.teams.syncModulesPullDetail", {
          connections: parsed.connections?.length ?? 0,
          databases: parsed.databaseConnections?.length ?? 0,
        });
      } catch {
        detail = t("userCenter.teams.syncModulesPullSize", {
          size: Math.max(1, Math.round((result.bytes ?? 0) / 1024)),
        });
      }
      showToast(t("userCenter.teams.syncModulesPullSuccess", { detail }));
      if (selectedTeam) {
        await loadTeamDataPeek(selectedTeam);
      }
    } catch (e) {
      if (isAuthSessionError(e)) {
        handleSessionExpired();
      } else {
        showToast(formatTeamSyncError(e));
      }
    } finally {
      setSyncModulesPulling(false);
    }
  };

  const handleImportTeamShare = async (share: TeamShareSummary) => {
    if (!token || numericTeamId(selectedTeam) === null || importingShareId) return;
    setImportingShareId(share.shareId);
    try {
      const teamId = numericTeamId(selectedTeam);
      if (teamId === null) return;
      const fetched = await fetchTeamShare(token, teamId, share.shareId);
      const envelope = JSON.parse(fetched.bodyJson) as {
        snapshot?: CustomPanelShareSnapshot;
      };
      if (!envelope.snapshot) {
        showToast(t("userCenter.teams.shareImportInvalid"));
        return;
      }
      const panelId = importCustomPanelShareSnapshot(envelope.snapshot);
      if (!panelId) {
        showToast(t("userCenter.teams.shareImportInvalid"));
        return;
      }
      showToast(t("userCenter.teams.shareImportSuccess", { panel: share.panelLabel }));
    } catch (e) {
      if (isAuthSessionError(e)) {
        handleSessionExpired();
      } else {
        showToast(formatTeamSyncError(e));
      }
    } finally {
      setImportingShareId(null);
    }
  };

  const renderAddMemberDialog = () => (
    <FormDialog
      open={addMemberOpen}
      onClose={closeAddMemberDialog}
      title={t("userCenter.teams.addMemberTitle")}
      subtitle={t("userCenter.teams.addMemberSubtitle")}
      cancelDisabled={addingMember || memberSearchLoading}
      primaryAction={undefined}
    >
      <FormField label={t("userCenter.teams.memberEmail")}>
        <TextInput
          className="input"
          value={addMemberEmail}
          onChange={(value) => {
            setAddMemberEmail(value);
            setMemberSearchDone(false);
            setMemberSearchError(null);
          }}
          disabled={addingMember || memberSearchLoading}
          placeholder={t("userCenter.teams.memberEmailPlaceholder")}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void handleSearchMemberByEmail();
          }}
        />
      </FormField>
      <p className="user-center-team-add-member__hint">{t("userCenter.teams.memberEmailHint")}</p>

      {memberSearchLoading ? (
        <p className="user-center-team-add-member__status">{t("userCenter.teams.memberSearchLoading")}</p>
      ) : memberSearchError ? (
        <p className="user-center-team-add-member__error">{memberSearchError}</p>
      ) : memberSearchDone && memberSearchResults.length === 0 ? (
        <p className="user-center-team-add-member__status">{t("userCenter.teams.memberSearchEmpty")}</p>
      ) : memberSearchResults.length > 0 ? (
        <ul className="user-center-team-add-member__results">
          {memberSearchResults.map((email) => (
            <li key={email}>
              <button
                type="button"
                className="user-center-team-add-member__result"
                disabled={addingMember}
                onClick={() => void handleSelectMemberCandidate(email)}
              >
                <span className="user-center-team-add-member__result-name">{email}</span>
                <span className="user-center-team-add-member__result-meta">
                  {t("userCenter.teams.addMemberConfirmHint")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </FormDialog>
  );

  const renderEditMemberDialog = () => (
    <FormDialog
      open={Boolean(editMember)}
      onClose={() => {
        if (savingMember) return;
        setEditMember(null);
      }}
      title={t("userCenter.teams.editMemberTitle")}
      primaryAction={{
        label: savingMember ? t("userCenter.teams.savingMember") : t("userCenter.teams.saveMember"),
        disabled: savingMember,
        onClick: () => void handleSaveMember(),
      }}
      cancelDisabled={savingMember}
    >
      <FormField label={t("userCenter.teams.memberEmail")}>
        <TextInput className="input" value={editMember?.email ?? ""} disabled />
      </FormField>
      <FormField label={t("userCenter.teams.memberDisplayName")}>
        <TextInput
          className="input"
          value={editDisplayName}
          onChange={setEditDisplayName}
          disabled={savingMember}
          placeholder={t("userCenter.teams.memberDisplayNamePlaceholder")}
        />
      </FormField>
      <FormField label={t("userCenter.teams.memberRole")}>
        <Select
          className="setting-select"
          size="sm"
          value={editRole}
          onChange={(value) => setEditRole(value as "manager" | "user")}
          searchable={false}
          options={memberRoleOptions}
        />
      </FormField>
    </FormDialog>
  );

  if (selectedTeam) {
    return (
      <div className="user-center-content">
        <section className="user-center-section">
          <div className="user-center-teams-detail__toolbar">
            <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedTeam(null)}>
              {t("userCenter.teams.back")}
            </Button>
            {canDissolve ? (
              <Button
                type="button"
                variant="danger"
                size="sm"
                disabled={dissolving}
                onClick={() => void handleDissolveTeam()}
              >
                {dissolving ? t("userCenter.teams.dissolving") : t("userCenter.teams.dissolve")}
              </Button>
            ) : null}
          </div>

          <div className="user-center-teams-detail__hero">
            <div className="user-center-teams-detail__icon" aria-hidden>
              <IconUsers size={22} />
            </div>
            <div>
              <h3 className="user-center-section__title">{selectedTeam.name}</h3>
              <p className="user-center-section__desc">
                {t("userCenter.teams.myRole", { role: roleLabel(selectedTeam.roleCode) })}
                {selectedTeam.userTeamName.trim()
                  ? ` · ${t("userCenter.teams.myDisplayName", {
                      name: selectedTeam.userTeamName.trim(),
                    })}`
                  : null}
              </p>
            </div>
          </div>

          <div className="user-center-teams-detail__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={detailTab === "members"}
              className={`user-center-teams-detail__tab${detailTab === "members" ? " is-active" : ""}`}
              onClick={() => setDetailTab("members")}
            >
              {t("userCenter.teams.tabMembers")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={detailTab === "data"}
              className={`user-center-teams-detail__tab${detailTab === "data" ? " is-active" : ""}`}
              onClick={() => setDetailTab("data")}
            >
              {t("userCenter.teams.tabData")}
            </button>
          </div>

          {detailTab === "members" ? (
            <>
              <div className="user-center-devices__header">
                <div>
                  <h4 className="user-center-teams-detail__subtitle">
                    {t("userCenter.teams.membersTitle")}
                  </h4>
                  <p className="user-center-section__desc">{t("userCenter.teams.membersDesc")}</p>
                </div>
                {canManage ? (
                  <div className="user-center-devices__header-actions">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void loadMembers(selectedTeam)}
                      disabled={membersLoading}
                    >
                      {t("userCenter.teams.refresh")}
                    </Button>
                    <Button type="button" variant="primary" size="sm" onClick={openAddMemberDialog}>
                      <IconPlus size={14} />
                      {t("userCenter.teams.addMember")}
                    </Button>
                  </div>
                ) : null}
              </div>

              {membersLoading ? (
                <p className="user-center-devices__hint">{t("userCenter.teams.membersLoading")}</p>
              ) : membersError ? (
                <p className="user-center-devices__error">{membersError}</p>
              ) : members.length === 0 ? (
                <p className="user-center-devices__group-empty">{t("userCenter.teams.membersEmpty")}</p>
              ) : (
                <ul className="user-center-team-member-list">
                  {members.map((member) => {
                    const memberRole = normalizeRole(member.roleCode);
                    const isSelf = Boolean(
                      (myEmail && emailsEqual(member.email, myEmail)) ||
                        (myUnionId && emailsEqual(member.email, myUnionId)),
                    );
                    const isCreator = memberRole === "creator";
                    const canEdit =
                      canManage && !isCreator && !(isSelf && selectedRole !== "creator");
                    const canRemove =
                      canManage &&
                      !isCreator &&
                      !isSelf &&
                      !emailsEqual(member.email, selectedTeam.creator);
                    const busy = busyMemberEmail !== null && emailsEqual(busyMemberEmail, member.email);
                    const displayName =
                      member.userTeamName.trim() ||
                      member.email.trim() ||
                      t("userCenter.teams.unnamedMember");

                    return (
                      <li key={`${member.id}-${member.email}`} className="user-center-team-member">
                        <div className="user-center-team-member__main">
                          <span className="user-center-team-member__name" title={displayName}>
                            {displayName}
                            {isSelf ? (
                              <span className="user-center-team-member__you">
                                {t("userCenter.teams.you")}
                              </span>
                            ) : null}
                          </span>
                          <span className="user-center-team-member__meta">
                            {roleLabel(member.roleCode)} · {member.email.trim() || "—"}
                          </span>
                        </div>
                        <div className="user-center-team-member__actions">
                          {canEdit ? (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={busy}
                              onClick={() => openEditMember(member)}
                            >
                              {t("userCenter.teams.editMember")}
                            </Button>
                          ) : null}
                          {canRemove ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => void handleRemoveMember(member)}
                            >
                              <IconTrash size={14} />
                              {busy
                                ? t("userCenter.teams.removingMember")
                                : t("userCenter.teams.removeMember")}
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          ) : (
            <>
              <div className="user-center-devices__header">
                <div>
                  <h4 className="user-center-teams-detail__subtitle">
                    {t("userCenter.teams.dataPreviewTitle")}
                  </h4>
                  <p className="user-center-section__desc">{t("userCenter.teams.dataPreviewDesc")}</p>
                </div>
                <div className="user-center-devices__header-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      void loadTeamDataPeek(selectedTeam);
                      void loadTeamShares(selectedTeam);
                    }}
                    disabled={dataPeekLoading || sharesLoading}
                  >
                    {t("userCenter.teams.refresh")}
                  </Button>
                </div>
              </div>

              <TeamDataTree
                teamId={numericTeamId(selectedTeam) ?? 0}
                peek={dataPeek}
                loading={dataPeekLoading}
                error={dataPeekError}
                onExclusionChange={() => void loadTeamDataPeek(selectedTeam, { silent: true })}
              />

              <div className="user-center-teams-sync">
                <div className="user-center-devices__header">
                  <div>
                    <h4 className="user-center-teams-detail__subtitle">
                      {t("userCenter.teams.syncTitle")}
                    </h4>
                    <p className="user-center-section__desc">{t("userCenter.teams.syncDesc")}</p>
                  </div>
                  <div className="user-center-devices__header-actions">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={syncModulesPulling}
                      onClick={() => void handlePullTeamModules()}
                    >
                      {syncModulesPulling
                        ? t("userCenter.teams.syncModulesPulling")
                        : t("userCenter.teams.syncModulesPull")}
                    </Button>
                    {canManage ? (
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        disabled={syncModulesPushing}
                        onClick={() => void handlePushTeamModules()}
                      >
                        {syncModulesPushing
                          ? t("userCenter.teams.syncModulesPushing")
                          : t("userCenter.teams.syncModulesPush")}
                      </Button>
                    ) : null}
                  </div>
                </div>

                {sharesLoading ? (
                  <p className="user-center-devices__hint">{t("userCenter.teams.sharesLoading")}</p>
                ) : sharesError ? (
                  <p className="user-center-devices__error">{sharesError}</p>
                ) : teamShares.length === 0 ? (
                  <p className="user-center-devices__group-empty">{t("userCenter.teams.sharesEmpty")}</p>
                ) : (
                  <ul className="user-center-team-share-list">
                    {teamShares.map((share) => {
                      const fromName =
                        share.fromDisplayName.trim() ||
                        maskUnionId(share.fromUnionId) ||
                        t("userCenter.teams.unnamedMember");
                      const importing = importingShareId === share.shareId;
                      return (
                        <li key={share.shareId} className="user-center-team-share">
                          <div className="user-center-team-share__main">
                            <span className="user-center-team-share__name">{share.panelLabel}</span>
                            <span className="user-center-team-share__meta">
                              {t("userCenter.teams.shareFrom", { name: fromName })} ·{" "}
                              {formatTime(share.createdAt, locale)}
                            </span>
                          </div>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={importing}
                            onClick={() => void handleImportTeamShare(share)}
                          >
                            {importing
                              ? t("userCenter.teams.shareImporting")
                              : t("userCenter.teams.shareImport")}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
        </section>

        {renderAddMemberDialog()}
        {renderEditMemberDialog()}
      </div>
    );
  }

  return (
    <div className="user-center-content">
      <section className="user-center-section">
        <div className="user-center-devices__header">
          <div>
            <h3 className="user-center-section__title">{t("userCenter.teams.title")}</h3>
            <p className="user-center-section__desc">{t("userCenter.teams.desc")}</p>
          </div>
          <div className="user-center-devices__header-actions">
            <Button type="button" variant="secondary" size="sm" onClick={() => void loadTeams()} disabled={loading}>
              {t("userCenter.teams.refresh")}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={creating}
              onClick={() => void handleCreateTeam()}
            >
              <IconPlus size={14} />
              {creating ? t("userCenter.teams.creating") : t("userCenter.teams.create")}
            </Button>
          </div>
        </div>

        {loading ? (
          <p className="user-center-devices__hint">{t("userCenter.teams.loading")}</p>
        ) : error ? (
          <>
            <p className="user-center-devices__error">{error}</p>
            <div className="user-center-devices__actions">
              <Button type="button" variant="secondary" size="sm" onClick={() => void loadTeams()}>
                {t("userCenter.teams.retry")}
              </Button>
            </div>
          </>
        ) : teams.length === 0 ? (
          <div className="user-center-teams-empty">
            <div className="user-center-teams-empty__icon" aria-hidden>
              <IconUsers size={28} />
            </div>
            <p className="user-center-teams-empty__title">{t("userCenter.teams.emptyTitle")}</p>
            <p className="user-center-teams-empty__desc">{t("userCenter.teams.emptyDesc")}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={creating}
              onClick={() => void handleCreateTeam()}
            >
              {creating ? t("userCenter.teams.creating") : t("userCenter.teams.create")}
            </Button>
          </div>
        ) : (
          <ul className="user-center-team-grid">
            {teams.map((team) => (
              <li key={team.id}>
                <button
                  type="button"
                  className="user-center-team-card"
                  onClick={() => setSelectedTeam(team)}
                >
                  <div className="user-center-team-card__main">
                    <span className="user-center-team-card__name">{team.name}</span>
                    <span className="user-center-team-card__meta">
                      {roleLabel(team.roleCode)}
                      {team.userTeamName.trim() ? ` · ${team.userTeamName.trim()}` : ""}
                    </span>
                    <span className="user-center-team-card__time">
                      {t("userCenter.teams.updatedAt", {
                        time: formatTime(team.updatedAt || team.createdAt, locale),
                      })}
                    </span>
                  </div>
                  <IconChevronRight size={16} className="user-center-team-card__chevron" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
