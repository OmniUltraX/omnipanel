import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../ui/primitives/Button";
import {
  eventToKeyTokens,
  findShortcutConflict,
  formatShortcut,
  useShortcutsStore,
  type KeyToken,
} from "../../stores/shortcutsStore";

interface ShortcutRecorderProps {
  id: string;
  /** 当前生效的按键（用于默认显示） */
  value: KeyToken[];
  /** 是否禁用录制（nonRecordable 条目） */
  disabled?: boolean;
}

type RecordState =
  | { mode: "idle" }
  | { mode: "recording" }
  | { mode: "conflict"; candidate: KeyToken[]; conflictLabel: string };

/**
 * 单个快捷键的录制控件：
 * 1. 默认显示当前按键（kbd 形式）
 * 2. 点击「更改」进入录制模式：捕获下一次按键组合
 * 3. 录制时若与其它已配置快捷键冲突，进入冲突态要求确认
 * 4. Esc / 「取消」退出录制
 */
export function ShortcutRecorder({ id, value, disabled }: ShortcutRecorderProps) {
  const { t } = useI18n();
  const setShortcut = useShortcutsStore((s) => s.setShortcut);
  const resetShortcut = useShortcutsStore((s) => s.resetShortcut);
  const isCustomized = useShortcutsStore((s) => id in s.overrides);

  const [state, setState] = useState<RecordState>({ mode: "idle" });
  // 用来在录制期临时屏蔽 document 上的其它快捷键监听（如 AI 切换）
  const releaseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (state.mode !== "recording") return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Esc 取消
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setState({ mode: "idle" });
        return;
      }
      // 单独的修饰键按下不录入
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
        });
      } else {
        setShortcut(id, tokens);
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
  }, [state.mode, id, setShortcut, t]);

  if (disabled) {
    return (
      <div className="keybind keybind-readonly">
        <kbd>{formatShortcut(value)}</kbd>
      </div>
    );
  }

  if (state.mode === "recording") {
    return (
      <div className="keybind keybind-recording">
        <span className="keybind-prompt">{t("settings.keybindings.recorder.pressCombo")}</span>
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

  if (state.mode === "conflict") {
    return (
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
            setShortcut(id, state.candidate);
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
    <div className="keybind">
      {value.map((k, i) => (
        <span key={i}>
          {i > 0 && " + "}
          <kbd>{k}</kbd>
        </span>
      ))}
      <Button
        variant="ghost"
        size="xs"
        className="keybind-edit-btn"
        onClick={() => setState({ mode: "recording" })}
      >
        {t("settings.keybindings.recorder.change")}
      </Button>
      {isCustomized && (
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
