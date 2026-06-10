import { useEffect, useState } from "react";
import { FormDialog } from "../../components/ui/FormDialog";
import Editor from "@monaco-editor/react";
import type { DockerActionResult } from "./useDockerWorkspace";

/* eslint-disable react-hooks/set-state-in-effect -- controlled form state reset */

interface DockerFileEditorProps {
  open: boolean;
  filePath: string | null;
  initialContent: string;
  onClose: () => void;
  onSave: (content: string) => Promise<DockerActionResult>;
}

const MAX_SAFE_BYTES = 64 * 1024;

export function DockerFileEditor({ open, filePath, initialContent, onClose, onSave }: DockerFileEditorProps) {
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setContent(initialContent);
      setSaving(false);
    }
  }, [open, initialContent]);

  if (filePath == null) return null;

  const bytes = new TextEncoder().encode(content).length;
  const tooLarge = bytes > MAX_SAFE_BYTES;
  const dirty = content !== initialContent;

  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const r = await onSave(content);
      if (r.ok) {
        setMessage(r.message ?? null);
      } else {
        setError(r.message ?? "保存失败");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={saving ? () => undefined : onClose}
      title={`编辑文件 · ${filePath}`}
      className="docker-file-editor"
      size="xl"
      closeDisabled={saving}
      cancelLabel="关闭"
      onCancel={onClose}
      cancelDisabled={saving}
      primaryAction={{
        label: saving ? "保存中…" : "保存",
        disabled: saving || !dirty || tooLarge,
        onClick: () => void handleSave(),
      }}
    >
          <div className="docker-file-editor-meta">
            <span className="text-muted text-sm">
              {bytes} / {MAX_SAFE_BYTES} 字节
            </span>
            {tooLarge && (
              <span className="docker-file-editor-warn text-sm">
                超出 {MAX_SAFE_BYTES / 1024} KB 编辑安全阈值，建议在外部编辑器中修改
              </span>
            )}
          </div>
          <div className="docker-file-editor-monaco" style={{ height: 360, border: "1px solid var(--border-1, #27272a)", borderRadius: 6, overflow: "hidden" }}>
            <Editor
              height="100%"
              language={filePath?.endsWith(".sql") ? "sql" : filePath?.endsWith(".json") ? "json" : filePath?.endsWith(".yaml") || filePath?.endsWith(".yml") ? "yaml" : filePath?.endsWith(".sh") ? "shell" : "dockerfile"}
              value={content}
              onChange={(v) => setContent(v ?? "")}
              theme="vs-dark"
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                wordWrap: "on",
                scrollBeyondLastLine: false,
                lineNumbers: "on",
                readOnly: saving,
                padding: { top: 8 },
              }}
            />
          </div>
          {error && <div className="text-danger text-sm" style={{ marginTop: 8 }}>{error}</div>}
          {message && <div className="text-success text-sm" style={{ marginTop: 8 }}>{message}</div>}
    </FormDialog>
  );
}
