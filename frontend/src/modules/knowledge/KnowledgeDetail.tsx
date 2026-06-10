import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import Editor from "@monaco-editor/react";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { useI18n } from "../../i18n";
import { Select } from "../../components/ui/Select";
import type { KnowledgeEntry } from "../../ipc/bindings";

function formatDate(dateVal: number | string | null | undefined): string {
  if (dateVal == null) return "—";
  try {
    const ms = typeof dateVal === "number" ? dateVal : new Date(dateVal).getTime();
    return new Date(ms).toLocaleString();
  } catch {
    return String(dateVal);
  }
}

export function KnowledgeDetail() {
  const { t } = useI18n();
  const entries = useKnowledgeStore((s) => s.entries);
  const searchResults = useKnowledgeStore((s) => s.searchResults);
  const selectedEntryId = useKnowledgeStore((s) => s.selectedEntryId);
  const editingEntry = useKnowledgeStore((s) => s.editingEntry);
  const setEditingEntry = useKnowledgeStore((s) => s.setEditingEntry);
  const setSelectedEntry = useKnowledgeStore((s) => s.setSelectedEntry);
  const saveEntry = useKnowledgeStore((s) => s.saveEntry);
  const deleteEntry = useKnowledgeStore((s) => s.deleteEntry);

  // Find the selected entry from entries or search results
  const selectedEntry =
    entries.find((e) => e.id === selectedEntryId) ??
    searchResults.find((r) => r.entry.id === selectedEntryId)?.entry ??
    null;

  // Edit form state
  const [editTitle, setEditTitle] = useState("");
  const [editKind, setEditKind] = useState("snippet");
  const [editContent, setEditContent] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editRisk, setEditRisk] = useState("safe");
  const [editSource, setEditSource] = useState("");
  const [editLanguage, setEditLanguage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editingEntry) {
      setEditTitle(editingEntry.title);
      setEditKind(editingEntry.kind);
      setEditContent(editingEntry.content);
      setEditTags(editingEntry.tags.join(", "));
      setEditRisk(editingEntry.riskLevel);
      setEditSource(editingEntry.source ?? "");
      setEditLanguage(editingEntry.language ?? "");
    }
  }, [editingEntry]);

  const handleEdit = () => {
    if (selectedEntry) {
      setEditingEntry(selectedEntry);
    }
  };

  const handleCancelEdit = () => {
    setEditingEntry(null);
  };

  const handleSave = async () => {
    if (!editingEntry) return;
    setSaving(true);
    const updated: KnowledgeEntry = {
      ...editingEntry,
      title: editTitle,
      kind: editKind,
      content: editContent,
      tags: editTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      riskLevel: editRisk,
      source: editSource.trim(),
      language: editLanguage.trim(),
      updatedAt: Date.now(),
    };
    const ok = await saveEntry(updated);
    setSaving(false);
    if (ok) {
      setEditingEntry(null);
    }
  };

  const handleDelete = async () => {
    if (!selectedEntry) return;
    if (!window.confirm(t("knowledge.confirmDelete"))) return;
    await deleteEntry(selectedEntry.id);
    setSelectedEntry(null);
    setEditingEntry(null);
  };

  // No selection
  if (!selectedEntry && !editingEntry) {
    return (
      <div className="knowledge-detail">
        <div className="knowledge-empty">
          <div className="knowledge-empty-icon">📚</div>
          <div className="knowledge-empty-title">{t("knowledge.noEntries")}</div>
          <div className="knowledge-empty-desc">{t("knowledge.createFirst")}</div>
        </div>
      </div>
    );
  }

  // Edit mode
  if (editingEntry) {
    return (
      <div className="knowledge-detail">
        <div className="knowledge-detail-header">
          <h2>{t("knowledge.edit")}</h2>
          <div className="knowledge-detail-actions">
            <button className="knowledge-btn" onClick={handleCancelEdit}>
              {t("knowledge.cancel")}
            </button>
            <button
              className="knowledge-btn knowledge-btn-primary"
              onClick={handleSave}
              disabled={saving || !editTitle.trim()}
            >
              {saving ? "…" : t("knowledge.save")}
            </button>
          </div>
        </div>
        <div className="knowledge-detail-body">
          <div className="knowledge-field">
            <label>{t("knowledge.title")}</label>
            <input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder={t("knowledge.title")}
            />
          </div>
          <div className="knowledge-field-row">
            <div className="knowledge-field">
              <label>{t("knowledge.type")}</label>
              <Select
                value={editKind}
                onChange={setEditKind}
                searchable={false}
                options={[
                  { value: "snippet", label: t("knowledge.types.snippet") },
                  { value: "case", label: t("knowledge.types.case") },
                  { value: "ai", label: t("knowledge.types.ai") },
                ]}
              />
            </div>
            <div className="knowledge-field">
              <label>{t("knowledge.riskLevel")}</label>
              <Select
                value={editRisk}
                onChange={setEditRisk}
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
          <div className="knowledge-field">
            <label>{t("knowledge.content")}</label>
            <div className="knowledge-editor-shell">
              <Editor
                height="240px"
                language="markdown"
                theme="vs-dark"
                value={editContent}
                onChange={(v) => setEditContent(v ?? "")}
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
          <div className="knowledge-field-row">
            <div className="knowledge-field">
              <label>{t("knowledge.source")}</label>
              <input
                value={editSource}
                onChange={(e) => setEditSource(e.target.value)}
                placeholder={t("knowledge.source")}
              />
            </div>
            <div className="knowledge-field">
              <label>{t("knowledge.language")}</label>
              <input
                value={editLanguage}
                onChange={(e) => setEditLanguage(e.target.value)}
                placeholder={t("knowledge.language")}
              />
            </div>
          </div>
          <div className="knowledge-field">
            <label>{t("knowledge.tags")} (逗号分隔)</label>
            <input
              value={editTags}
              onChange={(e) => setEditTags(e.target.value)}
              placeholder="tag1, tag2, tag3"
            />
          </div>
        </div>
      </div>
    );
  }

  // View mode
  const entry = selectedEntry!;
  return (
    <div className="knowledge-detail">
      <div className="knowledge-detail-header">
        <h2>{entry.title}</h2>
        <div className="knowledge-detail-actions">
          <button className="knowledge-btn knowledge-btn-sm" onClick={handleEdit}>
            {t("knowledge.edit")}
          </button>
          <button
            className="knowledge-btn knowledge-btn-sm knowledge-btn-danger"
            onClick={handleDelete}
          >
            {t("knowledge.delete")}
          </button>
        </div>
      </div>
      <div className="knowledge-detail-body">
        <div className="knowledge-detail-meta">
          <span className="knowledge-detail-meta-item">
            📋 {t("knowledge.type")}: {t(`knowledge.types.${entry.kind}`) ?? entry.kind}
          </span>
          <span className="knowledge-detail-meta-item">
            🛡️ {t("knowledge.riskLevel")}:{" "}
            {t(`knowledge.risks.${entry.riskLevel}`) ?? entry.riskLevel}
          </span>
          {entry.source && (
            <span className="knowledge-detail-meta-item">
              📎 {t("knowledge.source")}: {entry.source}
            </span>
          )}
          {entry.language && (
            <span className="knowledge-detail-meta-item">
              💬 {t("knowledge.language")}: {entry.language}
            </span>
          )}
          {entry.envTag && (
            <span className="knowledge-detail-meta-item">
              🌐 {t("knowledge.envTag")}: {entry.envTag}
            </span>
          )}
          <span className="knowledge-detail-meta-item">
            📊 {t("knowledge.usageCount")}: {entry.usageCount}
          </span>
          <span className="knowledge-detail-meta-item">
            🕐 {t("knowledge.createdAt")}: {formatDate(entry.createdAt)}
          </span>
          <span className="knowledge-detail-meta-item">
            ✏️ {t("knowledge.updatedAt")}: {formatDate(entry.updatedAt)}
          </span>
        </div>
        <div className="knowledge-detail-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {entry.content}
          </ReactMarkdown>
        </div>
        {entry.tags.length > 0 && (
          <div className="knowledge-detail-tags">
            {entry.tags.map((tag) => (
              <span key={tag} className="knowledge-tag-pill">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
