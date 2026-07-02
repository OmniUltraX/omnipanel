import { quickInput } from "../stores/quickInputStore";

/**
 * 应用内输入框（`QuickInputHost` + `QuickInputDialog`）。
 *
 * **禁止**改为 `window.prompt` 或 Tauri 原生输入框。
 */
export function appPrompt(
  message: string,
  defaultValue = "",
  title = "OmniPanel",
): Promise<string | null> {
  return quickInput({
    title,
    subtitle: message,
    defaultValue,
  });
}
