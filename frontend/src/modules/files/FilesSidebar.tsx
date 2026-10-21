import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { ModuleSidebarSection, SidebarRefreshIcon, SidebarStatusDot } from "../../components/ui/module-sidebar";
import { type TreeRowMouseEvent } from "../../components/ui/sidebar-tree/useTreeClickDelay";
import { SidebarTreeEmpty, SidebarTreeNode } from "../../components/ui/sidebar-tree";
import "../../components/ui/sidebar-tree/sidebar-tree.css";
import {
  usePersistedVerticalSplitSections,
  usePersistedVerticalSplitSizes,
  VerticalSplitSidebar,
} from "../../components/ui/sidebar/VerticalSplitSidebar";
import { useI18n } from "../../i18n";
import { SidebarNoteKeys, useSidebarNote } from "../../lib/sidebarNotes";
import type { FileManagerConnectionInfo } from "../../ipc/bindings";
import type { FileFavorite } from "../../stores/filesFavoritesStore";
import type { FileProtocol } from "./FileConnectionDialog";
import {
  ConnProtocolIcon,
  IconQuickDesktop,
  IconQuickDocuments,
  IconQuickDownloads,
  IconQuickHome,
} from "./FilesPanelIcons";
import { LOCAL_CONNECTION_ID } from "./utils";

const SECTION_STORAGE_KEY = "omnipanel-files-sidebar-sections-v6";
const SIZE_STORAGE_KEY = "omnipanel-files-sidebar-sizes-v2";

const SECTION_MIN_BODY = 56;
const SECTION_MAX_BODY = 420;
const SECTION_DEFAULT_BODY = 120;

type SectionKey = "connections" | "quickPaths" | "favorites" | "globalFavorites";
type SizedSectionKey = "quickPaths" | "favorites" | "globalFavorites";

