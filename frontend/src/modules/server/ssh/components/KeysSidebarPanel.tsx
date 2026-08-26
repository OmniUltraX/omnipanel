import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { commands } from "../../../../ipc/bindings";
import type { SshKeyInfo } from "../../../../ipc/bindings";
import { Select } from "../../../../components/ui/Select";
import { PasswordInput } from "../../../../components/ui/PasswordInput";
import { TextInput } from "../../../../components/ui/TextInput";
import type { ContextMenuItem } from "../../../../components/ui/ContextMenu";
import { FormDialog } from "../../../../components/ui/form/FormDialog";
import { IconCopy } from "../../../../components/ui/icons/Icons";
import { Button } from "../../../../components/ui/primitives/Button";
import {
  SidebarTreeNode,
  SidebarTreeRoot,
} from "../../../../components/ui/sidebar-tree";
import { useI18n } from "../../../../i18n";
import { quickInput } from "../../../../lib/quickInput";
import { showToast } from "../../../../stores/toastStore";
import { useConnectionStore } from "../../../../stores/connectionStore";
import { useSshWorkspaceNavStore } from "../stores/sshWorkspaceNavStore";
import { buildSshKeyUsageCounts } from "../utils/sshKeyUsage";
import { usePersistedSshTreeExpanded } from "../usePersistedSshTreeExpanded";
import { SshSidebarHeaderIconBtn, SshSidebarModal } from "./SshSidebarModal";
import { formatOmniError } from "../utils/formatOmniError";

function sshKeyTypeTreeKey(keyType: string) {
  return `ssh-key-type:${keyType.toLowerCase()}`;
}

function sshKeyTreeKey(id: string) {
  return `ssh-key:${id}`;
}

function keySubtitle(key: SshKeyInfo): string | null {
  const comment = key.comment?.trim();
  if (comment) return comment;
  const fingerprint = key.fingerprint?.trim();
  if (fingerprint) return fingerprint;
  return null;
}

function keyTypeLabel(keyType: string, t: (key: string) => string): string {
  const normalized = keyType.toLowerCase();
  if (normalized === "ed25519") return t("ssh.keys.typeEd25519");
  if (normalized === "rsa") return t("ssh.keys.typeRsa");
  if (normalized === "unknown") return t("ssh.keys.typeUnknown");
  return keyType.toUpperCase();
}

