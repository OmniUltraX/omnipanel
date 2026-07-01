import { useCallback, useEffect, useState } from "react";
import { commands } from "../../../../ipc/bindings";
import type { SshKeyInfo } from "../../../../ipc/bindings";
import { Select } from "../../../../components/ui/Select";
import { PasswordInput } from "../../../../components/ui/PasswordInput";
import { TextInput } from "../../../../components/ui/TextInput";
import { useI18n } from "../../../../i18n";

export function KeysModuleView() {
  const { t } = useI18n();
  const [keys, setKeys] = useState<SshKeyInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [publicKeyName, setPublicKeyName] = useState<string | null>(null);
  const [publicKeyContent, setPublicKeyContent] = useState<string | null>(null);

  const [genKeyType, setGenKeyType] = useState<"ed25519" | "rsa">("ed25519");
  const [genBits, setGenBits] = useState("4096");
  const [genComment, setGenComment] = useState("");
  const [genPassphrase, setGenPassphrase] = useState("");
  const [generating, setGenerating] = useState(false);

  const [importName, setImportName] = useState("");
  const [importKey, setImportKey] = useState("");
  const [importing, setImporting] = useState(false);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await commands.sshListKeys();
      if (res.status === "ok") {
        setKeys(res.data);
      } else {
        setError(res.error.message);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await commands.sshGenerateKey(
        genKeyType,
        genKeyType === "rsa" ? parseInt(genBits, 10) || 4096 : null,
        genComment,
        genPassphrase,
        null,
      );
      if (res.status === "ok") {
        setShowGenerate(false);
        setGenComment("");
        setGenPassphrase("");
        loadKeys();
      } else {
        setError(res.error.message);
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
    try {
      const res = await commands.sshImportKey(importName.trim(), importKey.trim());
      if (res.status === "ok") {
        setShowImport(false);
        setImportName("");
        setImportKey("");
        loadKeys();
      } else {
        setError(res.error.message);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (name: string) => {
    try {
      const res = await commands.sshDeleteKey(name);
      if (res.status === "ok") {
        setConfirmDelete(null);
        loadKeys();
      } else {
        setError(res.error.message);
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
        setError(res.error.message);
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

  return (
    <div className="ssh-detail">
      <div className="ssh-detail-header">
        <div>
          <div className="host-title">{t("ssh.keys.title")}</div>
          <div className="host-addr-detail">{t("ssh.keys.subtitle")}</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setShowGenerate(true);
              setShowImport(false);
            }}
          >
            {t("ssh.keys.generate")}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              setShowImport(true);
              setShowGenerate(false);
            }}
          >
            + {t("ssh.keys.import")}
          </button>
        </div>
      </div>

      {error && <div className="sftp-error">{error}</div>}

      {showGenerate && (
        <div className="panel" style={{ margin: "0 24px 8px" }}>
          <div className="panel-header"><h3>{t("ssh.keys.generateTitle")}</h3></div>
          <div className="panel-body" style={{ padding: 12 }}>
            <div className="form-field">
              <label className="form-label">{t("ssh.keys.keyType")}</label>
              <Select
                className="input"
                value={genKeyType}
                onChange={(v) => setGenKeyType(v as "ed25519" | "rsa")}
                style={{ width: "100%" }}
                searchable={false}
                options={[
                  { value: "ed25519", label: t("ssh.keys.typeEd25519") },
                  { value: "rsa", label: t("ssh.keys.typeRsa") },
                ]}
              />
            </div>
            {genKeyType === "rsa" && (
              <div className="form-field">
                <label className="form-label">{t("ssh.keys.bits")}</label>
                <input
                  className="input"
                  type="number"
                  value={genBits}
                  onChange={(e) => setGenBits(e.target.value)}
                  style={{ width: "100%" }}
                />
              </div>
            )}
            <div className="form-field">
              <label className="form-label">{t("ssh.keys.comment")}</label>
              <TextInput
                placeholder="user@host"
                value={genComment}
                onChange={setGenComment}
              />
            </div>
            <div className="form-field">
              <label className="form-label">{t("ssh.keys.passphrase")}</label>
              <PasswordInput
                placeholder={t("ssh.keys.passphrasePlaceholder")}
                value={genPassphrase}
                onChange={setGenPassphrase}
                style={{ width: "100%" }}
              />
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={handleGenerate} disabled={generating}>
                {generating ? t("ssh.keys.generating") : t("ssh.keys.generateAction")}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowGenerate(false)}>
                {t("ssh.keys.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showImport && (
        <div className="panel" style={{ margin: "0 24px 8px" }}>
          <div className="panel-header"><h3>{t("ssh.keys.importTitle")}</h3></div>
          <div className="panel-body" style={{ padding: 12 }}>
            <div className="form-field">
              <label className="form-label">{t("ssh.keys.name")}</label>
              <TextInput
                placeholder={t("ssh.keys.namePlaceholder")}
                value={importName}
                onChange={setImportName}
              />
            </div>
            <div className="form-field">
              <label className="form-label">{t("ssh.keys.pem")}</label>
              <textarea
                className="input"
                rows={6}
                placeholder={t("ssh.keys.pemPlaceholder")}
                value={importKey}
                onChange={(e) => setImportKey(e.target.value)}
                style={{ width: "100%", resize: "vertical", fontFamily: "monospace" }}
              />
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={handleImport} disabled={importing}>
                {importing ? t("ssh.keys.importing") : t("ssh.keys.importAction")}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowImport(false)}>
                {t("ssh.keys.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="ssh-detail-body">
        <div className="panel">
          <div className="panel-header"><h3>{t("ssh.keys.listTitle")}</h3></div>
          <div className="panel-body action-list">
            {loading && <div className="text-muted text-sm" style={{ padding: 12 }}>{t("ssh.keys.loading")}</div>}
            {!loading && keys.length === 0 && (
              <div className="text-muted text-sm" style={{ padding: 12 }}>{t("ssh.keys.empty")}</div>
            )}
            {keys.map((key) => (
              <div key={key.name} className="action-row" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div className="action-title">{key.name}</div>
                  <div className="action-meta">
                    {key.keyType}
                    {key.path && ` · ${key.path}`}
                    {key.fingerprint && ` · ${key.fingerprint}`}
                    {key.comment && ` · ${key.comment}`}
                  </div>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  title={t("ssh.keys.viewPublic")}
                  onClick={() => handleViewPublic(key.name)}
                >
                  {t("ssh.keys.viewPublic")}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  title={t("ssh.keys.copyPath")}
                  onClick={() => handleCopyPath(key.path)}
                >
                  {t("ssh.keys.copyPath")}
                </button>
                <button className="btn-icon text-danger" title={t("ssh.keys.delete")} onClick={() => setConfirmDelete(key.name)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                    <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {confirmDelete && (
        <>
          <div className="drawer-overlay show" onClick={() => setConfirmDelete(null)} />
          <div className="confirm-modal">
            <h3>{t("ssh.keys.deleteTitle")}</h3>
            <p className="text-sm">{t("ssh.keys.deleteConfirm", { name: confirmDelete })}</p>
            <div className="flex gap-2" style={{ marginTop: 16, justifyContent: "flex-end" }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setConfirmDelete(null)}>
                {t("ssh.keys.cancel")}
              </button>
              <button className="btn btn-danger btn-sm" onClick={() => handleDelete(confirmDelete)}>
                {t("ssh.keys.deleteAction")}
              </button>
            </div>
          </div>
        </>
      )}

      {publicKeyName && publicKeyContent && (
        <>
          <div
            className="drawer-overlay show"
            onClick={() => {
              setPublicKeyName(null);
              setPublicKeyContent(null);
            }}
          />
          <div className="confirm-modal" style={{ maxWidth: 560 }}>
            <h3>{t("ssh.keys.publicKeyTitle")} — {publicKeyName}</h3>
            <textarea
              className="input"
              readOnly
              rows={4}
              value={publicKeyContent}
              style={{ width: "100%", fontFamily: "monospace", marginTop: 12 }}
            />
            <div className="flex gap-2" style={{ marginTop: 16, justifyContent: "flex-end" }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => navigator.clipboard.writeText(publicKeyContent)}
              >
                {t("ssh.keys.copyPublic")}
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setPublicKeyName(null);
                  setPublicKeyContent(null);
                }}
              >
                {t("ssh.keys.close")}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
