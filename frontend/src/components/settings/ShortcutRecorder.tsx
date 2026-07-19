import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../ui/primitives/Button";
import {
  eventToKeyTokens,
  findShortcutConflict,
  formatShortcut,
  useShortcutsStore,
  type KeyBinding,
} from "../../stores/shortcutsStore";

interface ShortcutRecorderProps {
  id: string;
  /** 当前生效的所有绑定（多绑定） */
  value: KeyBinding[];
  /** 是否禁用录制（nonRecordable 条目） */
  disabled?: boolean;
}

type RecordState =
  | { mode: "idle" }
  | { mode: "recording"; editingIndex: number | null }
  | { mode: "conflict"; candidate: KeyBinding; conflictLabel: string; editingIndex: number | null };

/**
 * 多绑定快捷键录制控件：
 * 1. 显示当前所有绑定（kbd 列表），每个绑定可单独更改/删除
 * 2. "添加绑定"按钮：录制一个新的绑定
 * 3. 点击某个绑定的"更改"：替换该位置的绑定
 * 4. 录制时若与其它快捷键冲突，进入冲突态要求确认
 * 5. Esc / "取消"退出录制
 */
export function ShortcutRecorder({ id, value, disabled }: ShortcutRecorderProps) {
  const { t } = useI18n();
  const setShortcut = useShortcutsStore((s) => s.setShortcut);
  const addBinding = useShortcutsStore((s) => s.addBinding);
  const removeBinding = useShortcutsStore((s) => s.removeBinding);
  const resetShortcut = useShortcutsStore((s) => s.resetShortcut);
  const isCustomized = useShortcutsStore((s) => id in s.overrides);

  const [state, setState] = useState<RecordState>({ mode: "idle" });
  const releaseRef = useRef<(() => void) | null>(null);

  // 写入一个新绑定：editingIndex=null 表示添加，否则表示替换指定位置
  const commitBinding = (binding: KeyBinding, editingIndex: number | null) => {
    if (editingIndex === null) {
      addBinding(id, binding);
    } else {
      // 替换指定位置：构造新数组
      const next = value.map((b, i) => (i === editingIndex ? binding : b));
      setShortcut(id, next);
    }
  };

  useEffect(() => {
    if (state.mode !== "recording" && state.mode !== "conflict") return;
    const editingIndex = state.editingIndex;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setState({ mode: "idle" });
        return;
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const tokens = eventToKeyTokens(e);
      if (!tokens) return;
      e.preventDefault();
      e.stopPropagation();

      const conflict = findShortcutConflict(tokens, id);
      if (conflict) {
        setState({
          mode: "conflict",
          candidate: tokens,
          conflictLabel: t(`settings.keybindings.items.${conflict.id}`),
          editingIndex,
        });
      } else {
        commitBinding(tokens, editingIndex);
        setState({ mode: "idle" });
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    releaseRef.current = () =>
      document.removeEventListener("keydown", onKeyDown, true);
    return () => {
      releaseRef.current?.();
      releaseRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, id, t]);

  if (disabled) {
    return (
      <div className="keybind keybind-readonly">
        <kbd>{formatShortcut(value[0] ?? [])}</kbd>
      </div>
    );
  }

  const isRecording = state.mode === "recording" || state.mode === "conflict";
  const recordingIndex = isRecording ? state.editingIndex : null;

  return (
    <div className="keybind keybind-multi">
      {/* 已有绑定列表 */}
      {value.map((binding, i) => {
        const isThisRecording = isRecording && recordingIndex === i;
        if (isThisRecording && state.mode === "recording") {
          return (
            <div key={i} className="keybind keybind-recording">
              <span className="keybind-prompt">
                {t("settings.keybindings.recorder.pressCombo")}
              </span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setState({ mode: "idle" })}
              >
                {t("settings.keybindings.recorder.cancel")}
              </Button>
            </div>
          );
        }
        if (isThisRecording && state.mode === "conflict") {
          return (
            <div key={i} className="keybind keybind-conflict">
              <span className="keybind-conflict-msg">
                {t("settings.keybindings.recorder.conflict", {
                  shortcut: formatShortcut(state.candidate),
                  other: state.conflictLabel,
                })}
              </span>
              <Button
                variant="primary"
                size="xs"
                onClick={() => {
                  commitBinding(state.candidate, recordingIndex);
                  setState({ mode: "idle" });
                }}
              >
                {t("settings.keybindings.recorder.replace")}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setState({ mode: "idle" })}
              >
                {t("settings.keybindings.recorder.cancel")}
              </Button>
            </div>
          );
        }
        return (
          <div key={i} className="keybind-binding">
            <kbd>{formatShortcut(binding)}</kbd>
            <Button
              variant="ghost"
              size="xs"
              className="keybind-edit-btn"
              onClick={() => setState({ mode: "recording", editingIndex: i })}
            >
              {t("settings.keybindings.recorder.change")}
            </Button>
            {value.length > 1 && (
              <Button
                variant="ghost"
                size="xs"
                title={t("settings.keybindings.recorder.removeBinding")}
                onClick={() => removeBinding(id, i)}
              >
                ×
              </Button>
            )}
          </div>
        );
      })}

      {/* 录制新绑定时显示的提示行（editingIndex === null） */}
      {isRecording && recordingIndex === null && state.mode === "recording" && (
        <div className="keybind keybind-recording">
          <span className="keybind-prompt">
            {t("settings.keybindings.recorder.pressCombo")}
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setState({ mode: "idle" })}
          >
            {t("settings.keybindings.recorder.cancel")}
          </Button>
        </div>
      )}
      {isRecording && recordingIndex === null && state.mode === "conflict" && (
        <div className="keybind keybind-conflict">
          <span className="keybind-conflict-msg">
            {t("settings.keybindings.recorder.conflict", {
              shortcut: formatShortcut(state.candidate),
              other: state.conflictLabel,
            })}
          </span>
          <Button
            variant="primary"
            size="xs"
            onClick={() => {
              commitBinding(state.candidate, null);
              setState({ mode: "idle" });
            }}
          >
            {t("settings.keybindings.recorder.replace")}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setState({ mode: "idle" })}
          >
            {t("settings.keybindings.recorder.cancel")}
          </Button>
        </div>
      )}

      {/* 添加新绑定按钮（非录制态显示） */}
      {!isRecording && (
        <Button
          variant="ghost"
          size="xs"
          className="keybind-add-btn"
          onClick={() => setState({ mode: "recording", editingIndex: null })}
        >
          {t("settings.keybindings.recorder.addBinding")}
        </Button>
      )}

      {/* 重置为默认 */}
      {isCustomized && !isRecording && (
        <Button
          variant="ghost"
          size="xs"
          title={t("settings.keybindings.recorder.resetOne")}
          onClick={() => resetShortcut(id)}
        >
          {t("settings.keybindings.recorder.resetOne")}
        </Button>
      )}
    </div>
  );
}
