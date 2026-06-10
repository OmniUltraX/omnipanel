import type { KnowledgeEntry } from "../../ipc/bindings";
import { useI18n } from "../../i18n";

const KIND_ICONS: Record<string, string> = {
  snippet: "📄",
  case: "🔧",
  ai: "🤖",
};

function relativeTime(dateVal: number | string | null | undefined): string {
  if (dateVal == null) return "—";
  const then = typeof dateVal === "number" ? dateVal : new Date(dateVal).getTime();
  const now = Date.now();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  const months = Math.floor(days / 30);
  return `${months}个月前`;
}

interface KnowledgeCardProps {
  entry: KnowledgeEntry;
  selected: boolean;
  onClick: () => void;
  score?: number;
}

export function KnowledgeCard({ entry, selected, onClick, score }: KnowledgeCardProps) {
  const { t } = useI18n();

  return (
    <div
      className={`knowledge-card${selected ? " selected" : ""}`}
      onClick={onClick}
    >
      <div className="knowledge-card-header">
        <span className="knowledge-card-kind">{KIND_ICONS[entry.kind] ?? "📄"}</span>
        <span className="knowledge-card-title">{entry.title}</span>
        <span className={`knowledge-card-risk ${entry.riskLevel}`}>
          {t(`knowledge.risks.${entry.riskLevel}`) ?? entry.riskLevel}
        </span>
      </div>
      {entry.tags.length > 0 && (
        <div className="knowledge-card-tags">
          {entry.tags.map((tag) => (
            <span key={tag} className="knowledge-tag-pill">
              {tag}
            </span>
          ))}
        </div>
      )}
      {entry.source && (
        <div className="knowledge-card-source">{entry.source}</div>
      )}
      <div className="knowledge-card-meta">
        <span>{t("knowledge.meta.used", { count: entry.usageCount ?? 0 })}</span>
        <span>·</span>
        <span>{relativeTime(entry.updatedAt)}</span>
        {score != null && score > 0 && (
          <>
            <span>·</span>
            <span className="knowledge-card-score" title="相关性评分">
              ⚡ {score}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