function sortConnections(items: FileManagerConnectionInfo[]): FileManagerConnectionInfo[] {
  return [...items].sort((a, b) => {
    if (a.id === LOCAL_CONNECTION_ID) return -1;
    if (b.id === LOCAL_CONNECTION_ID) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function clampBodyHeight(value: number): number {
  return Math.max(SECTION_MIN_BODY, Math.min(SECTION_MAX_BODY, Math.round(value)));
}

/** 与 SchemaBrowser / sidebar-tree 图钉路径一致 */
function PinIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12" aria-hidden>
      <path d="M9.5 1.5 8 3 6.5 1.5 5 3v4.6L2.8 9.8l-.3.3v1.4l.3.3L5 12.9V14l1.5-1.5L8 14l1.5-1.5L11 14v-1.1l2.2-2.2.3-.3v-1.4l-.3-.3L11 7.6V3L9.5 1.5Z" />
    </svg>
  );
}

function ConnectionRow({
  conn,
  active,
  inTab,
  selected,
  onPreview,
  onPin,
  onContextMenu,
  onSelect,
}: {
  conn: FileManagerConnectionInfo;
  active: boolean;
  inTab: boolean;
  selected: boolean;
  onPreview: (conn: FileManagerConnectionInfo) => void;
  onPin: (conn: FileManagerConnectionInfo) => void;
  onContextMenu: (e: MouseEvent, conn: FileManagerConnectionInfo) => void;
  onSelect: (conn: FileManagerConnectionInfo, e: TreeRowMouseEvent) => void;
}) {
  const { t } = useI18n();
  const online = conn.status === "online";
  const note = useSidebarNote(SidebarNoteKeys.filesConnection(conn.id));

  return (
    <SidebarTreeNode
      module="files"
      nodeType="connection"
      depth={0}
      treeKey={conn.id}
      expanded={false}
      hasChildren={false}
      active={active}
      selected={selected}
      className={inTab && !active ? "tree-node--in-tab" : ""}
      icon={<ConnProtocolIcon protocol={conn.protocol} />}
      prefix={
        <SidebarStatusDot
          status={online ? "online" : "idle"}
          title={online ? t("common.statusOnline") : t("common.statusIdle")}
        />
      }
      label={conn.name}
      note={note ?? undefined}
      onToggle={() => {}}
      onSelect={(event) => {
        onSelect(conn, event);
        if (event.ctrlKey || event.metaKey || event.shiftKey) return;
        onPreview(conn);
      }}
      onActivate={() => onPin(conn)}
      onContextMenu={(event) => {
        if (!selected) onSelect(conn, event);
        onContextMenu(event, conn);
      }}
    />
  );
}

type SidebarDotStatus = "online" | "idle";

function connectionDotStatus(conn?: FileManagerConnectionInfo): SidebarDotStatus {
  if (!conn) return "idle";
  return conn.status === "online" ? "online" : "idle";
}

function FavoriteRow({
  favorite,
  protocol,
  dotStatus,
  dotTitle,
  displayLabel,
  showPin,
  pinTitle,
  unpinTitle,
  selected,
  onOpen,
  onContextMenu,
  onTogglePin,
  onSelect,
}: {
  favorite: FileFavorite;
  protocol?: string;
  dotStatus?: SidebarDotStatus;
  dotTitle?: string;
  displayLabel?: string;
  showPin?: boolean;
  pinTitle?: string;
  unpinTitle?: string;
  selected: boolean;
  onOpen: (favorite: FileFavorite, mode: "preview" | "permanent") => void;
  onContextMenu: (e: MouseEvent, favorite: FileFavorite) => void;
  onTogglePin?: (favorite: FileFavorite) => void;
  onSelect: (favorite: FileFavorite, e: TreeRowMouseEvent) => void;
}) {
  const pinned = favorite.pinned === true;

  return (
    <SidebarTreeNode
      module="files"
      nodeType="favorite"
      depth={0}
      treeKey={favorite.id}
      expanded={false}
      hasChildren={false}
      selected={selected}
      className={pinned ? "fm-favorite-item--pinned" : ""}
      icon={
        protocol ? (
          <ConnProtocolIcon protocol={protocol} />
        ) : (
          <span className="conn-icon conn-icon--missing" aria-hidden />
        )
      }
      prefix={<SidebarStatusDot status={dotStatus ?? "idle"} title={dotTitle} />}
      label={
        <span className="tree-label-name" title={favorite.path || "/"}>
          {displayLabel ?? favorite.label}
        </span>
      }
      trailing={
        showPin && onTogglePin ? (
          <div className="tree-node-actions">
            <button
              type="button"
              className={`tree-action-btn tree-action-btn--pin${pinned ? " tree-action-btn--active" : ""}`}
              title={pinned ? unpinTitle : pinTitle}
              aria-label={pinned ? unpinTitle : pinTitle}
              aria-pressed={pinned}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onTogglePin(favorite);
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <PinIcon />
            </button>
          </div>
        ) : null
      }
      onToggle={() => {}}
      onSelect={(event) => {
        onSelect(favorite, event);
        if (event.ctrlKey || event.metaKey || event.shiftKey) return;
        onOpen(favorite, "preview");
      }}
      onActivate={() => onOpen(favorite, "permanent")}
      onContextMenu={(event) => {
        if (!selected) onSelect(favorite, event);
        onContextMenu(event, favorite);
      }}
    />
  );
}

export interface FilesSidebarProps {
  connections: FileManagerConnectionInfo[];
  activeId: string;
  openConnIds: string[];
  quickPaths: { home: string; desktop: string; documents: string; downloads: string } | null;
  favorites: FileFavorite[];
  syncingSshSftp?: boolean;
  onPreviewConnection: (conn: FileManagerConnectionInfo) => void;
  onPinConnection: (conn: FileManagerConnectionInfo) => void;
  onConnContextMenu: (e: MouseEvent, conn: FileManagerConnectionInfo) => void;
  onAddConnection: (protocol?: FileProtocol) => void;
  onSyncSshSftp?: () => void;
  onQuickNavigate: (path: string) => void;
  onFavoriteOpen: (favorite: FileFavorite, mode: "preview" | "permanent") => void;
  onFavoriteContextMenu: (e: MouseEvent, favorite: FileFavorite) => void;
  onToggleFavoritePin: (favorite: FileFavorite) => void;
  onDeleteConnections?: (conns: FileManagerConnectionInfo[]) => void;
  onDeleteFavorites?: (favs: FileFavorite[]) => void;
}

export function FilesSidebar({
  connections,
  activeId,
  openConnIds,
  quickPaths,
  favorites,
  syncingSshSftp = false,
  onPreviewConnection,
  onPinConnection,
  onConnContextMenu,
  onAddConnection,
  onSyncSshSftp,
  onQuickNavigate,
  onFavoriteOpen,
  onFavoriteContextMenu,
  onToggleFavoritePin,
  onDeleteConnections,
  onDeleteFavorites,
}: FilesSidebarProps) {
  const { t } = useI18n();
  const { sections, toggleSection, setSectionExpanded } = usePersistedVerticalSplitSections<SectionKey>(
    SECTION_STORAGE_KEY,
    { connections: true, quickPaths: true, favorites: true, globalFavorites: true },
  );
  const { sizes, setSize, isUserSized } = usePersistedVerticalSplitSizes<SizedSectionKey>(SIZE_STORAGE_KEY);

  const quickMeasureRef = useRef<HTMLDivElement>(null);
  const favMeasureRef = useRef<HTMLDivElement>(null);
  const globalFavMeasureRef = useRef<HTMLDivElement>(null);

  const sortedConnections = useMemo(() => sortConnections(connections), [connections]);
  const openSet = useMemo(() => new Set(openConnIds), [openConnIds]);
  const connectionById = useMemo(() => {
    const map = new Map<string, FileManagerConnectionInfo>();
    for (const conn of connections) map.set(conn.id, conn);
    return map;
  }, [connections]);

  const isLocalActive = activeId === LOCAL_CONNECTION_ID;
  const dotTitleFor = (conn?: FileManagerConnectionInfo) => {
    const status = connectionDotStatus(conn);
    if (status === "online") return t("common.statusOnline");
    return t("common.statusIdle");
  };
  const normalFavorites = useMemo(
    () => favorites.filter((fav) => fav.connectionId === activeId),
    [activeId, favorites],
  );
  const globalFavorites = useMemo(
    () => favorites.filter((fav) => fav.pinned === true),
    [favorites],
  );

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const hoveredRef = useRef(false);

  const handleSelectConn = useCallback((conn: FileManagerConnectionInfo, e: TreeRowMouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(conn.id)) next.delete(conn.id);
        else next.add(conn.id);
        return next;
      });
    } else if (e.shiftKey && anchorId) {
      const ids = sortedConnections.map((c) => c.id);
      const startIdx = ids.indexOf(anchorId);
      const endIdx = ids.indexOf(conn.id);
      if (startIdx >= 0 && endIdx >= 0) {
        const from = Math.min(startIdx, endIdx);
        const to = Math.max(startIdx, endIdx);
        setSelectedIds(new Set(ids.slice(from, to + 1)));
      } else {
        setSelectedIds(new Set([conn.id]));
      }
    } else {
      setSelectedIds(new Set([conn.id]));
    }
    setAnchorId(conn.id);
  }, [anchorId, sortedConnections]);

  const handleSelectFav = useCallback((fav: FileFavorite, e: TreeRowMouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(fav.id)) next.delete(fav.id);
        else next.add(fav.id);
        return next;
      });
    } else if (e.shiftKey && anchorId) {
      const allFavs = [...normalFavorites, ...globalFavorites];
      const favIds = allFavs.map((f) => f.id);
      const startIdx = favIds.indexOf(anchorId);
      const endIdx = favIds.indexOf(fav.id);
      if (startIdx >= 0 && endIdx >= 0) {
        const from = Math.min(startIdx, endIdx);
        const to = Math.max(startIdx, endIdx);
        setSelectedIds(new Set(favIds.slice(from, to + 1)));
      } else {
        setSelectedIds(new Set([fav.id]));
      }
    } else {
      setSelectedIds(new Set([fav.id]));
    }
    setAnchorId(fav.id);
  }, [anchorId, globalFavorites, normalFavorites]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hoveredRef.current) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const connIds = sortedConnections.map((item) => item.id);
      const favIds = [...normalFavorites, ...globalFavorites].map((item) => item.id);
      const order = [...connIds, ...favIds];

      if (!mod && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End")) {
        if (order.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const current = anchorId != null ? order.indexOf(anchorId) : -1;
        const nextIndex = e.key === "Home"
          ? 0
          : e.key === "End"
            ? order.length - 1
            : e.key === "ArrowDown"
              ? Math.min(order.length - 1, current + 1)
              : Math.max(0, current < 0 ? 0 : current - 1);
        const nextId = order[nextIndex];
        if (!nextId) return;
        if (e.shiftKey && current >= 0) {
          const from = Math.min(current, nextIndex);
          const to = Math.max(current, nextIndex);
          setSelectedIds(new Set(order.slice(from, to + 1)));
        } else if (!e.shiftKey) {
          setSelectedIds(new Set([nextId]));
          setAnchorId(nextId);
        }
        return;
      }

      if (e.key === "Enter" && !mod && anchorId) {
        const conn = sortedConnections.find((item) => item.id === anchorId);
        if (conn) {
          e.preventDefault();
          e.stopPropagation();
          onPreviewConnection(conn);
          return;
        }
        const fav = favorites.find((item) => item.id === anchorId);
        if (fav) {
          e.preventDefault();
          e.stopPropagation();
          onFavoriteOpen(fav, "preview");
        }
        return;
      }

      if (mod && key === "a") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const allIds = new Set<string>();
        sortedConnections.forEach((item) => { if (item.id !== LOCAL_CONNECTION_ID) allIds.add(item.id); });
        favorites.forEach((item) => allIds.add(item.id));
        setSelectedIds(allIds);
        setAnchorId(null);
        return;
      }
      if (e.key === "Delete" && selectedIds.size > 0 && (onDeleteConnections || onDeleteFavorites)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const conns = sortedConnections.filter((item) => selectedIds.has(item.id));
        const favs = favorites.filter((item) => selectedIds.has(item.id));
        setSelectedIds(new Set());
        setAnchorId(null);
        if (conns.length > 0 && onDeleteConnections) onDeleteConnections(conns);
        if (favs.length > 0 && onDeleteFavorites) onDeleteFavorites(favs);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    anchorId,
    favorites,
    globalFavorites,
    normalFavorites,
    onDeleteConnections,
    onDeleteFavorites,
    onFavoriteOpen,
    onPreviewConnection,
    selectedIds,
    sortedConnections,
  ]);

  useEffect(() => {
    if (!activeId) return;
    setSectionExpanded("connections", true);
  }, [activeId, setSectionExpanded]);

  useLayoutEffect(() => {
    if (!sections.quickPaths || isUserSized("quickPaths")) return;
    const el = quickMeasureRef.current;
    if (!el) return;
    const next = clampBodyHeight(el.scrollHeight || SECTION_DEFAULT_BODY);
    if (sizes.quickPaths !== next) setSize("quickPaths", next);
  }, [isLocalActive, isUserSized, quickPaths, sections.quickPaths, setSize, sizes.quickPaths]);

  useLayoutEffect(() => {
    if (!sections.favorites || isUserSized("favorites")) return;
    const el = favMeasureRef.current;
    if (!el) return;
    const next = clampBodyHeight(el.scrollHeight || SECTION_DEFAULT_BODY);
    if (sizes.favorites !== next) setSize("favorites", next);
  }, [activeId, isUserSized, normalFavorites.length, sections.favorites, setSize, sizes.favorites]);

  useLayoutEffect(() => {
    if (!sections.globalFavorites || isUserSized("globalFavorites")) return;
    const el = globalFavMeasureRef.current;
    if (!el) return;
    const next = clampBodyHeight(el.scrollHeight || SECTION_DEFAULT_BODY);
    if (sizes.globalFavorites !== next) setSize("globalFavorites", next);
  }, [globalFavorites.length, isUserSized, sections.globalFavorites, setSize, sizes.globalFavorites]);

  const quickBodyHeight = sizes.quickPaths ?? SECTION_DEFAULT_BODY;
  const favBodyHeight = sizes.favorites ?? SECTION_DEFAULT_BODY;
  const globalFavBodyHeight = sizes.globalFavorites ?? SECTION_DEFAULT_BODY;

  const connectionActions = (
    <div className="schema-toolbar schema-toolbar--inline">
      {onSyncSshSftp ? (
        <WorkbenchActionButton
          icon
          className={syncingSshSftp ? "tree-action-btn--busy" : undefined}
          title={t("files.sidebar.syncSshSftp")}
          aria-label={t("files.sidebar.syncSshSftp")}
          disabled={syncingSshSftp}
          onClick={onSyncSshSftp}
        >
          <SidebarRefreshIcon />
        </WorkbenchActionButton>
      ) : null}
      <WorkbenchActionButton
        icon
        title={t("files.sidebar.add")}
        aria-label={t("files.sidebar.add")}
        onClick={() => onAddConnection()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </WorkbenchActionButton>
    </div>
  );

  return (
    <div
      className="fm-sidebar-wrapper"
      onMouseEnter={() => { hoveredRef.current = true; }}
      onMouseLeave={() => { hoveredRef.current = false; }}
    >
    <VerticalSplitSidebar className="fm-sidebar">
      <ModuleSidebarSection
        title={t("files.sidebar.connections")}
        expanded={sections.connections}
        onToggle={() => toggleSection("connections")}
        count={sortedConnections.length}
        actions={connectionActions}
      >
        {sortedConnections.length === 0 ? (
          <SidebarTreeEmpty>{t("files.sidebar.emptySection")}</SidebarTreeEmpty>
        ) : (
          <div className="fm-connections">
            {sortedConnections.map((conn) => (
              <ConnectionRow
                key={conn.id}
                conn={conn}
                active={conn.id === activeId}
                inTab={openSet.has(conn.id)}
                selected={selectedIds.has(conn.id)}
                onPreview={onPreviewConnection}
                onPin={onPinConnection}
                onContextMenu={onConnContextMenu}
                onSelect={handleSelectConn}
              />
            ))}
          </div>
        )}
      </ModuleSidebarSection>

      <ModuleSidebarSection
        title={t("files.sidebar.quickPaths")}
        count={isLocalActive && quickPaths ? 4 : 0}
        expanded={sections.quickPaths}
        onToggle={() => toggleSection("quickPaths")}
        bodyHeightPx={sections.quickPaths ? quickBodyHeight : undefined}
        onBodyHeightChange={
          sections.quickPaths
            ? (height) => setSize("quickPaths", clampBodyHeight(height), { user: true })
            : undefined
        }
        minBodyHeightPx={SECTION_MIN_BODY}
        maxBodyHeightPx={SECTION_MAX_BODY}
      >
        <div ref={quickMeasureRef} className="fm-section-measure">
          {isLocalActive ? (
            <div className="fm-quick-section">
              {quickPaths ? (
                [
                  { label: t("files.quick.home"), path: quickPaths.home, icon: <IconQuickHome /> },
                  { label: t("files.quick.desktop"), path: quickPaths.desktop, icon: <IconQuickDesktop /> },
                  { label: t("files.quick.documents"), path: quickPaths.documents, icon: <IconQuickDocuments /> },
                  { label: t("files.quick.downloads"), path: quickPaths.downloads, icon: <IconQuickDownloads /> },
                ].map((item) => (
                  <SidebarTreeNode
                    key={item.label}
                    module="files"
                    nodeType="quick-path"
                    depth={0}
                    expanded={false}
                    hasChildren={false}
                    icon={<span className="fm-quick-icon">{item.icon}</span>}
                    label={item.label}
                    onToggle={() => {}}
                    onSelect={() => onQuickNavigate(item.path)}
                  />
                ))
              ) : (
                <SidebarTreeEmpty>{t("files.sidebar.quickPathsLoading")}</SidebarTreeEmpty>
              )}
            </div>
          ) : (
            <SidebarTreeEmpty>{t("files.sidebar.quickPathsHint")}</SidebarTreeEmpty>
          )}
        </div>
      </ModuleSidebarSection>

      <ModuleSidebarSection
        title={t("files.sidebar.normalFavorites")}
        count={normalFavorites.length}
        expanded={sections.favorites}
        onToggle={() => toggleSection("favorites")}
        bodyHeightPx={sections.favorites ? favBodyHeight : undefined}
        onBodyHeightChange={
          sections.favorites
            ? (height) => setSize("favorites", clampBodyHeight(height), { user: true })
            : undefined
        }
        minBodyHeightPx={SECTION_MIN_BODY}
        maxBodyHeightPx={SECTION_MAX_BODY}
      >
        <div ref={favMeasureRef} className="fm-section-measure">
          {normalFavorites.length === 0 ? (
            <SidebarTreeEmpty>{t("files.sidebar.normalFavoritesEmpty")}</SidebarTreeEmpty>
          ) : (
            <div className="fm-quick-section">
              {normalFavorites.map((fav) => {
                const conn = connectionById.get(fav.connectionId);
                return (
                  <FavoriteRow
                    key={fav.id}
                    favorite={fav}
                    protocol={conn?.protocol}
                    dotStatus={connectionDotStatus(conn)}
                    dotTitle={dotTitleFor(conn)}
                    showPin
                    pinTitle={t("files.sidebar.pinFavorite")}
                    unpinTitle={t("files.sidebar.unpinFavorite")}
                    selected={selectedIds.has(fav.id)}
                    onOpen={onFavoriteOpen}
                    onContextMenu={onFavoriteContextMenu}
                    onTogglePin={onToggleFavoritePin}
                    onSelect={handleSelectFav}
                  />
                );
              })}
            </div>
          )}
        </div>
      </ModuleSidebarSection>

      <ModuleSidebarSection
        title={t("files.sidebar.globalFavorites")}
        count={globalFavorites.length}
        expanded={sections.globalFavorites}
        onToggle={() => toggleSection("globalFavorites")}
        bodyHeightPx={sections.globalFavorites ? globalFavBodyHeight : undefined}
        onBodyHeightChange={
          sections.globalFavorites
            ? (height) => setSize("globalFavorites", clampBodyHeight(height), { user: true })
            : undefined
        }
        minBodyHeightPx={SECTION_MIN_BODY}
        maxBodyHeightPx={SECTION_MAX_BODY}
      >
        <div ref={globalFavMeasureRef} className="fm-section-measure">
          {globalFavorites.length === 0 ? (
            <SidebarTreeEmpty>{t("files.sidebar.globalFavoritesEmpty")}</SidebarTreeEmpty>
          ) : (
            <div className="fm-quick-section">
              {globalFavorites.map((fav) => {
                const conn = connectionById.get(fav.connectionId);
                const displayLabel = conn ? `${conn.name} · ${fav.label}` : fav.label;
                return (
                  <FavoriteRow
                    key={fav.id}
                    favorite={fav}
                    protocol={conn?.protocol}
                    dotStatus={connectionDotStatus(conn)}
                    dotTitle={dotTitleFor(conn)}
                    displayLabel={displayLabel}
                    showPin
                    pinTitle={t("files.sidebar.pinFavorite")}
                    unpinTitle={t("files.sidebar.unpinFavorite")}
                    selected={selectedIds.has(fav.id)}
                    onOpen={onFavoriteOpen}
                    onContextMenu={onFavoriteContextMenu}
                    onTogglePin={onToggleFavoritePin}
                    onSelect={handleSelectFav}
                  />
                );
              })}
            </div>
          )}
        </div>
      </ModuleSidebarSection>
    </VerticalSplitSidebar>
    </div>
  );
}
