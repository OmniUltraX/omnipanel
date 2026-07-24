import {

  useEffect,

  useLayoutEffect,

  useRef,

  useState,

  type RefObject,

} from "react";

import { createPortal } from "react-dom";

import { useLocation, useNavigate } from "react-router-dom";

import { useWorkspaceStore, type WorkspaceInfo } from "../../stores/workspaceStore";

import { useWorkspaceBottomDockStore } from "../../stores/workspaceBottomDockStore";

import {
  goHomeUniversally,
  selectWorkspaceUniversally,
} from "../../lib/workspaceNavigation";

import { isDashboardPath } from "../../lib/paths";

import { appConfirm } from "../../lib/appConfirm";
import { cleanupWorkspaceDockTab } from "../../lib/workspaceTabActions";
import { requestWorkspaceDockWarmup } from "../../stores/workspaceDockWarmupStore";

import { useI18n } from "../../i18n";
import { TextInput } from "../ui/form/TextInput";



interface WorkspacePopoverProps {

  anchorRef: RefObject<HTMLElement | null>;

  onClose: () => void;

  /** above：锚点上方（状态栏）；below：锚点下方（模块 Tab 栏） */

  placement?: "above" | "below";

  /** 自定义选择工作区行为；未提供时默认进入工程工作区全屏 */

  onSelectWorkspace?: (ws: WorkspaceInfo) => void;

  /** 是否展示固定首页入口；嵌入式工程工作区只切换工程工作区，不展示首页 */

  showHomeOption?: boolean;

  /** 下拉列表中标记为当前选中的工作区 id；未提供时使用全局 store */

  activeWorkspaceId?: string;

}



function isPopoverNode(target: EventTarget | null): boolean {

  return Boolean(

    (target as Node | null) && (target as Element).closest?.(".workspace-popover"),

  );

}



