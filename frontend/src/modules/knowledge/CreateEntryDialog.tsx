import { useState, useEffect } from "react";
import Editor from "@monaco-editor/react";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { useI18n } from "../../i18n";
import { FormDialog } from "../../components/ui/FormDialog";
import { Select } from "../../components/ui/Select";
import type { KnowledgeEntry } from "../../ipc/bindings";

interface CreateEntryDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CreateEntryDialog({ open, onClose }: CreateEntryDialogProps) {
  const { t } = useI18n();
  const saveEntry = useKnowledgeStore((s) => s.saveEntry);

  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("snippet");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [riskLevel, setRiskLevel] = useState("safe");
  const [source, setSource] = useState("");
  const [language, setLanguage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle("");
      setKind("snippet");
      setContent("");
      setTags("");
      setRiskLevel("safe");
      setSource("");
      setLanguage("");
      setSaving(false);
    }
  }, [open]);

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setSaving(true);
    const entry: KnowledgeEntry = {
      id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2),
      kind,
      title: title.trim(),
      content,
      tags: tags
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      riskLevel,
      source: source.trim(),
      envTag: "",
      language: language.trim(),
      usageCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const ok = await saveEntry(entry);
    setSaving(false);
    if (ok) {
      onClose();
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("knowledge.create")}
      size="lg"
      bodyClassName="knowledge-dialog-body"
      onCancel={onClose}
      cancelDisabled={saving}
      primaryAction={{
        label: saving ? "…" : t("knowledge.save"),
        disabled: saving || !title.trim(),
        onClick: () => void handleSubmit(),
      }}
    >
      <div className="form-field">
        <label className="form-label">{t("knowledge.title")} *</label>
        <input
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("knowledge.title")}
          autoFocus
          style={{ width: "100%" }}
        />
      </div>
      <div className="form-row">
        <div className="form-field" style={{ flex: 1 }}>
          <label className="form-label">{t("knowledge.type")}</label>
          <Select
            className="input"
            value={kind}
            onChange={setKind}
            style={{ width: "100%" }}
            searchable={false}
            options={[
              { value: "snippet", label: t("knowledge.types.snippet") },
              { value: "case", label: t("knowledge.types.case") },
              { value: "ai", label: t("knowledge.types.ai") },
            ]}
          />
        </div>
        <div className="form-field" style={{ flex: 1 }}>
          <label className="form-label">{t("knowledge.riskLevel")}</label>
          <Select
            className="input"
            value={riskLevel}
            onChange={setRiskLevel}
            style={{ width: "100%" }}
            searchable={false}
            options={[
              { value: "safe", label: t("knowledge.risks.safe") },
              { value: "readonly", label: t("knowledge.risks.readonly") },
              { value: "medium", label: t("knowledge.risks.medium") },
              { value: "dangerous", label: t("knowledge.risks.dangerous") },
            ]}
          />
        </div>
      </div>
      <div className="form-field">
        <label className="form-label">{t("knowledge.content")}</label>
        <div className="knowledge-editor-shell">
          <Editor
            height="240px"
            language="markdown"
            theme="vs-dark"
            value={content}
            onChange={(v) => setContent(v ?? "")}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: "on",
              wordWrap: "on",
              scrollBeyondLastLine: false,
              padding: { top: 8, bottom: 8 },
            }}
          />
        </div>
      </div>
      <div className="form-row">
        <div className="form-field" style={{ flex: 1 }}>
          <label className="form-label">{t("knowledge.source")}</label>
          <input
            className="input"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={t("knowledge.source")}
            style={{ width: "100%" }}
          />
        </div>
        <div className="form-field" style={{ flex: 1 }}>
          <label className="form-label">{t("knowledge.language")}</label>
          <input
            className="input"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder={t("knowledge.language")}
            style={{ width: "100%" }}
          />
        </div>
      </div>
      <div className="form-field">
        <label className="form-label">{t("knowledge.tags")} (逗号分隔)</label>
        <input
          className="input"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="tag1, tag2, tag3"
          style={{ width: "100%" }}
        />
      </div>
    </FormDialog>
  );
}
