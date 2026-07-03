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
import { Button } from "../../components/ui/Button";
import type { TerminalBlock } from "../../stores/blocksStore";
import { CommandCompletionPopover } from "./commandBar/CommandCompletionPopover";
import { CommandHistoryPopover } from "./commandBar/CommandHistoryPopover";
import {
  applyCompletionCandidate,
  useCommandCompletion,
} from "./commandBar/useCommandCompletion";
import type { TerminalCompletionContext } from "./commandBar/types";
import {
  filterCompletionLabels,
  type CommandHistoryEntry,
} from "./commandBar/commandHistory";
import { requestShellHistorySyncWithRetry } from "./commandBar/shellHistorySync";
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
import { blockContextLabel } from "./formatTerminalBlockForAiContext";
import { useTerminalAiInputContextStore } from "./terminalAiInputContextStore";

const CMD_INPUT_LINE_HEIGHT_PX = 24;
const CMD_INPUT_MAX_HEIGHT_PX = 100;
const EMPTY_ATTACHED_BLOCK_IDS: string[] = [];

const INTERACTIVE_COMMAND_HINT = /^(vim|vi|nano|top|htop|less|more|python|node|ssh)\b/i;

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
  onRequestNativeMode?: () => void;
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
      onRequestNativeMode,
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
    const [planSteps, setPlanSteps] = useState<CommandPlanStep[] | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const historyIndexRef = useRef(0);
    const historyEntriesRef = useRef<CommandHistoryEntry[]>([]);
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

    const submitInlineAi = useCallback(
      (query: string) => {
        const blockContext = useTerminalAiInputContextStore
          .getState()
          .consumeAttachedContext(sessionId);
        if (followUpBlockId) {
          void submitInlineFollowUp(sessionId, followUpBlockId, query, cwd, { blockContext });
        } else {
          void submitInlineNaturalLanguage(sessionId, query, cwd, { blockContext });
        }
      },
      [cwd, followUpBlockId, sessionId],
    );

    const completionCtx = useMemo<TerminalCompletionContext | null>(() => {
      if (disabled || value.startsWith("#")) return null;
      return {
        sessionId,
        cwd,
        input: value,
        cursor,
        resourceId,
        sessionType,
      };
    }, [cwd, cursor, disabled, resourceId, sessionId, sessionType, value]);

    const { candidates } = useCommandCompletion(completionCtx, {
      fetchPaths: completionOpen,
    });

    const filteredCandidates = useMemo(
      () => filterCompletionLabels(candidates, completionFilter),
      [candidates, completionFilter],
    );

    const historyEntries = useSessionCommandHistory(sessionId, historyFilter);

    historyIndexRef.current = historyIndex;
    historyEntriesRef.current = historyEntries;

    const activeHistoryIndex =
      historyEntries.length === 0
        ? 0
        : Math.min(historyIndex, historyEntries.length - 1);

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
        const candidate = filteredCandidates[index];
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
      [closeCompletion, filteredCandidates, value],
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

      const isInteractive = INTERACTIVE_COMMAND_HINT.test(trimmed);
      onSend(trimmed);
      setValue("");
      closeCompletion();
      closeHistory();
      resetBrowse();
      if (isInteractive && onRequestNativeMode) {
        requestAnimationFrame(() => onRequestNativeMode());
      }
      return;
    }, [closeCompletion, closeHistory, cwd, onRequestNativeMode, onSend, resetBrowse, submitInlineAi, value]);

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
      setActiveIndex(0);
    }, [completionFilter, filteredCandidates.length]);

    useEffect(() => {
      setHistoryIndex(0);
    }, [historyFilter]);

    const cycleHistoryMatch = useCallback(() => {
      const entries = historyEntriesRef.current;
      if (entries.length === 0) return;
      setHistoryIndex((prev) => {
        const safe = entries.length === 0 ? 0 : Math.min(prev, entries.length - 1);
        return (safe + 1) % entries.length;
      });
    }, []);

    const handleHistoryKeyDown = useCallback(
      (event: KeyboardEvent) => {
        const entries = historyEntriesRef.current;

        if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "r") {
          event.preventDefault();
          cycleHistoryMatch();
          return;
        }

        if (event.key === "ArrowDown") {
          event.preventDefault();
          if (entries.length === 0) return;
          setHistoryIndex((prev) => (prev + 1) % entries.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          if (entries.length === 0) return;
          setHistoryIndex((prev) => (prev - 1 + entries.length) % entries.length);
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          const index = Math.min(historyIndexRef.current, Math.max(entries.length - 1, 0));
          const entry = entries[index];
          if (entry) applyHistoryCommand(entry);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeHistory();
        }
      },
      [applyHistoryCommand, closeHistory, cycleHistoryMatch],
    );

    const handleCompletionKeyDown = useCallback(
      (event: KeyboardEvent) => {
        if (!completionOpen) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          if (filteredCandidates.length === 0) return;
          setActiveIndex((prev) => (prev + 1) % filteredCandidates.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          if (filteredCandidates.length === 0) return;
          setActiveIndex(
            (prev) => (prev - 1 + filteredCandidates.length) % filteredCandidates.length,
          );
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          applyCandidate(activeIndex);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeCompletion();
        }
      },
      [activeIndex, applyCandidate, closeCompletion, completionOpen, filteredCandidates.length],
    );

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
                  <span
                    className="term-cmd-context-chip__label"
                    title={blockContextLabel(block)}
                  >
                    {t("terminal.command.attachedContext", {
                      label: formatAttachedChipLabel(block),
                    })}
                  </span>
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
          <div className="term-cmd-editor">
            <textarea
              ref={textareaRef}
              className="term-cmd-textarea"
              value={value}
              disabled={disabled}
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
                if (historyOpen) {
                  handleHistoryKeyDown(event);
                  return;
                }

                if (completionOpen) {
                  handleCompletionKeyDown(event);
                  if (
                    ["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key) &&
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
                  closeHistory();
                  if (!completionOpen) {
                    setCompletionOpen(true);
                    setCompletionFilter("");
                    setActiveIndex(0);
                    return;
                  }
                  if (filteredCandidates.length === 0) return;
                  if (filteredCandidates.length === 1) {
                    applyCandidate(0);
                    return;
                  }
                  const next = event.shiftKey
                    ? (activeIndex - 1 + filteredCandidates.length) % filteredCandidates.length
                    : (activeIndex + 1) % filteredCandidates.length;
                  setActiveIndex(next);
                  return;
                }

                if (!completionOpen && !historyOpen && event.key === "ArrowUp" && !event.shiftKey) {
                  event.preventDefault();
                  browseOlder();
                  return;
                }
                if (!completionOpen && !historyOpen && event.key === "ArrowDown" && !event.shiftKey) {
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
            <CommandHistoryPopover
              entries={historyEntries}
              activeIndex={activeHistoryIndex}
              filter={historyFilter}
              onFilterChange={setHistoryFilter}
              onHighlightIndex={setHistoryIndex}
              onSelect={applyHistoryCommand}
              onNavigateKeyDown={handleHistoryKeyDown}
              visible={historyOpen}
            />
            <CommandCompletionPopover
              candidates={filteredCandidates}
              activeIndex={activeIndex}
              filter={completionFilter}
              onFilterChange={setCompletionFilter}
              onNavigateKeyDown={handleCompletionKeyDown}
              visible={completionOpen}
              onSelect={(candidate) => {
                const index = filteredCandidates.findIndex((item) => item.id === candidate.id);
                applyCandidate(index >= 0 ? index : 0);
              }}
            />
          </div>
          <div className="term-cmd-actions">
            <TerminalCommandBarControls disabled={disabled} />
            {lastError ? (
              <>
                <Button
                  variant="ghost"
                  size="xs"
                  title={t("terminal.command.explainError")}
                  onClick={() => openAiWithPrompt(buildExplainErrorPrompt(lastError))}
                  type="button"
                >
                  !
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  title={t("terminal.command.fixError")}
                  onClick={() => openAiWithPrompt(buildFixErrorPrompt(lastError))}
                  type="button"
                >
                  ↻
                </Button>
              </>
            ) : null}
            <Button
              variant="primary"
              size="xs"
              className="term-cmd-send"
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
