import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { commands } from "../../../../ipc/bindings";
import type { SshKeyInfo } from "../../../../ipc/bindings";
import { Select } from "../../../../components/ui/Select";
import { PasswordInput } from "../../../../components/ui/PasswordInput";
import { TextInput } from "../../../../components/ui/TextInput";
import { useI18n } from "../../../../i18n";
import { useSshWorkspaceNavStore } from "../stores/sshWorkspaceNavStore";
import { SshSidebarHeaderIconBtn, SshSidebarModal } from "./SshSidebarModal";
import { formatOmniError } from "../utils/formatOmniError";

type Props = {
  onCountChange?: (count: number) => void;
  onHeaderMetaChange?: (meta: { count: number; actions: ReactNode }) => void;
  onEnsureExpanded?: () => void;
};

type SidebarForm = "none" | "generate" | "import";

export function KeysSidebarPanel({ onCountChange, onHeaderMetaChange, onEnsureExpanded }: Props) {
  const { t } = useI18n();
  const [keys, setKeys] = useState<SshKeyInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [form, setForm] = useState<SidebarForm>("none");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [publicKeyName, setPublicKeyName] = useState<string | null>(null);
  const [publicKeyContent, setPublicKeyContent] = useState<string | null>(null);
  const [privateKeyName, setPrivateKeyName] = useState<string | null>(null);
  const [privateKeyContent, setPrivateKeyContent] = useState<string | null>(null);

  const [genKeyType, setGenKeyType] = useState<"ed25519" | "rsa">("ed25519");
  const [genKeyName, setGenKeyName] = useState("");
  const [genBits, setGenBits] = useState("4096");
  const [genComment, setGenComment] = useState("");
  const [genPassphrase, setGenPassphrase] = useState("");
  const [generating, setGenerating] = useState(false);

  const [importName, setImportName] = useState("");
  const [importKey, setImportKey] = useState("");
  const [importing, setImporting] = useState(false);

  const activeKeyName = useSshWorkspaceNavStore((s) => s.activeKeyName);
  const selectKey = useSshWorkspaceNavStore((s) => s.selectKey);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await commands.sshListKeys();
      if (res.status === "ok") {
        setKeys(res.data);
        return res.data;
      }
      setError(formatOmniError(res.error));
      return null;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  useEffect(() => {
    onCountChange?.(keys.length);
  }, [keys.length, onCountChange]);

  const toggleForm = useCallback(
    (next: SidebarForm) => {
      onEnsureExpanded?.();
      setForm((current) => (current === next ? "none" : next));
      setError(null);
      setSuccess(null);
    },
    [onEnsureExpanded],
  );

  const headerToolbar = useMemo(
    () => (
      <div className="schema-toolbar schema-toolbar--inline">
        <SshSidebarHeaderIconBtn
          title={t("common.refresh")}
          disabled={loading}
          onClick={() => void loadKeys()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </SshSidebarHeaderIconBtn>
        <SshSidebarHeaderIconBtn
          title={t("ssh.keys.generate")}
          active={form === "generate"}
          onClick={() => toggleForm("generate")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
          </svg>
        </SshSidebarHeaderIconBtn>
        <SshSidebarHeaderIconBtn
          title={t("ssh.keys.import")}
          active={form === "import"}
          onClick={() => toggleForm("import")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </SshSidebarHeaderIconBtn>
      </div>
    ),
    [form, loadKeys, loading, t, toggleForm],
  );

  useLayoutEffect(() => {
    onHeaderMetaChange?.({ count: keys.length, actions: headerToolbar });
  }, [headerToolbar, keys.length, onHeaderMetaChange]);

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await commands.sshGenerateKey(
        genKeyType,
        genKeyType === "rsa" ? parseInt(genBits, 10) || 4096 : null,
        genComment,
        genPassphrase,
        genKeyName.trim() || null,
      );
      if (res.status === "ok") {
        setForm("none");
        setGenKeyName("");
        setGenComment("");
        setGenPassphrase("");
        selectKey(res.data.name);
        setSuccess(t("ssh.keys.generateSuccess", { name: res.data.name }));
        await loadKeys();
      } else {
        setError(formatOmniError(res.error));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  };

  const handleImport = async () => {
    if (!importName.trim() || !importKey.trim()) {
      setError(t("ssh.keys.nameAndKeyRequired"));
      return;
    }
    setImporting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await commands.sshImportKey(importName.trim(), importKey.trim());
      if (res.status === "ok") {
        setForm("none");
        setImportName("");
        setImportKey("");
        selectKey(res.data.name);
        setSuccess(t("ssh.keys.importSuccess", { name: res.data.name }));
        await loadKeys();
      } else {
        setError(formatOmniError(res.error));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (name: string) => {
    setError(null);
    setSuccess(null);
    try {
      const res = await commands.sshDeleteKey(name);
      if (res.status === "ok") {
        setConfirmDelete(null);
        if (activeKeyName === name) {
          selectKey(null);
        }
        await loadKeys();
      } else {
        setError(formatOmniError(res.error));
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const handleViewPublic = async (name: string) => {
    setError(null);
    try {
      const res = await commands.sshReadKeyPublic(name);
      if (res.status === "ok") {
        if (!res.data) {
          setError(t("ssh.keys.noPublicKey"));
          return;
        }
        setPublicKeyName(name);
        setPublicKeyContent(res.data);
      } else {
        setError(formatOmniError(res.error));
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const handleViewPrivate = async (name: string) => {
    setError(null);
    try {
      const res = await commands.sshReadKeyPrivate(name);
      if (res.status === "ok") {
        if (!res.data) {
          setError(t("ssh.keys.noPrivateKey"));
          return;
        }
        setPrivateKeyName(name);
        setPrivateKeyContent(res.data);
      } else {
        setError(formatOmniError(res.error));
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCopyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      setError(t("ssh.keys.copyFailed"));
    }
  };

  const modals = (
    <>
      <SshSidebarModal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title={t("ssh.keys.deleteTitle")}
        footer={
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmDelete(null)}>
              {t("ssh.keys.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => confirmDelete && void handleDelete(confirmDelete)}
            >
              {t("ssh.keys.deleteAction")}
            </button>
          </>
        }
      >
        <p className="text-sm">{confirmDelete ? t("ssh.keys.deleteConfirm", { name: confirmDelete }) : null}</p>
      </SshSidebarModal>

      <SshSidebarModal
        open={Boolean(publicKeyName && publicKeyContent)}
        onClose={() => {
          setPublicKeyName(null);
          setPublicKeyContent(null);
        }}
        title={`${t("ssh.keys.publicKeyTitle")} — ${publicKeyName ?? ""}`}
        maxWidth={560}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => publicKeyContent && void navigator.clipboard.writeText(publicKeyContent)}
            >
              {t("ssh.keys.copyPublic")}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setPublicKeyName(null);
                setPublicKeyContent(null);
              }}
            >
              {t("ssh.keys.close")}
            </button>
          </>
        }
      >
        <textarea
          className="input ssh-sidebar-modal__textarea"
          readOnly
          rows={4}
          value={publicKeyContent ?? ""}
        />
      </SshSidebarModal>

      <SshSidebarModal
        open={Boolean(privateKeyName && privateKeyContent)}
        onClose={() => {
          setPrivateKeyName(null);
          setPrivateKeyContent(null);
        }}
        title={`${t("ssh.keys.privateKeyTitle")} — ${privateKeyName ?? ""}`}
        maxWidth={560}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => privateKeyContent && void navigator.clipboard.writeText(privateKeyContent)}
            >
              {t("ssh.keys.copyPrivate")}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setPrivateKeyName(null);
                setPrivateKeyContent(null);
              }}
            >
              {t("ssh.keys.close")}
            </button>
          </>
        }
      >
        <textarea
          className="input ssh-sidebar-modal__textarea"
          readOnly
          rows={8}
          value={privateKeyContent ?? ""}
        />
      </SshSidebarModal>
    </>
  );

  return (
    <div className="ssh-sidebar-list-panel">
      {createPortal(modals, document.body)}

      {error ? <div className="ssh-sidebar-list-panel__error">{error}</div> : null}
      {success ? <div className="ssh-sidebar-list-panel__success">{success}</div> : null}

      {form === "generate" ? (
        <div className="ssh-sidebar-form">
          <Select
            className="input input-sm"
            value={genKeyType}
            onChange={(v) => setGenKeyType(v as "ed25519" | "rsa")}
            searchable={false}
            options={[
              { value: "ed25519", label: t("ssh.keys.typeEd25519") },
              { value: "rsa", label: t("ssh.keys.typeRsa") },
            ]}
          />
          {genKeyType === "rsa" ? (
            <input
              className="input input-sm"
              type="number"
              placeholder={t("ssh.keys.bits")}
              value={genBits}
              onChange={(e) => setGenBits(e.target.value)}
            />
          ) : null}
          <TextInput
            size="sm"
            placeholder={t("ssh.keys.nameOptional")}
            value={genKeyName}
            onChange={setGenKeyName}
          />
          <TextInput
            size="sm"
            placeholder={t("ssh.keys.comment")}
            value={genComment}
            onChange={setGenComment}
          />
          <PasswordInput
            className="input input-sm"
            placeholder={t("ssh.keys.passphrasePlaceholder")}
            value={genPassphrase}
            onChange={setGenPassphrase}
          />
          <div className="ssh-sidebar-form__actions">
            <button
              type="button"
              className="btn btn-primary btn-xs"
              disabled={generating}
              onClick={() => void handleGenerate()}
            >
              {generating ? t("ssh.keys.generating") : t("ssh.keys.generateAction")}
            </button>
            <button type="button" className="btn btn-secondary btn-xs" onClick={() => setForm("none")}>
              {t("ssh.keys.cancel")}
            </button>
          </div>
        </div>
      ) : null}

      {form === "import" ? (
        <div className="ssh-sidebar-form">
          <TextInput
            size="sm"
            placeholder={t("ssh.keys.namePlaceholder")}
            value={importName}
            onChange={setImportName}
          />
          <textarea
            className="input input-sm ssh-sidebar-form__textarea"
            rows={4}
            placeholder={t("ssh.keys.pemPlaceholder")}
            value={importKey}
            onChange={(e) => setImportKey(e.target.value)}
          />
          <div className="ssh-sidebar-form__actions">
            <button
              type="button"
              className="btn btn-primary btn-xs"
              disabled={importing}
              onClick={() => void handleImport()}
            >
              {importing ? t("ssh.keys.importing") : t("ssh.keys.importAction")}
            </button>
            <button type="button" className="btn btn-secondary btn-xs" onClick={() => setForm("none")}>
              {t("ssh.keys.cancel")}
            </button>
          </div>
        </div>
      ) : null}

      {loading && keys.length === 0 ? (
        <div className="ssh-sidebar-list-panel__empty">{t("ssh.keys.loading")}</div>
      ) : keys.length === 0 ? (
        <div className="ssh-sidebar-list-panel__empty">{t("ssh.keys.empty")}</div>
      ) : (
        <ul className="ssh-sidebar-list">
          {keys.map((key) => {
            const selected = activeKeyName === key.name;
            return (
              <li
                key={key.name}
                className={`ssh-sidebar-list__row${selected ? " ssh-sidebar-list__row--active" : ""}`}
              >
                <button
                  type="button"
                  className="ssh-sidebar-list__item"
                  onClick={() => selectKey(key.name)}
                >
                  <span className="ssh-sidebar-list__name">{key.name}</span>
                  <span className="ssh-sidebar-list__meta">
                    <span>{key.keyType.toUpperCase()}</span>
                  </span>
                </button>
                <div className="ssh-sidebar-list__aside">
                  {key.fingerprint ? (
                    <span className="ssh-sidebar-list__preview-idle" title={key.fingerprint}>
                      {key.fingerprint.slice(0, 12)}…
                    </span>
                  ) : null}
                  <div className="ssh-sidebar-list__aside-hover">
                    <div className="ssh-sidebar-list__row-actions">
                      <button
                        type="button"
                        className="ssh-sidebar-list__action-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleViewPublic(key.name);
                        }}
                      >
                        {t("ssh.keys.viewPublic")}
                      </button>
                      <button
                        type="button"
                        className="ssh-sidebar-list__action-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleViewPrivate(key.name);
                        }}
                      >
                        {t("ssh.keys.viewPrivate")}
                      </button>
                      {key.path ? (
                        <button
                          type="button"
                          className="ssh-sidebar-list__action-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleCopyPath(key.path);
                          }}
                        >
                          {t("ssh.keys.copyPath")}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="ssh-sidebar-list__action-btn ssh-sidebar-list__action-btn--danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelete(key.name);
                        }}
                      >
                        {t("ssh.keys.delete")}
                      </button>
                    </div>
                    {key.fingerprint ? (
                      <span className="ssh-sidebar-list__preview" title={key.fingerprint}>
                        {key.fingerprint.slice(0, 12)}…
                      </span>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
