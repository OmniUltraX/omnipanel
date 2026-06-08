import { useCallback, useEffect, useState } from "react";
import { commands } from "../../../../ipc/bindings";
import type { SshKeyInfo } from "../../../../ipc/bindings";
import { Select } from "../../../../components/ui/Select";

export function KeysModuleView() {
  const [keys, setKeys] = useState<SshKeyInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Generate form
  const [genKeyType, setGenKeyType] = useState<"ed25519" | "rsa">("ed25519");
  const [genBits, setGenBits] = useState("4096");
  const [genComment, setGenComment] = useState("");
  const [genPassphrase, setGenPassphrase] = useState("");
  const [generating, setGenerating] = useState(false);

  // Import form
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
        genPassphrase
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
      setError("请填写名称和私钥内容");
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

  return (
    <div className="ssh-detail">
      <div className="ssh-detail-header">
        <div>
          <div className="host-title">SSH Keys</div>
          <div className="host-addr-detail">统一管理本地 SSH 密钥</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => { setShowGenerate(true); setShowImport(false); }}>
            生成密钥
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => { setShowImport(true); setShowGenerate(false); }}>
            + 导入密钥
          </button>
        </div>
      </div>

      {error && <div className="sftp-error">{error}</div>}

      {showGenerate && (
        <div className="panel" style={{ marginBottom: 8 }}>
          <div className="panel-header"><h3>生成新密钥</h3></div>
          <div className="panel-body" style={{ padding: 12 }}>
            <div className="form-field">
              <label className="form-label">密钥类型</label>
              <Select
                className="input"
                value={genKeyType}
                onChange={(v) => setGenKeyType(v as "ed25519" | "rsa")}
                style={{ width: "100%" }}
                searchable={false}
                options={[
                  { value: "ed25519", label: "ED25519（推荐）" },
                  { value: "rsa", label: "RSA" },
                ]}
              />
            </div>
            {genKeyType === "rsa" && (
              <div className="form-field">
                <label className="form-label">位数</label>
                <input className="input" type="number" value={genBits} onChange={(e) => setGenBits(e.target.value)} style={{ width: "100%" }} />
              </div>
            )}
            <div className="form-field">
              <label className="form-label">注释</label>
              <input className="input" placeholder="user@host" value={genComment} onChange={(e) => setGenComment(e.target.value)} style={{ width: "100%" }} />
            </div>
            <div className="form-field">
              <label className="form-label">密码（可选）</label>
              <input className="input" type="password" placeholder="留空无密码" value={genPassphrase} onChange={(e) => setGenPassphrase(e.target.value)} style={{ width: "100%" }} />
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={handleGenerate} disabled={generating}>
                {generating ? "生成中…" : "生成"}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowGenerate(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {showImport && (
        <div className="panel" style={{ marginBottom: 8 }}>
          <div className="panel-header"><h3>导入密钥</h3></div>
          <div className="panel-body" style={{ padding: 12 }}>
            <div className="form-field">
              <label className="form-label">名称</label>
              <input className="input" placeholder="id_ed25519" value={importName} onChange={(e) => setImportName(e.target.value)} style={{ width: "100%" }} />
            </div>
            <div className="form-field">
              <label className="form-label">私钥内容</label>
              <textarea
                className="input"
                rows={6}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                value={importKey}
                onChange={(e) => setImportKey(e.target.value)}
                style={{ width: "100%", resize: "vertical", fontFamily: "monospace" }}
              />
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={handleImport} disabled={importing}>
                {importing ? "导入中…" : "导入"}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowImport(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      <div className="ssh-detail-body">
        <div className="panel">
          <div className="panel-header"><h3>Available Keys</h3></div>
          <div className="panel-body action-list">
            {loading && <div className="text-muted text-sm" style={{ padding: 12 }}>加载中…</div>}
            {!loading && keys.length === 0 && <div className="text-muted text-sm" style={{ padding: 12 }}>暂无密钥</div>}
            {keys.map((key) => (
              <div key={key.name} className="action-row" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div className="action-title">{key.name}</div>
                  <div className="action-meta">
                    {key.keyType} · {key.path} · {key.fingerprint}
                    {key.comment && ` · ${key.comment}`}
                  </div>
                </div>
                <button className="btn-icon text-danger" title="删除" onClick={() => setConfirmDelete(key.name)}>
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
            <h3>删除密钥</h3>
            <p className="text-sm">确定要删除密钥 <code>{confirmDelete}</code> 吗？此操作不可恢复。</p>
            <div className="flex gap-2" style={{ marginTop: 16, justifyContent: "flex-end" }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setConfirmDelete(null)}>取消</button>
              <button className="btn btn-danger btn-sm" onClick={() => handleDelete(confirmDelete)}>确认删除</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
