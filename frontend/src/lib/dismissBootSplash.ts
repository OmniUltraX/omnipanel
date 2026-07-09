/** 移除 index.html 内联启动占位（主窗 Bootstrap / 工作区窗均需调用） */
export function dismissHtmlBootSplash(): void {
  document.getElementById("boot-splash")?.remove();
}
