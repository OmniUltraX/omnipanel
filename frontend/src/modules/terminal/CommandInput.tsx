import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import type { TerminalBlock } from "../../stores/blocksStore";
import { CommandCompletionPopover } from "./commandBar/CommandCompletionPopover";
import {
  applyCompletionCandidate,
  useCommandCompletion,
} from "./commandBar/useCommandCompletion";
import type { TerminalCompletionContext } from "./commandBar/types";
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
import { TerminalToolCallDock } from "./TerminalToolCallDock";

const CMD_INPUT_LINE_HEIGHT_PX = 24;
const CMD_INPUT_MAX_HEIGHT_PX = 100;

const INTERACTIVE_COMMAND_HINT = /^(vim|vi|nano|top|htop|less|more|python|node|ssh)\b/i;

function syncCommandInputHeight(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  if (!element.value) {
    element.style.height = `${CMD_INPUT_LINE_HEIGHT_PX}px`;
    return;
  }
  element.style.height = `${Math.min(element.scrollHeight, CMD_INPUT_MAX_HEIGHT_PX)}px`;
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
    const [planSteps, setPlanSteps] = useState<CommandPlanStep[] | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const { t } = useI18n();
    const expandedAiBlockId = useTerminalUiStore(
      (state) => state.expandedAiBlockIds[sessionId] ?? null,
    );
    const followUpBlockId = expandedAiBlockId;

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
        const candidate = candidates[index];
        if (!candidate) return;
        const next = applyCompletionCandidate(value, candidate);
        setValue(next.value);
        setCursor(next.cursor);
        setCompletionOpen(false);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.selectionStart = next.cursor;
          el.selectionEnd = next.cursor;
        });
      },
      [candidates, value],
    );

    const submit = useCallback(() => {
      const trimmed = value.trim();
      if (!trimmed) return;

      if (trimmed.startsWith("#") || trimmed.startsWith("/agent ")) {
        const query = trimmed.startsWith("#")
          ? trimmed.slice(1).trim()
          : trimmed.slice("/agent ".length).trim();
        if (query) {
          if (followUpBlockId) {
            void submitInlineFollowUp(sessionId, followUpBlockId, query, cwd);
          } else {
            void submitInlineNaturalLanguage(sessionId, query, cwd);
          }
        }
        setValue("");
        setCompletionOpen(false);
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

      const isInteractive = INTERACTIVE_COMMAND_HINT.test(trimmed);
      onSend(trimmed);
      setValue("");
      setCompletionOpen(false);
      if (isInteractive && onRequestNativeMode) {
        requestAnimationFrame(() => onRequestNativeMode());
      }
      return;
    }, [cwd, followUpBlockId, onRequestNativeMode, onSend, sessionId, value]);

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
      if (!completionOpen) setActiveIndex(0);
    }, [candidates, completionOpen]);

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

        <div className={`term-cmd-input${disabled ? " is-disabled" : ""}`}>
          <span className="term-cmd-prompt">{promptSymbol}</span>
          <div className="term-cmd-editor">
            <textarea
              ref={textareaRef}
              className="term-cmd-textarea"
              value={value}
              disabled={disabled}
              onChange={(event) => {
                setValue(event.target.value);
                setCursor(event.target.selectionStart ?? event.target.value.length);
                setCompletionOpen(false);
              }}
              onSelect={(event) => {
                const target = event.target as HTMLTextAreaElement;
                setCursor(target.selectionStart ?? 0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Tab") {
                  event.preventDefault();
                  if (!completionOpen) {
                    setCompletionOpen(true);
                    setActiveIndex(0);
                    return;
                  }
                  if (candidates.length === 0) return;
                  if (candidates.length === 1) {
                    applyCandidate(0);
                    return;
                  }
                  const next = event.shiftKey
                    ? (activeIndex - 1 + candidates.length) % candidates.length
                    : (activeIndex + 1) % candidates.length;
                  setActiveIndex(next);
                  return;
                }

                if (completionOpen && event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex((prev) => (prev + 1) % candidates.length);
                  return;
                }
                if (completionOpen && event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((prev) => (prev - 1 + candidates.length) % candidates.length);
                  return;
                }
                if (completionOpen && event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  applyCandidate(activeIndex);
                  return;
                }
                if (event.key === "Escape") {
                  setCompletionOpen(false);
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
            <CommandCompletionPopover
              candidates={candidates}
              activeIndex={activeIndex}
              visible={completionOpen && candidates.length > 0}
              onSelect={(candidate) => {
                const index = candidates.findIndex((item) => item.id === candidate.id);
                applyCandidate(index >= 0 ? index : 0);
              }}
            />
          </div>
          <div className="term-cmd-actions">
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
