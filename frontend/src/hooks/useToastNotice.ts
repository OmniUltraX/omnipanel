import { useEffect, useRef } from "react";
import { showToast, type ToastTone } from "../stores/toastStore";

/** 把本来会插进布局的一条提示，改送到不占位的全局 Toast。 */
export function useToastNotice(
  message: string | null | undefined,
  tone: ToastTone = "neutral",
) {
  const last = useRef<string | null>(null);
  useEffect(() => {
    const text = message?.trim() ? message : null;
    if (!text) {
      last.current = null;
      return;
    }
    if (last.current === text) return;
    last.current = text;
    showToast(text, { tone });
  }, [message, tone]);
}
