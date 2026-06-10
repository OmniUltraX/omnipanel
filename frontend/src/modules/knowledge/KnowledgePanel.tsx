import { useEffect, useRef, useState } from "react";
import { useKnowledgeStore, type KnowledgeTab } from "../../stores/knowledgeStore";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import { SidebarWorkspace } from "../../components/ui/SidebarWorkspace";
import { KnowledgeCard } from "./KnowledgeCard";
import { KnowledgeDetail } from "./KnowledgeDetail";
import { CreateEntryDialog } from "./CreateEntryDialog";

const TAB_ICONS: Record<KnowledgeTab, string> = {
  all: "📚",
  snippet: "📄",
  case: "🔧",
  ai: "🤖",
};

export function KnowledgePanel() {
  const { t } = useI18n();
  const {
    entries, searchResults, allTags,
    activeTab, searchQuery, selectedTag, selectedEntryId,
    isLoading, error,
    loadEntries, loadTags, search,
    setActiveTab, setSearchQuery, setSelectedTag, setSelectedEntry, setEditingEntry, clearError,
  } = useKnowledgeStore();

  const [showCreate, setShowCreate] = useState(false);
  const searchInput = searchQuery;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 初始加载
  useEffect(() => {
    loadEntries();
    loadTags();
  }, []);

  // tab 切换时重新加载
  useEffect(() => {
    const kind = activeTab !== "all" ? activeTab : undefined;
    loadEntries(kind, selectedTag ?? undefined);
  }, [activeTab, selectedTag]);

  // 搜索防抖
  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (value.trim()) {
        search(value, activeTab !== "all" ? activeTab : undefined);
      }
    }, 300);
  };

  // 决定显示哪些条目
  const displayEntries = searchQuery.trim()
    ? searchResults.map((r) => r.entry)
    : entries;

  const sidebar = (
    <>
      <div className="knowledge-search">
        <svg className="knowledge-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          type="text"
          placeholder={t("knowledge.searchPlaceholder")}
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
        />
      </div>

      <div className="knowledge-categories">
        <div className="knowledge-section-title">{t("knowledge.categories")}</div>
        {(["all", "snippet", "case", "ai"] as KnowledgeTab[]).map((tab) => (
          <div
            key={tab}
            className={`knowledge-category-tab ${activeTab === tab ? "active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            <span className="knowledge-tab-icon">{TAB_ICONS[tab]}</span>
            <span>{t(`knowledge.nav.${tab}`)}</span>
          </div>
        ))}
      </div>

      <div className="knowledge-tags-section">
        <div className="knowledge-section-title">{t("knowledge.tags")}</div>
        <div className="knowledge-tag-cloud">
          {selectedTag && (
            <span
              className="knowledge-tag-pill active"
              onClick={() => setSelectedTag(null)}
            >
              ✕ {selectedTag}
            </span>
          )}
          {allTags.map((tag) => (
            <span
              key={tag}
              className={`knowledge-tag-pill ${selectedTag === tag ? "active" : ""}`}
              onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
            >
              {tag}
            </span>
          ))}
          {allTags.length === 0 && (
            <span className="text-muted text-sm">{t("knowledge.noTags")}</span>
          )}
        </div>
      </div>
    </>
  );

  return (
    <div className="knowledge-panel">
      <SidebarWorkspace
        sidebarSizePx={220}
        sidebarMinPx={200}
        sidebarMaxPx={360}
        sidebar={sidebar}
      >
        <div className="knowledge-main-area">
          <div className="knowledge-list">
            <div className="knowledge-list-header">
              <span className="knowledge-list-count">
                {isLoading ? "…" : `${displayEntries.length} ${t("knowledge.entries")}`}
              </span>
              <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
                + {t("knowledge.create")}
              </Button>
            </div>

            {error && (
              <div className="knowledge-error">
                <span>{error}</span>
                <button onClick={clearError}>×</button>
              </div>
            )}

            <div className="knowledge-list-body">
              {searchQuery.trim()
                ? searchResults.map((result) => (
                    <KnowledgeCard
                      key={result.entry.id}
                      entry={result.entry}
                      selected={result.entry.id === selectedEntryId}
                      onClick={() => {
                        setSelectedEntry(result.entry.id);
                        setEditingEntry(null);
                      }}
                      score={result.score ?? undefined}
                    />
                  ))
                : displayEntries.map((entry) => (
                    <KnowledgeCard
                      key={entry.id}
                      entry={entry}
                      selected={entry.id === selectedEntryId}
                      onClick={() => {
                        setSelectedEntry(entry.id);
                        setEditingEntry(null);
                      }}
                    />
                  ))}

              {!isLoading && displayEntries.length === 0 && (
                <div className="knowledge-empty">
                  <div className="knowledge-empty-icon">📚</div>
                  <div className="knowledge-empty-title">
                    {searchQuery.trim() ? t("knowledge.noResults") : t("knowledge.noEntries")}
                  </div>
                  {!searchQuery.trim() && (
                    <div className="knowledge-empty-desc">{t("knowledge.createFirst")}</div>
                  )}
                </div>
              )}

              {isLoading && (
                <div className="knowledge-loading">
                  <div className="knowledge-loading-spinner" />
                </div>
              )}
            </div>
          </div>

          <div className="knowledge-detail">
            {selectedEntryId ? (
              <KnowledgeDetail />
            ) : (
              <div className="knowledge-detail-empty">
                <div className="knowledge-detail-empty-icon">📝</div>
                <div className="text-muted">{t("knowledge.selectEntry")}</div>
              </div>
            )}
          </div>
        </div>
      </SidebarWorkspace>

      <CreateEntryDialog open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  );
}