function groupKeysByType(keys: SshKeyInfo[]): [string, SshKeyInfo[]][] {
  const map = new Map<string, SshKeyInfo[]>();
  for (const key of keys) {
    const type = key.keyType?.trim().toLowerCase() || "unknown";
    const bucket = map.get(type) ?? [];
    bucket.push(key);
    map.set(type, bucket);
  }
  for (const bucket of map.values()) {
    bucket.sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}

function KeyDetailReadonlyField({
  label,
  copyTitle,
  value,
  rows,
  emptyHint,
  onCopy,
}: {
  label: string;
  copyTitle: string;
  value: string | null;
  rows: number;
  emptyHint: string;
  onCopy: (text: string) => void;
}) {
  return (
    <div className="form-field ssh-key-detail-field">
      <div className="form-label-row ssh-key-detail-field__head">
        <label className="form-label">{label}</label>
        {value ? (
          <Button
            type="button"
            variant="icon"
            size="icon-sm"
            className="ssh-key-detail-field__copy"
            title={copyTitle}
            aria-label={copyTitle}
            onClick={() => onCopy(value)}
          >
            <IconCopy size={14} />
          </Button>
        ) : null}
      </div>
      <div className="form-field__control">
        {value ? (
          <textarea className="input ssh-key-detail-field__textarea" readOnly rows={rows} value={value} />
        ) : (
          <p className="form-field-hint">{emptyHint}</p>
        )}
      </div>
    </div>
  );
}

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
  const [keyDetail, setKeyDetail] = useState<{
    name: string;
    publicKey: string | null;
    privateKey: string | null;
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

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
  const connections = useConnectionStore((s) => s.connections);
  const { isExpanded, toggle, ensureExpanded } = usePersistedSshTreeExpanded();

  const keyUsageCounts = useMemo(
    () => buildSshKeyUsageCounts(keys, connections),
    [keys, connections],
  );

  const keyGroups = useMemo(() => groupKeysByType(keys), [keys]);

  const expandKeyType = useCallback(
    (keyType: string) => {
      ensureExpanded(sshKeyTypeTreeKey(keyType));
    },
    [ensureExpanded],
  );

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
    const store = useConnectionStore.getState();
    if (!store.loaded && !store.loading) {
      void store.refresh();
    }
  }, []);

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
        expandKeyType(res.data.keyType);
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
        expandKeyType(res.data.keyType);
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

  const handleRenameKey = useCallback(
    (key: SshKeyInfo) => {
      void (async () => {
        const nextName = await quickInput({
          title: t("ssh.keys.renameTitle"),
          subtitle: t("ssh.keys.renamePrompt"),
          placeholder: key.name,
          defaultValue: key.name,
          validate: (value) => (value.trim() ? null : t("quickInput.required")),
        });
        if (nextName == null) return;
        const trimmed = nextName.trim();
        if (!trimmed || trimmed === key.name) return;
        setError(null);
        setSuccess(null);
        try {
          const res = await commands.sshRenameKey(key.name, trimmed);
          if (res.status === "ok") {
            if (activeKeyName === key.name) {
              selectKey(res.data.name);
            }
            setSuccess(t("ssh.keys.renameSuccess", { name: res.data.name }));
            await loadKeys();
          } else {
            setError(formatOmniError(res.error));
          }
        } catch (e) {
          setError(String(e));
        }
      })();
    },
    [activeKeyName, loadKeys, selectKey, t],
  );

  const handleCopyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(t("common.copied"));
    } catch {
      setError(t("ssh.keys.copyFailed"));
    }
  };

  const handleViewDetails = async (name: string) => {
    setError(null);
    setDetailLoading(true);
    try {
      const [publicRes, privateRes] = await Promise.all([
        commands.sshReadKeyPublic(name),
        commands.sshReadKeyPrivate(name),
      ]);
      if (publicRes.status !== "ok") {
        setError(formatOmniError(publicRes.error));
        return;
      }
      if (privateRes.status !== "ok") {
        setError(formatOmniError(privateRes.error));
        return;
      }
      if (!publicRes.data && !privateRes.data) {
        setError(t("ssh.keys.noKeyMaterial"));
        return;
      }
      setKeyDetail({
        name,
        publicKey: publicRes.data,
        privateKey: privateRes.data,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setDetailLoading(false);
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

      <FormDialog
        open={Boolean(keyDetail)}
        onClose={() => setKeyDetail(null)}
        title={t("ssh.keys.detailsTitle")}
        subtitle={keyDetail?.name}
        size="lg"
        cancelLabel={t("ssh.keys.close")}
        bodyClassName="ssh-key-detail-dialog"
      >
        {keyDetail ? (
          <>
            <KeyDetailReadonlyField
              label={t("ssh.keys.publicKeyTitle")}
              copyTitle={t("ssh.keys.copyPublic")}
              value={keyDetail.publicKey}
              rows={3}
              emptyHint={t("ssh.keys.noPublicKey")}
              onCopy={(text) => void handleCopyText(text)}
            />
            <KeyDetailReadonlyField
              label={t("ssh.keys.privateKeyTitle")}
              copyTitle={t("ssh.keys.copyPrivate")}
              value={keyDetail.privateKey}
              rows={8}
              emptyHint={t("ssh.keys.noPrivateKey")}
              onCopy={(text) => void handleCopyText(text)}
            />
          </>
        ) : null}
      </FormDialog>
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
        <div className="ssh-sidebar-tree-wrap">
          <SidebarTreeRoot className="ssh-sidebar-tree">
            {keyGroups.map(([keyType, typeKeys]) => {
              const typeTreeKey = sshKeyTypeTreeKey(keyType);
              const typeExpanded = isExpanded(typeTreeKey, true);
              return (
                <div key={keyType} className="ssh-tree-folder">
                  <SidebarTreeNode
                    depth={0}
                    module="ssh"
                    nodeType="key-type"
                    treeKey={typeTreeKey}
                    icon={<FolderIcon />}
                    label={`${keyTypeLabel(keyType, t)} (${typeKeys.length})`}
                    hasChildren
                    expanded={typeExpanded}
                    onToggle={() => toggle(typeTreeKey)}
                  />
                  {typeExpanded
                    ? typeKeys.map((key) => {
                        const treeKey = sshKeyTreeKey(key.id);
                        const selected = activeKeyName === key.name;
                        const subtitle = keySubtitle(key);
                        const hostUsageCount = keyUsageCounts.get(key.id) ?? 0;
                        const contextMenuItems: ContextMenuItem[] = [
                          {
                            id: "ssh-key-details",
                            label: t("ssh.keys.details"),
                            disabled: detailLoading,
                            onClick: () => void handleViewDetails(key.name),
                          },
                        ];
                        if (key.path) {
                          contextMenuItems.push({
                            id: "ssh-key-copy-path",
                            label: t("ssh.keys.copyPath"),
                            onClick: () => void handleCopyText(key.path),
                          });
                        }
                        return (
                          <div key={key.id} className="ssh-tree-key">
                            <SidebarTreeNode
                              depth={1}
                              module="ssh"
                              nodeType="key"
                              treeKey={treeKey}
                              icon={<KeyIcon />}
                              className={selected ? "selected" : ""}
                              active={selected}
                              label={
                                <span className="host-info ssh-tree-host-label">
                                  <span className="host-row-1">
                                    <span className="host-name" title={key.name}>
                                      {key.name}
                                    </span>
                                    {hostUsageCount > 0 ? (
                                      <span className="host-row-1-meta">
                                        <span
                                          className="badge badge-muted ssh-key-usage-tag"
                                          title={t("ssh.keys.hostUsage", { count: hostUsageCount })}
                                        >
                                          {t("ssh.keys.hostUsageTag", { count: hostUsageCount })}
                                        </span>
                                      </span>
                                    ) : null}
                                  </span>
                                  {subtitle ? (
                                    <span className="host-row-2" title={subtitle}>
                                      {subtitle}
                                    </span>
                                  ) : null}
                                </span>
                              }
                              trailing={
                                key.fingerprint ? (
                                  <span className="ssh-sidebar-list__preview" title={key.fingerprint}>
                                    {key.fingerprint.slice(0, 12)}…
                                  </span>
                                ) : null
                              }
                              hasChildren={false}
                              expanded={false}
                              onToggle={() => undefined}
                              onSelect={() => selectKey(key.name)}
                              onActivate={() => void handleViewDetails(key.name)}
                              onRename={() => handleRenameKey(key)}
                              renameLabel={t("ssh.keys.rename")}
                              contextMenuItems={contextMenuItems}
                              onDelete={() => setConfirmDelete(key.name)}
                              deleteLabel={t("ssh.keys.delete")}
                            />
                          </div>
                        );
                      })
                    : null}
                </div>
              );
            })}
          </SidebarTreeRoot>
        </div>
      )}
    </div>
  );
}
