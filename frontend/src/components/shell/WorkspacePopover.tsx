import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useWorkspaceStore, type WorkspaceInfo } from "../../stores/workspaceStore";
import { useWorkspaceBottomDockStore } from "../../stores/workspaceBottomDockStore";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";
import { goWorkspaceHome } from "../../lib/workspaceNavigation";
import { useI18n } from "../../i18n";

interface WorkspacePopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** above：锚点上方（状态栏）；below：锚点下方（模块 Tab 栏） */
  placement?: "above" | "below";
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
}: WorkspacePopoverProps) {
  const { t } = useI18n();
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const currentId = useWorkspaceStore((state) => state.workspace.id);
  const switchWorkspace = useWorkspaceStore((state) => state.switchWorkspace);
  const addWorkspace = useWorkspaceStore((state) => state.addWorkspace);
  const removeWorkspace = useWorkspaceStore((state) => state.removeWorkspace);
  const removeWorkspaceData = useWorkspaceBottomDockStore(
    (state) => state.removeWorkspaceData,
  );
  const requestExpand = useBottomPanelStore((state) => state.requestExpand);
  const exitHomeToWorkspace = useBottomPanelStore((state) => state.exitHomeToWorkspace);
  const isHomeActive = useBottomPanelStore((state) => state.isHomeActive);

  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{
    left: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const [ready, setReady] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const canDelete = workspaces.length > 1;

  useLayoutEffect(() => {
    setReady(false);
  }, [workspaces.length, currentId]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const el = panelRef.current;
    if (!anchor || !el) return;
    const anchorRect = anchor.getBoundingClientRect();
    const { width } = el.getBoundingClientRect();
    const gap = 8;
    const margin = 8;
    const desiredLeft = anchorRect.right - width;
    const left = Math.max(margin, Math.min(desiredLeft, window.innerWidth - width - margin));
    if (placement === "below") {
      setCoords({ left, top: anchorRect.bottom + gap });
    } else {
      setCoords({ left, bottom: window.innerHeight - anchorRect.top + gap });
    }
    setReady(true);
  }, [anchorRef, workspaces.length, currentId, creating, placement]);

  useEffect(() => {
    if (creating) {
      inputRef.current?.focus();
    }
  }, [creating]);

  useEffect(() => {
    const handler = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") {
          if (creating) {
            setCreating(false);
            setDraftName("");
            setDraftError(null);
          } else {
            onClose();
          }
          return;
        }
        if (e.key === "Enter" && creating) {
          commitCreate();
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
  });

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
    if (isHomeActive) {
      exitHomeToWorkspace();
    } else {
      requestExpand();
    }
    addWorkspace(trimmed);
    onClose();
  }

  function handleSelectHome() {
    goWorkspaceHome();
    onClose();
  }

  function handleSelect(target: WorkspaceInfo) {
    const sameWorkspace = target.id === currentId;
    if (sameWorkspace && !isHomeActive) {
      requestExpand();
      onClose();
      return;
    }
    if (isHomeActive) {
      exitHomeToWorkspace();
    }
    if (!sameWorkspace) {
      switchWorkspace(target.id);
    }
    requestExpand();
    onClose();
  }

  function handleDelete(target: WorkspaceInfo, event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!canDelete) return;
    removeWorkspaceData(target.id);
    if (!removeWorkspace(target.id)) return;
    requestExpand();
  }

  function startCreating() {
    setCreating(true);
    setDraftName("");
    setDraftError(null);
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
          <li className="workspace-popover-row">
            <button
              type="button"
              className={`workspace-popover-item workspace-popover-item--home${isHomeActive ? " workspace-popover-item--active" : ""}`}
              onClick={handleSelectHome}
            >
              <span className="workspace-popover-item-name">{t("shell.workspace.home")}</span>
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
          {workspaces.map((ws) => {
            const active = ws.id === currentId && !isHomeActive;
            const deleteLabel = t("shell.workspacePopover.delete");
            return (
              <li key={ws.id} className="workspace-popover-row">
                <button
                  type="button"
                  className={`workspace-popover-item${active ? " workspace-popover-item--active" : ""}`}
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
                {canDelete ? (
                  <button
                    type="button"
                    className="workspace-popover-delete"
                    title={deleteLabel}
                    aria-label={deleteLabel}
                    onClick={(event) => handleDelete(ws, event)}
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
              </li>
            );
          })}
        </ul>
        <div className="workspace-popover-footer">
          {creating ? (
            <div className="workspace-popover-create">
              <input
                ref={inputRef}
                type="text"
                className="workspace-popover-input"
                placeholder={t("shell.workspacePopover.namePlaceholder")}
                value={draftName}
                onChange={(e) => {
                  setDraftName(e.target.value);
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