export function WorkspacePopover({

  anchorRef,

  onClose,

  placement = "above",

  onSelectWorkspace,

  showHomeOption = true,

  activeWorkspaceId: activeWorkspaceIdProp,

}: WorkspacePopoverProps) {

  const { t } = useI18n();

  const navigate = useNavigate();

  const location = useLocation();

  const workspaces = useWorkspaceStore((state) => state.workspaces);

  const storeWorkspaceId = useWorkspaceStore((state) => state.workspace.id);

  const currentId = activeWorkspaceIdProp ?? storeWorkspaceId;

  const addWorkspace = useWorkspaceStore((state) => state.addWorkspace);

  const renameWorkspace = useWorkspaceStore((state) => state.renameWorkspace);

  const removeWorkspace = useWorkspaceStore((state) => state.removeWorkspace);

  const removeWorkspaceData = useWorkspaceBottomDockStore(

    (state) => state.removeWorkspaceData,

  );



  const panelRef = useRef<HTMLDivElement>(null);

  const [coords, setCoords] = useState<{

    left: number;

    top?: number;

    bottom?: number;

  } | null>(null);

  const [ready, setReady] = useState(false);

  const [creating, setCreating] = useState(false);

  const creatingRef = useRef(creating);
  creatingRef.current = creating;

  const [draftName, setDraftName] = useState("");

  const [draftError, setDraftError] = useState<string | null>(null);

  const [renamingId, setRenamingId] = useState<string | null>(null);

  const renamingIdRef = useRef(renamingId);
  renamingIdRef.current = renamingId;

  // 持有最新函数引用，让空依赖 useEffect 中的事件处理器能调用最新版本
  const commitCreateRef = useRef(commitCreate);
  commitCreateRef.current = commitCreate;
  const commitRenameRef = useRef(commitRename);
  commitRenameRef.current = commitRename;
  const cancelRenameRef = useRef(cancelRename);
  cancelRenameRef.current = cancelRename;

  const [renameDraft, setRenameDraft] = useState("");

  const [renameError, setRenameError] = useState<string | null>(null);



  const canDelete = workspaces.length > 1;

  const isHomeActive = showHomeOption && isDashboardPath(location.pathname);



  useLayoutEffect(() => {

    setReady(false);

  }, [workspaces.length, currentId]);



  useLayoutEffect(() => {

    const anchor = anchorRef.current;

    const el = panelRef.current;

    if (!anchor || !el) return;

    const anchorRect = anchor.getBoundingClientRect();

    const { width, height } = el.getBoundingClientRect();

    const gap = 8;

    const margin = 8;

    const desiredLeft = anchorRect.right - width;

    const left = Math.max(margin, Math.min(desiredLeft, window.innerWidth - width - margin));

    const popoverHeight = height > 0 ? height : 280;

    const spaceBelow = window.innerHeight - anchorRect.bottom - gap;

    const spaceAbove = anchorRect.top - gap;

    let openBelow = placement === "below";

    if (openBelow && spaceBelow < popoverHeight && spaceAbove >= spaceBelow) {

      openBelow = false;

    } else if (!openBelow && spaceAbove < popoverHeight && spaceBelow > spaceAbove) {

      openBelow = true;

    }

    if (openBelow) {

      setCoords({ left, top: anchorRect.bottom + gap });

    } else {

      setCoords({ left, bottom: window.innerHeight - anchorRect.top + gap });

    }

    setReady(true);

  }, [anchorRef, workspaces.length, currentId, creating, renamingId, placement]);



  useEffect(() => {

    const handler = (e: MouseEvent | KeyboardEvent) => {

      if (e instanceof KeyboardEvent) {

        if (e.key === "Escape") {

          if (creatingRef.current) {

            setCreating(false);

            setDraftName("");

            setDraftError(null);

          } else if (renamingIdRef.current) {

            cancelRenameRef.current();

          } else {

            onClose();

          }

          return;

        }

        if (e.key === "Enter" && creatingRef.current) {

          commitCreateRef.current();

        }

        if (e.key === "Enter" && renamingIdRef.current) {

          commitRenameRef.current();

        }

        return;

      }

      if (isPopoverNode(e.target)) return;

      onClose();

    };

    document.addEventListener("mousedown", handler);

    document.addEventListener("keydown", handler);

    return () => {

      document.removeEventListener("mousedown", handler);

      document.removeEventListener("keydown", handler);

    };

  }, []);



  function commitCreate() {

    const trimmed = draftName.trim();

    if (!trimmed) {

      setDraftError(t("shell.workspacePopover.nameRequired"));

      return;

    }

    if (workspaces.some((w) => w.name === trimmed)) {

      setDraftError(t("shell.workspacePopover.nameDuplicate"));

      return;

    }

    const ws = addWorkspace(trimmed);

    if (onSelectWorkspace) {

      onSelectWorkspace(ws);

    } else {

      void selectWorkspaceUniversally(ws.id, navigate);

    }

    onClose();

  }



  function handleSelect(target: WorkspaceInfo) {
    // 点击瞬间确保目标工作区 shell 已在预热队列中
    requestWorkspaceDockWarmup(target.id);

    if (onSelectWorkspace) {

      onSelectWorkspace(target);

      onClose();

      return;

    }

    void selectWorkspaceUniversally(target.id, navigate);

    onClose();

  }



  function handleSelectHome() {

    void goHomeUniversally(navigate);

    onClose();

  }



  async function handleDelete(target: WorkspaceInfo, event: React.MouseEvent) {

    event.preventDefault();

    event.stopPropagation();

    if (!canDelete) return;

    if (

      !(await appConfirm(

        t("shell.workspacePopover.confirmDelete", { name: target.name }),

        t("shell.workspacePopover.delete"),

      ))

    ) {

      return;

    }

    // 1. 清理该工作区所有 tab 的后端资源（终端会话、数据库连接等）
    const dockTabs = useWorkspaceBottomDockStore.getState().tabsByWorkspace[target.id] ?? [];
    for (const tab of dockTabs) {
      cleanupWorkspaceDockTab(tab);
    }

    // 2. 先切换到其他工作区（避免 dock tabs 被清空后 UI 闪空白）
    if (!removeWorkspace(target.id)) return;

    // 3. 切换完成后再清理旧工作区的 dock 数据
    removeWorkspaceData(target.id);

  }



  function startCreating() {

    cancelRename();

    setCreating(true);

    setDraftName("");

    setDraftError(null);

  }



  function startRename(target: WorkspaceInfo, event: React.MouseEvent) {

    event.preventDefault();

    event.stopPropagation();

    setCreating(false);

    setDraftName("");

    setDraftError(null);

    setRenamingId(target.id);

    setRenameDraft(target.name);

    setRenameError(null);

  }



  function cancelRename() {

    setRenamingId(null);

    setRenameDraft("");

    setRenameError(null);

  }



  function commitRename() {

    if (!renamingId) return;

    const trimmed = renameDraft.trim();

    if (!trimmed) {

      setRenameError(t("shell.workspacePopover.nameRequired"));

      return;

    }

    if (workspaces.some((w) => w.id !== renamingId && w.name === trimmed)) {

      setRenameError(t("shell.workspacePopover.nameDuplicate"));

      return;

    }

    if (!renameWorkspace(renamingId, trimmed)) return;

    cancelRename();

  }



  return createPortal(

    <>

      <div className="workspace-popover-backdrop" aria-hidden onClick={onClose} />

      <div

        ref={panelRef}

        className="workspace-popover"

        style={{

          left: coords?.left ?? 0,

          ...(coords?.top != null ? { top: coords.top } : {}),

          ...(coords?.bottom != null ? { bottom: coords.bottom } : {}),

          visibility: ready ? "visible" : "hidden",

        }}

        role="dialog"

        aria-label={t("shell.workspacePopover.title")}

      >

        <div className="workspace-popover-header">{t("shell.workspacePopover.title")}</div>

        <ul className="workspace-popover-list" role="listbox">

          {showHomeOption ? (

            <li
              className={`workspace-popover-row${isHomeActive ? " workspace-popover-row--active" : ""}`}
            >

              <button

                type="button"

                className={`workspace-popover-item workspace-popover-item--home${isHomeActive ? " workspace-popover-item--active" : ""}`}

                onClick={handleSelectHome}

              >

                <span className="workspace-popover-item-name">

                  {t("shell.workspacePopover.home")}

                </span>

                <span className="workspace-popover-item-desc">

                  {t("shell.workspacePopover.homeDesc")}

                </span>

                {isHomeActive && (

                  <svg

                    className="workspace-popover-item-check"

                    viewBox="0 0 24 24"

                    fill="none"

                    stroke="currentColor"

                    strokeWidth="2.5"

                    width="12"

                    height="12"

                    aria-hidden

                  >

                    <polyline points="20 6 9 17 4 12" />

                  </svg>

                )}

              </button>

            </li>

          ) : null}

          {workspaces.map((ws) => {

            const active = !isHomeActive && ws.id === currentId;

            const deleteLabel = t("shell.workspacePopover.delete");

            const renameLabel = t("shell.workspacePopover.rename");

            const isRenaming = renamingId === ws.id;

            return (

              <li

                key={ws.id}

                className={`workspace-popover-row${isRenaming ? " workspace-popover-row--editing" : ""}${active ? " workspace-popover-row--active" : ""}`}

              >

                {isRenaming ? (

                  <div className="workspace-popover-inline-edit">

                    <TextInput

                      autoFocus

                      copyable={false}

                      className="workspace-popover-input"

                      placeholder={t("shell.workspacePopover.namePlaceholder")}

                      value={renameDraft}

                      onChange={(value) => {

                        setRenameDraft(value);

                        if (renameError) setRenameError(null);

                      }}

                      onKeyDown={(e) => {

                        if (e.key === "Enter") commitRename();

                        if (e.key === "Escape") cancelRename();

                      }}

                    />

                    <button

                      type="button"

                      className="workspace-popover-confirm"

                      onClick={commitRename}

                      aria-label={t("shell.workspacePopover.confirmRename")}

                    >

                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="12" height="12" aria-hidden>

                        <polyline points="20 6 9 17 4 12" />

                      </svg>

                    </button>

                    <button

                      type="button"

                      className="workspace-popover-cancel"

                      onClick={cancelRename}

                      aria-label={t("shell.workspacePopover.cancel")}

                    >

                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" aria-hidden>

                        <line x1="18" y1="6" x2="6" y2="18" />

                        <line x1="6" y1="6" x2="18" y2="18" />

                      </svg>

                    </button>

                  </div>

                ) : (

                  <>

                    <button

                      type="button"

                      className={`workspace-popover-item${active ? " workspace-popover-item--active" : ""}`}

                      onPointerEnter={() => requestWorkspaceDockWarmup(ws.id)}

                      onPointerDown={() => requestWorkspaceDockWarmup(ws.id)}

                      onClick={() => handleSelect(ws)}

                    >

                      <span className="workspace-popover-item-name">{ws.name}</span>

                      {ws.description && (

                        <span className="workspace-popover-item-desc">{ws.description}</span>

                      )}

                      {active && (

                        <svg

                          className="workspace-popover-item-check"

                          viewBox="0 0 24 24"

                          fill="none"

                          stroke="currentColor"

                          strokeWidth="2.5"

                          width="12"

                          height="12"

                          aria-hidden

                        >

                          <polyline points="20 6 9 17 4 12" />

                        </svg>

                      )}

                    </button>

                    <button

                      type="button"

                      className="workspace-popover-rename"

                      title={renameLabel}

                      aria-label={renameLabel}

                      onClick={(event) => startRename(ws, event)}

                    >

                      <svg

                        viewBox="0 0 24 24"

                        fill="none"

                        stroke="currentColor"

                        strokeWidth="2"

                        width="12"

                        height="12"

                        aria-hidden

                      >

                        <path d="M12 20h9" />

                        <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z" />

                      </svg>

                    </button>

                    {canDelete ? (

                      <button

                        type="button"

                        className="workspace-popover-delete"

                        title={deleteLabel}

                        aria-label={deleteLabel}

                        onClick={(event) => void handleDelete(ws, event)}

                      >

                        <svg

                          viewBox="0 0 24 24"

                          fill="none"

                          stroke="currentColor"

                          strokeWidth="2"

                          width="12"

                          height="12"

                          aria-hidden

                        >

                          <polyline points="3 6 5 6 21 6" />

                          <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />

                          <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />

                          <line x1="10" y1="11" x2="10" y2="17" />

                          <line x1="14" y1="11" x2="14" y2="17" />

                        </svg>

                      </button>

                    ) : null}

                  </>

                )}

                {isRenaming && renameError ? (

                  <div className="workspace-popover-error workspace-popover-error--inline">

                    {renameError}

                  </div>

                ) : null}

              </li>

            );

          })}

        </ul>

        <div className="workspace-popover-footer">

          {creating ? (

            <div className="workspace-popover-create">

              <TextInput

                autoFocus

                copyable={false}

                className="workspace-popover-input"

                placeholder={t("shell.workspacePopover.namePlaceholder")}

                value={draftName}

                onChange={(value) => {

                  setDraftName(value);

                  if (draftError) setDraftError(null);

                }}

                onKeyDown={(e) => {

                  if (e.key === "Enter") commitCreate();

                  if (e.key === "Escape") {

                    setCreating(false);

                    setDraftName("");

                    setDraftError(null);

                  }

                }}

              />

              <button

                type="button"

                className="workspace-popover-confirm"

                onClick={commitCreate}

                aria-label={t("shell.workspacePopover.create")}

              >

                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="12" height="12" aria-hidden>

                  <polyline points="20 6 9 17 4 12" />

                </svg>

              </button>

              <button

                type="button"

                className="workspace-popover-cancel"

                onClick={() => {

                  setCreating(false);

                  setDraftName("");

                  setDraftError(null);

                }}

                aria-label={t("shell.workspacePopover.cancel")}

              >

                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" aria-hidden>

                  <line x1="18" y1="6" x2="6" y2="18" />

                  <line x1="6" y1="6" x2="18" y2="18" />

                </svg>

              </button>

            </div>

          ) : (

            <button

              type="button"

              className="workspace-popover-new"

              onClick={startCreating}

            >

              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11" aria-hidden>

                <line x1="12" y1="5" x2="12" y2="19" />

                <line x1="5" y1="12" x2="19" y2="12" />

              </svg>

              {t("shell.workspacePopover.newWorkspace")}

            </button>

          )}

          {draftError && <div className="workspace-popover-error">{draftError}</div>}

        </div>

      </div>

    </>,

    document.body,

  );

}

