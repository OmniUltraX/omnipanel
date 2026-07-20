import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/primitives/Button";
import type { TerminalBlock } from "../../stores/blocksStore";
import { CommandBarPopover } from "./commandBar/CommandBarPopover";
import {
  candidateToPopoverItem,
  historyEntryToPopoverItem,
  PICKER_PAGE_SIZE,
} from "./commandBar/commandBarPopoverModel";
import {
  applyCompletionCandidate,
  useCommandCompletion,
} from "./commandBar/useCommandCompletion";
import type { TerminalCompletionContext, CompletionCandidate } from "./commandBar/types";
import {
  filterCompletionLabels,
  type CommandHistoryEntry,
} from "./commandBar/commandHistory";
import { requestShellHistorySyncWithRetry, requestShellHistorySync } from "./commandBar/shellHistorySync";
import { useSessionCommandHistory } from "./commandBar/useSessionCommandHistory";
import { useCommandHistoryBrowse } from "./commandBar/useCommandHistoryBrowse";
import {
  buildCommandPlanPrompt,
  buildExplainErrorPrompt,
  buildFixErrorPrompt,
  openAiWithPrompt,
  saveCommandsAsWorkflow,
  type CommandPlanStep,
} from "./warpExperience";
import { useCommandBarDraftStore } from "./commandBarDraftStore";
import { submitInlineFollowUp, submitInlineNaturalLanguage } from "./warpInlineAi";
import { useTerminalUiStore } from "./terminalUiStore";
import { shouldRouteInputToAi } from "./commandInputRouting";
import { TerminalToolCallDock } from "./TerminalToolCallDock";
import { TerminalCommandBarControls } from "./TerminalCommandBarControls";
import { useBlocksStore } from "../../stores/blocksStore";
import { findTerminalPane, useTerminalStore } from "../../stores/terminalStore";
import { blockContextLabel } from "./formatTerminalBlockForAiContext";
import { scrollTerminalBlockIntoView } from "./scrollTerminalBlockIntoView";
import { useTerminalAiInputContextStore } from "./terminalAiInputContextStore";
import { isPathCompletionInput } from "./commandBar/providers/pathProvider";

const CMD_INPUT_LINE_HEIGHT_PX = 24;
const CMD_INPUT_MAX_HEIGHT_PX = 100;
const EMPTY_ATTACHED_BLOCK_IDS: string[] = [];

function IconCommandHistory() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M3 3.5v3h3" />
      <path d="M3.8 6.2a5.5 5.5 0 108.2 4.8" />
    </svg>
  );
}

function IconCommandCompletion() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 8h8" />
      <path d="M9 5l3 3-3 3" />
    </svg>
  );
}

function syncCommandInputHeight(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  if (!element.value) {
    element.style.height = `${CMD_INPUT_LINE_HEIGHT_PX}px`;
    return;
  }
  element.style.height = `${Math.min(element.scrollHeight, CMD_INPUT_MAX_HEIGHT_PX)}px`;
}

function formatAttachedChipLabel(block: TerminalBlock): string {
  const label = blockContextLabel(block);
  return label.length > 40 ? `${label.slice(0, 40)}…` : label;
}

export type CommandInputHandle = {
  focus: () => void;
  setValue: (text: string) => void;
};

export type CommandInputProps = {
  onSend: (cmd: string) => void;
  promptSymbol?: string;
  sessionId: string;
  cwd?: string;
  resourceId?: string | null;
  sessionType?: "local" | "remote";
  lastError?: TerminalBlock | null;
  disabled?: boolean;
};

