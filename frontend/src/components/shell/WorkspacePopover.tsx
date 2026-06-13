import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useWorkspaceStore, type WorkspaceInfo } from "../../stores/workspaceStore";
import { useBottomPanelStore } from "../../stores/bottomPanelStore";

interface WorkspacePopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

function isPopoverNode(target: EventTarget | null): boolean {
  return Boolean(
    (target as Node | null) && (target as Element).closest?.(".workspace-popover"),
  );
}

export function WorkspacePopover({ anchorRef, onClose }: WorkspacePopoverProps) {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const currentId = useWorkspaceStore((state) => state.workspace.id);
  const switchWorkspace = useWorkspaceStore((state) => state.switchWorkspace);
  const addWorkspace = useWorkspaceStore((state) => state.addWorkspace);
  const requestExpand = useBottomPanelStore((state) => state.requestExpand);

  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ left: number; bottom: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
    const bottom = window.innerHeight - anchorRect.top + gap;
    setCoords({ left, bottom });
    setReady(true);
  }, [anchorRef, workspaces.length, currentId, creating]);

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
      setDraftError("名称不能为空");
      return;
    }
    if (workspaces.some((w) => w.name === trimmed)) {
      setDraftError("已存在同名工作区");
      return;
    }
    addWorkspace(trimmed);
    requestExpand();
    onClose();
  }

  function handleSelect(target: WorkspaceInfo) {
    if (target.id === currentId) {
      requestExpand();
      onClose();
      return;
    }
    switchWorkspace(target.id);
    requestExpand();
    onClose();
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
          bottom: coords?.bottom ?? 0,
          visibility: ready ? "visible" : "hidden",
        }}
        role="dialog"
        aria-label="工作区"
      >
        <div className="workspace-popover-header">工作区</div>
        <ul className="workspace-popover-list" role="listbox">
          {workspaces.map((ws) => {
            const active = ws.id === currentId;
            return (
              <li key={ws.id}>
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
                placeholder="新工作区名称"
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
                aria-label="创建"
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
                aria-label="取消"
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
              新建工作区
            </button>
          )}
          {draftError && <div className="workspace-popover-error">{draftError}</div>}
        </div>
      </div>
    </>,
    document.body,
  );
}
