import { quickInput } from "../stores/quickInputStore";

/** 应用内输入框，替代 window.prompt */
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
