import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../ui/primitives/Button";
import { ModuleEmptyState } from "../ui/feedback/ModuleEmptyState";
import {
  useThirdPartyAccountsStore,
  type ThirdPartyAccount,
} from "../../stores/thirdPartyAccountsStore";
import { ThirdPartyAccountDialog } from "./ThirdPartyAccountDialog";

export function ThirdPartyAccountsSection() {
  const { t } = useI18n();
  const accounts = useThirdPartyAccountsStore((s) => s.accounts);
  const loading = useThirdPartyAccountsStore((s) => s.loading);
  const storeError = useThirdPartyAccountsStore((s) => s.error);
  const refresh = useThirdPartyAccountsStore((s) => s.refresh);
  const upsertAccount = useThirdPartyAccountsStore((s) => s.upsertAccount);
  const removeAccount = useThirdPartyAccountsStore((s) => s.removeAccount);

  const [showDialog, setShowDialog] = useState(false);
  const [editingAccount, setEditingAccount] = useState<ThirdPartyAccount | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openAddDialog = () => {
    setEditingAccount(null);
    setShowDialog(true);
  };

  const openEditDialog = (account: ThirdPartyAccount) => {
    setConfirmDeleteId(null);
    setEditingAccount(account);
    setShowDialog(true);
  };

  const closeDialog = () => {
    setShowDialog(false);
    setEditingAccount(null);
  };

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <div>
          <h2>{t("settings.accounts.title")}</h2>
          <p className="section-desc">{t("settings.accounts.desc")}</p>
        </div>
        <Button
          variant="primary"
          size="sm"
          className="ai-models-add-btn"
          onClick={openAddDialog}
          title={t("settings.accounts.add.title")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span>{t("settings.accounts.add.title")}</span>
        </Button>
      </div>

      {storeError ? <p className="setting-update-error">{storeError}</p> : null}

      {loading && accounts.length === 0 ? (
        <p className="section-desc">{t("settings.accounts.loading")}</p>
      ) : accounts.length === 0 ? (
        <div className="ai-models-empty">
          <ModuleEmptyState
            preset="inbox"
            title={t("settings.accounts.empty.title")}
            desc={t("settings.accounts.empty.desc")}
          />
          <Button variant="secondary" size="sm" style={{ marginTop: "var(--sp-3)" }} onClick={openAddDialog}>
            {t("settings.accounts.empty.cta")}
          </Button>
        </div>
      ) : (
        <ul className="ai-models-list">
          {accounts.map((account) => {
            const isConfirmingDelete = confirmDeleteId === account.id;
            return (
              <li key={account.id} className="ai-provider-card">
                <div className="ai-provider-header">
                  <div className="ai-provider-header-main">
                    <span className="ai-provider-expand-placeholder" aria-hidden />
                    <div className="ai-provider-summary">
                      <div className="ai-provider-title-row">
                        <span className="ai-provider-name">{account.name}</span>
                        <span className="ai-model-row-standard">
                          {t(`settings.accounts.platforms.${account.platform}`)}
                        </span>
                        <span className="ai-provider-model-count">
                          {t(`settings.accounts.authMethods.${account.authMethod}`)}
                        </span>
                      </div>
                      <div className="ai-model-row-meta">
                        {account.authMethod === "password" && account.username ? (
                          <>
                            <span>{account.username}</span>
                            <span className="ai-model-row-sep">·</span>
                          </>
                        ) : null}
                        <span className="ai-model-row-key">
                          {account.hasSecret
                            ? t("settings.accounts.secretConfigured")
                            : t("settings.accounts.secretMissing")}
                        </span>
                        {account.notes ? (
                          <>
                            <span className="ai-model-row-sep">·</span>
                            <span title={account.notes}>{account.notes}</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="ai-model-row-actions">
                    {isConfirmingDelete ? (
                      <>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => {
                            void removeAccount(account.id);
                            setConfirmDeleteId(null);
                          }}
                        >
                          {t("settings.accounts.confirmDelete")}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>
                          {t("settings.accounts.cancelDelete")}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ai-model-row-edit"
                          title={t("settings.accounts.editBtn")}
                          onClick={() => openEditDialog(account)}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                            <path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                          </svg>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ai-model-row-delete"
                          title={t("settings.accounts.deleteBtn")}
                          onClick={() => setConfirmDeleteId(account.id)}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                            <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                          </svg>
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ThirdPartyAccountDialog
        open={showDialog}
        onClose={closeDialog}
        editAccount={editingAccount}
        onSubmit={upsertAccount}
      />
    </div>
  );
}
