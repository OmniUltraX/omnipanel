import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type MouseEvent,
} from "react";
import { Button } from "../../components/ui/Button";
import {
  useTreeClickDelay,
  type TreeRowMouseEvent,
} from "../../components/ui/sidebar-tree/useTreeClickDelay";
import "../../components/ui/sidebar-tree/sidebar-tree.css";
import {
  usePersistedVerticalSplitSections,
  usePersistedVerticalSplitSizes,
  VerticalSplitSidebar,
  VerticalSplitSidebarSection,
} from "../../components/ui/VerticalSplitSidebar";
import { useI18n } from "../../i18n";
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
  onPreview,
  onPin,
  onContextMenu,
}: {
  conn: FileManagerConnectionInfo;
  active: boolean;
  inTab: boolean;
  onPreview: (conn: FileManagerConnectionInfo) => void;
  onPin: (conn: FileManagerConnectionInfo) => void;
  onContextMenu: (e: MouseEvent, conn: FileManagerConnectionInfo) => void;
}) {
  const { onRowClick, onRowDoubleClick } = useTreeClickDelay({
    onClick: () => onPreview(conn),
    onDoubleClick: () => onPin(conn),
  });

  return (
    <div
      className={`fm-sidebar-row fm-conn-item${active ? " active" : ""}${inTab && !active ? " fm-conn-item--in-tab" : ""}`}
      onClick={(e) => onRowClick(e as TreeRowMouseEvent)}
      onDoubleClick={(e) => onRowDoubleClick(e as TreeRowMouseEvent)}
      onContextMenu={(e) => onContextMenu(e, conn)}
    >
      <ConnProtocolIcon protocol={conn.protocol} />
      <span className="conn-name">{conn.name}</span>
      <span className={`conn-status ${conn.status === "online" ? "online" : "offline"}`} />
    </div>
  );
}

function FavoriteRow({
  favorite,
  protocol,
  displayLabel,
  showPin,
  pinTitle,
  unpinTitle,
  onOpen,
  onContextMenu,
  onTogglePin,
}: {
  favorite: FileFavorite;
  protocol?: string;
  displayLabel?: string;
  showPin?: boolean;
  pinTitle?: string;
  unpinTitle?: string;
  onOpen: (favorite: FileFavorite, mode: "preview" | "permanent") => void;
  onContextMenu: (e: MouseEvent, favorite: FileFavorite) => void;
  onTogglePin?: (favorite: FileFavorite) => void;
}) {
  const pinned = favorite.pinned === true;
  const { onRowClick, onRowDoubleClick } = useTreeClickDelay({
    onClick: () => onOpen(favorite, "preview"),
    onDoubleClick: () => onOpen(favorite, "permanent"),
  });

  return (
    <div
      className={`fm-sidebar-row fm-quick-item fm-favorite-item${pinned ? " fm-favorite-item--pinned" : ""}`}
      title={favorite.path || "/"}
      onClick={(e) => onRowClick(e as TreeRowMouseEvent)}
      onDoubleClick={(e) => onRowDoubleClick(e as TreeRowMouseEvent)}
      onContextMenu={(e) => onContextMenu(e, favorite)}
    >
      {protocol ? (
        <ConnProtocolIcon protocol={protocol} />
      ) : (
        <span className="conn-icon conn-icon--missing" aria-hidden />
      )}
      <span className="fm-favorite-label">{displayLabel ?? favorite.label}</span>
      {showPin && onTogglePin ? (
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
      ) : null}
    </div>
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
  const normalFavorites = useMemo(
    () => favorites.filter((fav) => fav.connectionId === activeId),
    [activeId, favorites],
  );
  const globalFavorites = useMemo(
    () => favorites.filter((fav) => fav.pinned === true),
    [favorites],
  );

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
        <Button
          type="button"
          variant="icon"
          className={syncingSshSftp ? "tree-action-btn--busy" : undefined}
          title={t("files.sidebar.syncSshSftp")}
          disabled={syncingSshSftp}
          onClick={onSyncSshSftp}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M2 8a6 6 0 0 1 10.5-3.9" />
            <path d="M14 2v3h-3" />
            <path d="M14 8a6 6 0 0 1-10.5 3.9" />
            <path d="M2 14v-3h3" />
          </svg>
        </Button>
      ) : null}
      <Button
        type="button"
        variant="icon"
        title={t("files.sidebar.add")}
        onClick={() => onAddConnection()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </Button>
    </div>
  );

  return (
    <VerticalSplitSidebar className="fm-sidebar">
      <VerticalSplitSidebarSection
        title={t("files.sidebar.connections")}
        expanded={sections.connections}
        onToggle={() => toggleSection("connections")}
        actions={connectionActions}
      >
        {sortedConnections.length === 0 ? (
          <p className="fm-conn-empty">{t("files.sidebar.emptySection")}</p>
        ) : (
          <div className="fm-connections">
            {sortedConnections.map((conn) => (
              <ConnectionRow
                key={conn.id}
                conn={conn}
                active={conn.id === activeId}
                inTab={openSet.has(conn.id)}
                onPreview={onPreviewConnection}
                onPin={onPinConnection}
                onContextMenu={onConnContextMenu}
              />
            ))}
          </div>
        )}
      </VerticalSplitSidebarSection>

      <VerticalSplitSidebarSection
        title={t("files.sidebar.quickPaths")}
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
                  <div
                    key={item.label}
                    className="fm-sidebar-row fm-quick-item"
                    onClick={() => onQuickNavigate(item.path)}
                  >
                    <span className="fm-quick-icon" aria-hidden>
                      {item.icon}
                    </span>
                    <span className="fm-favorite-label">{item.label}</span>
                  </div>
                ))
              ) : (
                <p className="fm-quick-section-hint">{t("files.sidebar.quickPathsLoading")}</p>
              )}
            </div>
          ) : (
            <p className="fm-quick-section-hint">{t("files.sidebar.quickPathsHint")}</p>
          )}
        </div>
      </VerticalSplitSidebarSection>

      <VerticalSplitSidebarSection
        title={t("files.sidebar.normalFavorites")}
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
            <p className="fm-conn-empty">{t("files.sidebar.normalFavoritesEmpty")}</p>
          ) : (
            <div className="fm-quick-section">
              {normalFavorites.map((fav) => (
                <FavoriteRow
                  key={fav.id}
                  favorite={fav}
                  protocol={connectionById.get(fav.connectionId)?.protocol}
                  showPin
                  pinTitle={t("files.sidebar.pinFavorite")}
                  unpinTitle={t("files.sidebar.unpinFavorite")}
                  onOpen={onFavoriteOpen}
                  onContextMenu={onFavoriteContextMenu}
                  onTogglePin={onToggleFavoritePin}
                />
              ))}
            </div>
          )}
        </div>
      </VerticalSplitSidebarSection>

      <VerticalSplitSidebarSection
        title={t("files.sidebar.globalFavorites")}
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
            <p className="fm-conn-empty">{t("files.sidebar.globalFavoritesEmpty")}</p>
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
                    displayLabel={displayLabel}
                    showPin
                    pinTitle={t("files.sidebar.pinFavorite")}
                    unpinTitle={t("files.sidebar.unpinFavorite")}
                    onOpen={onFavoriteOpen}
                    onContextMenu={onFavoriteContextMenu}
                    onTogglePin={onToggleFavoritePin}
                  />
                );
              })}
            </div>
          )}
        </div>
      </VerticalSplitSidebarSection>
    </VerticalSplitSidebar>
  );
}
