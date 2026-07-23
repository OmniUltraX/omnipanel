import { useEffect, useMemo, useState } from "react";
import { commands, type KnowledgeRevision } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";

interface KnowledgeHistoryPanelProps {
  entryId: string;
  currentTitle: string;
  currentContent: string;
  open: boolean;
  onClose: () => void;
  onRestore: (title: string, content: string) => void;
}

function lineDiff(a: string, b: string): { type: "same" | "add" | "del"; text: string }[] {
  const left = a.split(/\r?\n/);
  const right = b.split(/\r?\n/);
  const max = Math.max(left.length, right.length);
  const out: { type: "same" | "add" | "del"; text: string }[] = [];
  for (let i = 0; i < max; i++) {
    const l = left[i];
    const r = right[i];
    if (l === r) {
      if (l != null) out.push({ type: "same", text: l });
    } else {
      if (l != null) out.push({ type: "del", text: l });
      if (r != null) out.push({ type: "add", text: r });
    }
  }
  return out.slice(0, 200);
}

export function KnowledgeHistoryPanel({
  entryId,
  currentTitle,
  currentContent,
  open,
  onClose,
  onRestore,
}: KnowledgeHistoryPanelProps) {
  const { t } = useI18n();
  const [revisions, setRevisions] = useState<KnowledgeRevision[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void unwrapCommand(commands.knowledgeListRevisions(entryId))
      .then((items) => {
        if (cancelled) return;
        setRevisions(items);
        setSelectedId(items[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setRevisions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entryId, open]);

  const selected = useMemo(
    () => revisions.find((item) => item.id === selectedId) ?? null,
    [revisions, selectedId],
  );

  const diff = useMemo(() => {
    if (!selected) return [];
    return lineDiff(selected.content, currentContent);
  }, [currentContent, selected]);

  if (!open) return null;

  return (
    <div className="knowledge-history">
      <div className="knowledge-history__header">
        <strong>{t("knowledge.history.title")}</strong>
        <button type="button" className="knowledge-history__close" onClick={onClose}>
          ×
        </button>
      </div>
      {loading ? (
        <div className="knowledge-rail-empty">{t("knowledge.history.loading")}</div>
      ) : revisions.length === 0 ? (
        <div className="knowledge-rail-empty">{t("knowledge.history.empty")}</div>
      ) : (
        <div className="knowledge-history__body">
          <ul className="knowledge-history__list">
            {revisions.map((rev) => (
              <li key={rev.id}>
                <button
                  type="button"
                  className={`knowledge-history__item${rev.id === selectedId ? " is-active" : ""}`}
                  onClick={() => setSelectedId(rev.id)}
                >
                  <span>{rev.title || currentTitle}</span>
                  <span className="knowledge-history__time">
                    {new Date(rev.createdAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="knowledge-history__preview">
            {selected ? (
              <>
                <div className="knowledge-history__actions">
                  <button
                    type="button"
                    className="knowledge-history__restore"
                    onClick={() => {
                      void appConfirm(
                        t("knowledge.history.confirmRestore"),
                        t("knowledge.history.title"),
                      ).then((ok) => {
                        if (!ok || !selected) return;
                        onRestore(selected.title, selected.content);
                        onClose();
                      });
                    }}
                  >
                    {t("knowledge.history.restore")}
                  </button>
                </div>
                <pre className="knowledge-history__diff">
                  {diff.map((line, index) => (
                    <div
                      key={`${line.type}-${index}`}
                      className={`knowledge-history__diff-line knowledge-history__diff-line--${line.type}`}
                    >
                      {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
                      {line.text}
                    </div>
                  ))}
                </pre>
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
