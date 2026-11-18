import { create } from "zustand";

const DEFAULT_DURATION_MS = 2400;
const EXIT_ANIMATION_MS = 280;

export type ToastTone = "neutral" | "success" | "warning" | "error";

export type ToastOptions = {
  duration?: number;
  tone?: ToastTone;
};

const TONE_DURATION: Record<ToastTone, number> = {
  neutral: DEFAULT_DURATION_MS,
  success: DEFAULT_DURATION_MS,
  warning: 4200,
  error: 5200,
};

interface ToastState {
  message: string | null;
  tone: ToastTone;
  visible: boolean;
  show: (message: string, duration?: number, tone?: ToastTone) => void;
  dismiss: () => void;
}

let hideTimer: ReturnType<typeof setTimeout> | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers() {
  if (hideTimer != null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (clearTimer != null) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
}

export const useToastStore = create<ToastState>((set) => ({
  message: null,
  tone: "neutral",
  visible: false,
  show: (message, duration = DEFAULT_DURATION_MS, tone = "neutral") => {
    clearTimers();
    set({ message, tone, visible: true });
    hideTimer = setTimeout(() => {
      set({ visible: false });
      clearTimer = setTimeout(() => {
        set({ message: null });
        clearTimer = null;
      }, EXIT_ANIMATION_MS);
    }, duration);
  },
  dismiss: () => {
    clearTimers();
    set({ visible: false });
    clearTimer = setTimeout(() => {
      set({ message: null });
      clearTimer = null;
    }, EXIT_ANIMATION_MS);
  },
}));

let lastToastKey = "";
let lastToastAt = 0;

/** 显示全局 Toast（固定在窗口上方，不占布局）。 */
export function showToast(message: string, durationOrOptions?: number | ToastOptions) {
  const tone: ToastTone =
    typeof durationOrOptions === "object" && durationOrOptions.tone
      ? durationOrOptions.tone
      : "neutral";
  const duration =
    typeof durationOrOptions === "number"
      ? durationOrOptions
      : (durationOrOptions?.duration ?? TONE_DURATION[tone]);
  const text = message.trim();
  if (!text) return;
  const key = `${tone}|${text}`;
  const now = Date.now();
  if (key === lastToastKey && now - lastToastAt < 400) return;
  lastToastKey = key;
  lastToastAt = now;
  useToastStore.getState().show(text, duration, tone);
}
