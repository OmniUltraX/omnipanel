/** 聚焦侧栏或子窗口里的 AI 输入框，不发送。 */
export function focusAiComposer(): void {
  const focus = () => {
    const input = document.querySelector<HTMLTextAreaElement>(
      ".ai-dockview .aui-composer-input, .ai-subwindow .aui-composer-input",
    );
    input?.focus();
  };
  requestAnimationFrame(() => {
    focus();
    window.setTimeout(focus, 60);
  });
}