export const CommandInput = forwardRef<CommandInputHandle, CommandInputProps>(
  function CommandInput(
    {
      onSend,
      promptSymbol = "$",
      sessionId,
      cwd = "",
      resourceId = null,
      sessionType = "local",
      lastError = null,
      disabled = false,
    },
    ref,
  ) {
    const [value, setValue] = useState("");
    const [cursor, setCursor] = useState(0);
    const [activeIndex, setActiveIndex] = useState(0);
    const [completionOpen, setCompletionOpen] = useState(false);
    const [completionFilter, setCompletionFilter] = useState("");
    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyFilter, setHistoryFilter] = useState("");
    const [historyIndex, setHistoryIndex] = useState(0);
    const [pickerPage, setPickerPage] = useState(0);
    const [planSteps, setPlanSteps] = useState<CommandPlanStep[] | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const editorRef = useRef<HTMLDivElement>(null);
    const historyIndexRef = useRef(0);
    const historyEntriesRef = useRef<CommandHistoryEntry[]>([]);
    const activeIndexRef = useRef(0);
    const filteredCandidatesRef = useRef<CompletionCandidate[]>([]);
    const handlePopoverKeyDownRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
    const popoverModeRef = useRef<"history" | "completion">("completion");
    const pickerPageRef = useRef(0);
    const completionOpenRef = useRef(false);
    const historyOpenRef = useRef(false);
    const { t } = useI18n();
    const expandedAiBlockId = useTerminalUiStore(
      (state) => state.expandedAiBlockIds[sessionId] ?? null,
    );
    const followUpBlockId = expandedAiBlockId;
    const attachedBlockIds = useTerminalAiInputContextStore(
      (state) => state.attachedBlockIds[sessionId] ?? EMPTY_ATTACHED_BLOCK_IDS,
    );
    const detachBlock = useTerminalAiInputContextStore((state) => state.detachBlock);
    const clearAttached = useTerminalAiInputContextStore((state) => state.clearAttached);
    const attachedBlocks = useMemo(() => {
      if (attachedBlockIds.length === 0) return [];
      const findBlockById = useBlocksStore.getState().findBlockById;
      return attachedBlockIds
        .map((blockId) => findBlockById(blockId))
        .filter((block): block is TerminalBlock => block !== null);
    }, [attachedBlockIds]);

    const sessionCwd = useTerminalStore((state) => {
      const pane = findTerminalPane(sessionId);
      if (pane?.cwd) return pane.cwd;
      const tab = state.tabs.find((item) => item.id === sessionId);
      return tab?.session?.cwd ?? cwd;
    });

    const submitInlineAi = useCallback(
      (query: string) => {
        const blockContext = useTerminalAiInputContextStore
          .getState()
          .consumeAttachedContext(sessionId);
        if (followUpBlockId) {
          void submitInlineFollowUp(sessionId, followUpBlockId, query, sessionCwd, { blockContext });
        } else {
          void submitInlineNaturalLanguage(sessionId, query, sessionCwd, { blockContext });
        }
      },
      [sessionCwd, followUpBlockId, sessionId],
    );

    const completionCtx = useMemo<TerminalCompletionContext | null>(() => {
      if (disabled || value.trimStart().startsWith("#")) return null;
      return {
        sessionId,
        cwd: sessionCwd,
        input: value,
        cursor,
        resourceId,
        sessionType,
      };
    }, [cursor, disabled, resourceId, sessionCwd, sessionId, sessionType, value]);

    const wantsPathCompletion = useMemo(
      () => (completionCtx ? isPathCompletionInput(completionCtx) : false),
      [completionCtx],
    );

    const { candidates } = useCommandCompletion(completionCtx, {
      fetchPaths: completionOpen || wantsPathCompletion,
    });

    const filteredCandidates = useMemo(
      () => filterCompletionLabels(candidates, completionFilter),
      [candidates, completionFilter],
    );

    const activeCompletionIndex =
      filteredCandidates.length === 0
        ? 0
        : Math.min(activeIndex, filteredCandidates.length - 1);

    activeIndexRef.current = activeCompletionIndex;
    filteredCandidatesRef.current = filteredCandidates;
    completionOpenRef.current = completionOpen;
    historyOpenRef.current = historyOpen;

    const historyEntries = useSessionCommandHistory(sessionId, historyFilter);

    historyIndexRef.current = historyIndex;
    historyEntriesRef.current = historyEntries;

    const activeHistoryIndex =
      historyEntries.length === 0
        ? 0
        : Math.min(historyIndex, historyEntries.length - 1);

    historyIndexRef.current = activeHistoryIndex;

    const historyPopoverItems = useMemo(
      () => historyEntries.map(historyEntryToPopoverItem),
      [historyEntries],
    );
    const completionPopoverItems = useMemo(
      () => filteredCandidates.map(candidateToPopoverItem),
      [filteredCandidates],
    );

    const popoverOpen = historyOpen || completionOpen;
    const popoverMode = historyOpen ? "history" : "completion";
    popoverModeRef.current = popoverMode;

    const allPopoverItems = historyOpen ? historyPopoverItems : completionPopoverItems;
    const popoverTotalPages = Math.max(1, Math.ceil(allPopoverItems.length / PICKER_PAGE_SIZE));
    const safePickerPage = Math.min(pickerPage, popoverTotalPages - 1);
    const popoverPageStart = safePickerPage * PICKER_PAGE_SIZE;
    const visiblePopoverItems = allPopoverItems.slice(
      popoverPageStart,
      popoverPageStart + PICKER_PAGE_SIZE,
    );
    const globalPopoverIndex = historyOpen ? activeHistoryIndex : activeCompletionIndex;
    const pagePopoverIndex = globalPopoverIndex - popoverPageStart;

    pickerPageRef.current = safePickerPage;

    const {
      resetBrowse,
      browseOlder,
      browseNewer,
      onManualEdit,
      applyCommand: applyHistoryLine,
      isProgrammaticEdit,
      clearProgrammaticEdit,
    } = useCommandHistoryBrowse(sessionId, value, setValue, setCursor);

    const closeHistory = useCallback(() => {
      setHistoryOpen(false);
      setHistoryFilter("");
      setHistoryIndex(0);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }, []);

    const closeCompletion = useCallback(() => {
      setCompletionOpen(false);
      setCompletionFilter("");
      setActiveIndex(0);
    }, []);

    const applyHistoryCommand = useCallback(
      (entry: CommandHistoryEntry) => {
        const command = entry.text;
        applyHistoryLine(command);
        resetBrowse();
        closeHistory();
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.selectionStart = command.length;
          el.selectionEnd = command.length;
          syncCommandInputHeight(el);
        });
      },
      [applyHistoryLine, closeHistory, resetBrowse],
    );

    const openHistory = useCallback(() => {
      if (disabled) return;
      closeCompletion();
      const seed = value.trim();
      const searchSeed = seed.startsWith("#") ? seed.slice(1).trim() : seed;
      setHistoryFilter(searchSeed);
      setHistoryIndex(0);
      setHistoryOpen(true);
      requestShellHistorySyncWithRetry(sessionId);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }, [closeCompletion, disabled, sessionId, value]);

    const openCompletion = useCallback(() => {
      if (disabled) return;
      closeHistory();
      setCompletionOpen(true);
      setCompletionFilter("");
      setActiveIndex(0);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }, [closeHistory, disabled]);

    const handleInputFocus = useCallback(() => {
      requestShellHistorySync(sessionId);
    }, [sessionId]);

    useImperativeHandle(ref, () => ({
      focus: () => {
        textareaRef.current?.focus();
      },
      setValue: (text: string) => {
        setValue(text);
        setCursor(text.length);
        const el = textareaRef.current;
        if (el) syncCommandInputHeight(el);
      },
    }));

    const draftVersion = useCommandBarDraftStore((s) => s.draftVersion[sessionId] ?? 0);

    useEffect(() => {
      const draft = useCommandBarDraftStore.getState().consumeDraft(sessionId);
      if (!draft) return;
      setValue(draft);
      setCursor(draft.length);
      const el = textareaRef.current;
      if (el) syncCommandInputHeight(el);
      textareaRef.current?.focus();
    }, [sessionId, draftVersion]);

    const applyCandidate = useCallback(
      (index: number) => {
        const candidate = filteredCandidatesRef.current[index];
        if (!candidate) return;
        const next = applyCompletionCandidate(value, candidate);
        setValue(next.value);
        setCursor(next.cursor);
        closeCompletion();
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.selectionStart = next.cursor;
          el.selectionEnd = next.cursor;
        });
      },
      [closeCompletion, value],
    );

    const submit = useCallback(() => {
      const trimmed = value.trim();
      if (!trimmed) return;

      if (trimmed.startsWith("#") || trimmed.startsWith("/agent ")) {
        const query = trimmed.startsWith("#")
          ? trimmed.slice(1).trim()
          : trimmed.slice("/agent ".length).trim();
        if (query) {
          submitInlineAi(query);
        }
        setValue("");
        closeCompletion();
        closeHistory();
        resetBrowse();
        return;
      }

      if (trimmed.startsWith("!!plan ")) {
        const goal = trimmed.slice("!!plan ".length).trim();
        if (goal) {
          openAiWithPrompt(buildCommandPlanPrompt(goal, cwd));
        }
        setValue("");
        return;
      }

      if (shouldRouteInputToAi(trimmed)) {
        submitInlineAi(trimmed);
        setValue("");
        closeCompletion();
        closeHistory();
        resetBrowse();
        return;
      }

      onSend(trimmed);
      setValue("");
      closeCompletion();
      closeHistory();
      resetBrowse();
      return;
    }, [closeCompletion, closeHistory, cwd, onSend, resetBrowse, submitInlineAi, value]);

    useLayoutEffect(() => {
      const element = textareaRef.current;
      if (!element) return;
      syncCommandInputHeight(element);
    }, [value]);

    useEffect(() => {
      const element = textareaRef.current;
      if (!element) return;
      const root = element.closest(".term-cmd-input") ?? element;
      const observer = new ResizeObserver(() => syncCommandInputHeight(element));
      observer.observe(root);
      const onWindowResize = () => syncCommandInputHeight(element);
      window.addEventListener("resize", onWindowResize);
      return () => {
        observer.disconnect();
        window.removeEventListener("resize", onWindowResize);
      };
    }, []);

    useEffect(() => {
      if (!completionOpen) {
        setCompletionFilter("");
        setActiveIndex(0);
      }
    }, [completionOpen]);

    useEffect(() => {
      if (!historyOpen) {
        setHistoryFilter("");
        setHistoryIndex(0);
      }
    }, [historyOpen]);

    useEffect(() => {
      if (!completionOpen) return;
      setActiveIndex(0);
    }, [completionFilter, completionOpen]);

    useEffect(() => {
      if (!completionOpen) return;
      setActiveIndex(0);
    }, [value, completionOpen]);

    useEffect(() => {
      setActiveIndex((prev) => {
        const length = filteredCandidates.length;
        if (length === 0) return 0;
        return Math.min(prev, length - 1);
      });
    }, [filteredCandidates.length]);

    useEffect(() => {
      setHistoryIndex(0);
    }, [historyFilter]);

    useEffect(() => {
      if (!popoverOpen) setPickerPage(0);
    }, [popoverOpen]);

    useEffect(() => {
      setPickerPage(0);
    }, [historyFilter, completionFilter, historyOpen, completionOpen]);

    const setGlobalPopoverIndex = useCallback((index: number) => {
      const isHistory = historyOpenRef.current;
      const count = isHistory
        ? historyEntriesRef.current.length
        : filteredCandidatesRef.current.length;
      if (count === 0) return;
      const clamped = ((index % count) + count) % count;
      const page = Math.floor(clamped / PICKER_PAGE_SIZE);
      setPickerPage(page);
      pickerPageRef.current = page;
      if (isHistory) setHistoryIndex(clamped);
      else setActiveIndex(clamped);
    }, []);

    const goPickerPage = useCallback((page: number) => {
      const isHistory = historyOpenRef.current;
      const count = isHistory
        ? historyEntriesRef.current.length
        : filteredCandidatesRef.current.length;
      const totalPages = Math.max(1, Math.ceil(count / PICKER_PAGE_SIZE));
      const nextPage = Math.max(0, Math.min(page, totalPages - 1));
      setPickerPage(nextPage);
      pickerPageRef.current = nextPage;
      const nextIndex = Math.min(nextPage * PICKER_PAGE_SIZE, Math.max(count - 1, 0));
      if (isHistory) setHistoryIndex(nextIndex);
      else setActiveIndex(nextIndex);
    }, []);

    const applyPopoverSelection = useCallback(
      (index: number) => {
        if (historyOpenRef.current) {
          const entry = historyEntriesRef.current[index];
          if (entry) applyHistoryCommand(entry);
          return;
        }
        applyCandidate(index);
      },
      [applyCandidate, applyHistoryCommand],
    );

    const cycleHistoryMatch = useCallback(() => {
      setGlobalPopoverIndex(historyIndexRef.current + 1);
    }, [setGlobalPopoverIndex]);

    const handlePopoverKeyDown = useCallback(
      (event: KeyboardEvent) => {
        const isHistory = popoverModeRef.current === "history";
        const count = isHistory
          ? historyEntriesRef.current.length
          : filteredCandidatesRef.current.length;
        const currentIndex = isHistory ? historyIndexRef.current : activeIndexRef.current;

        if (isHistory && event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "r") {
          event.preventDefault();
          cycleHistoryMatch();
          return;
        }

        if (event.key === "ArrowLeft") {
          event.preventDefault();
          goPickerPage(pickerPageRef.current - 1);
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          goPickerPage(pickerPageRef.current + 1);
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          if (count === 0) return;
          setGlobalPopoverIndex(currentIndex + 1);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          if (count === 0) return;
          setGlobalPopoverIndex(currentIndex - 1);
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          if (count === 0) return;
          if (event.shiftKey) {
            setGlobalPopoverIndex(currentIndex - 1);
            return;
          }
          applyPopoverSelection(currentIndex);
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          if (count === 0) return;
          applyPopoverSelection(currentIndex);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          if (isHistory) closeHistory();
          else closeCompletion();
        }
      },
      [
        applyPopoverSelection,
        closeCompletion,
        closeHistory,
        cycleHistoryMatch,
        goPickerPage,
        setGlobalPopoverIndex,
      ],
    );

    handlePopoverKeyDownRef.current = handlePopoverKeyDown;

    useEffect(() => {
      if (!popoverOpen) return;
      const onKeyDown = (event: globalThis.KeyboardEvent) => {
        if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Tab"].includes(event.key)) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest(".term-cmd-picker__search")) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        handlePopoverKeyDownRef.current(event as unknown as KeyboardEvent);
      };
      window.addEventListener("keydown", onKeyDown, true);
      return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [popoverOpen]);

    const placeholder = lastError
      ? t("terminal.command.explainHint")
      : followUpBlockId
        ? t("terminal.command.followUpHint")
        : t("terminal.command.placeholder");

    return (
      <div className="term-cmd-input-wrap">
        <TerminalToolCallDock sessionId={sessionId} />
        {planSteps && planSteps.length > 0 ? (
          <div className="term-cmd-plan">
            <div className="term-cmd-plan-header">
              <span>{t("terminal.command.planTitle")}</span>
              <button type="button" className="term-cmd-plan-close" onClick={() => setPlanSteps(null)}>
                ×
              </button>
            </div>
            {planSteps.map((step, index) => (
              <div key={`${step.command}-${index}`} className="term-cmd-plan-step">
                <span>{step.title}</span>
                <code>{step.command}</code>
                <Button size="xs" variant="secondary" onClick={() => onSend(step.command)}>
                  {t("terminal.command.runStep")}
                </Button>
              </div>
            ))}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                void saveCommandsAsWorkflow(
                  `终端计划 ${new Date().toLocaleString()}`,
                  planSteps.map((s) => s.command),
                  cwd || "local",
                ).catch(() => undefined);
              }}
            >
              {t("terminal.command.saveWorkflow")}
            </Button>
          </div>
        ) : null}

        {attachedBlocks.length > 0 ? (
          <div className="term-cmd-context-bar">
            <div className="term-cmd-context-chips">
              {attachedBlocks.map((block) => (
                <div key={block.id} className="term-cmd-context-chip">
                  <button
                    type="button"
                    className="term-cmd-context-chip__label"
                    title={blockContextLabel(block)}
                    aria-label={t("terminal.command.jumpToAttachedContext", {
                      label: blockContextLabel(block),
                    })}
                    onClick={() => scrollTerminalBlockIntoView(sessionId, block.id)}
                  >
                    {formatAttachedChipLabel(block)}
                  </button>
                  <button
                    type="button"
                    className="term-cmd-context-chip__remove"
                    aria-label={t("terminal.command.detachAttachedContext")}
                    onClick={() => detachBlock(sessionId, block.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            {attachedBlocks.length > 1 ? (
              <button
                type="button"
                className="term-cmd-context-chips__clear"
                onClick={() => clearAttached(sessionId)}
              >
                {t("terminal.command.clearAllAttachedContext")}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className={`term-cmd-input${disabled ? " is-disabled" : ""}`}>
          <span className="term-cmd-prompt">{promptSymbol}</span>
          <div className="term-cmd-editor" ref={editorRef}>
            <textarea
              ref={textareaRef}
              className="term-cmd-textarea"
              value={value}
              disabled={disabled}
              onFocus={handleInputFocus}
              onChange={(event) => {
                const next = event.target.value;
                setValue(next);
                setCursor(event.target.selectionStart ?? next.length);
                if (isProgrammaticEdit()) {
                  clearProgrammaticEdit();
                  return;
                }
                if (historyOpen) {
                  const seed = next.trim();
                  setHistoryFilter(seed.startsWith("#") ? seed.slice(1).trim() : seed);
                  onManualEdit();
                  return;
                }
                onManualEdit();
              }}
              onSelect={(event) => {
                const target = event.target as HTMLTextAreaElement;
                setCursor(target.selectionStart ?? 0);
              }}
              onKeyDown={(event) => {
                if (popoverOpen) {
                  handlePopoverKeyDown(event);
                  if (
                    ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Tab"].includes(
                      event.key,
                    ) &&
                    !(event.key === "Enter" && event.shiftKey)
                  ) {
                    return;
                  }
                }

                if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "r") {
                  event.preventDefault();
                  if (historyOpen) {
                    cycleHistoryMatch();
                  } else {
                    openHistory();
                  }
                  return;
                }

                if (event.key === "Tab") {
                  event.preventDefault();
                  if (!popoverOpen) {
                    closeHistory();
                    openCompletion();
                    return;
                  }
                  handlePopoverKeyDown(event);
                  return;
                }

                if (!popoverOpen && event.key === "ArrowUp" && !event.shiftKey) {
                  event.preventDefault();
                  browseOlder();
                  return;
                }
                if (!popoverOpen && event.key === "ArrowDown" && !event.shiftKey) {
                  event.preventDefault();
                  browseNewer();
                  return;
                }

                if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "e" && lastError) {
                  event.preventDefault();
                  openAiWithPrompt(buildExplainErrorPrompt(lastError));
                  return;
                }
                if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f" && lastError) {
                  event.preventDefault();
                  openAiWithPrompt(buildFixErrorPrompt(lastError));
                  return;
                }

                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={placeholder}
              rows={1}
              spellCheck={false}
            />
            <CommandBarPopover
              anchorRef={editorRef}
              mode={popoverMode}
              items={visiblePopoverItems}
              activeIndex={Math.max(0, pagePopoverIndex)}
              page={safePickerPage}
              totalPages={popoverTotalPages}
              filter={historyOpen ? historyFilter : completionFilter}
              onFilterChange={historyOpen ? setHistoryFilter : setCompletionFilter}
              onHighlightIndex={(index) => setGlobalPopoverIndex(popoverPageStart + index)}
              onSelect={(index) => applyPopoverSelection(popoverPageStart + index)}
              onNavigateKeyDown={handlePopoverKeyDown}
              visible={popoverOpen}
            />
          </div>
          <div className="term-cmd-actions">
            <button
              type="button"
              className={`term-cmd-action-btn${historyOpen ? " is-active" : ""}`}
              title={t("terminal.command.openHistory")}
              aria-label={t("terminal.command.openHistory")}
              disabled={disabled}
              onClick={openHistory}
            >
              <IconCommandHistory />
            </button>
            <button
              type="button"
              className={`term-cmd-action-btn${completionOpen ? " is-active" : ""}`}
              title={t("terminal.command.openCompletion")}
              aria-label={t("terminal.command.openCompletion")}
              disabled={disabled}
              onClick={openCompletion}
            >
              <IconCommandCompletion />
            </button>
            <TerminalCommandBarControls disabled={disabled} />
            {lastError ? (
              <>
                <Button
                  variant="outline"
                  size="xs"
                  className="omni-btn-tool"
                  title={t("terminal.command.explainError")}
                  onClick={() => openAiWithPrompt(buildExplainErrorPrompt(lastError))}
                  type="button"
                >
                  !
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  className="omni-btn-tool"
                  title={t("terminal.command.fixError")}
                  onClick={() => openAiWithPrompt(buildFixErrorPrompt(lastError))}
                  type="button"
                >
                  ↻
                </Button>
              </>
            ) : null}
            <Button
              variant="outline"
              size="xs"
              className="term-cmd-send omni-btn-outline-accent"
              onClick={submit}
              title={t("terminal.command.send")}
              type="button"
              disabled={disabled}
            >
              ↵
            </Button>
          </div>
        </div>
      </div>
    );
  },
);
