// 全屏终端信号检测：
//   1. 进入 alternate screen buffer（1049h/1047h/47h）—— vim/less/htop 等 TUI 程序的可靠标志
//   2. 启用鼠标追踪（1000h/1002h/1003h/1006h）—— TUI 程序接管鼠标输入的可靠标志
//
// 注意：曾经包含第三分支 `\x1b\[[0-9]+;[0-9]+[Hf]`（CSI 光标定位 CUP/HVP），
// 但 Windows conpty 在渲染 PowerShell 普通命令输出（如 ls/Format-Table）时会大量
// 发送 CUP 序列重绘屏幕，导致普通命令被误判为 TUI 程序并进入 full-terminal。
// 首次 ls 触发、第二次 ls 正常的现象即源于此（conpty 首次渲染 CUP 密集，后续增量更新）。
// TUI 程序几乎都会先进入 alt screen，CUP 作为唯一信号误报率过高，故移除。
const FULL_TERMINAL_SIGNAL_RE =
  /\x1b\[\?(?:1049|1047|47)h|\x1b\[\?(?:1000|1002|1003|1006)h/;

// 退出信号仅匹配 alt screen 离开（1049l/1047l/47l），
// 不匹配鼠标追踪关闭（1000l 等）：TUI 可能临时关闭鼠标而不退出，
// 鼠标 ?l 误报率过高。
//
// 重要：hasFullTerminalExitSignal 仅供检测 / 测试 / 未来延迟策略使用，
// 不要把它当作立刻退出 full-terminal 的触发器。
// hermes model 等多步交互 TUI 会在步骤之间发送 1049l，下一问仍在同一进程；
// 过早 returnToCommandBar 会导致 xterm 隐藏、按键无法送达 PTY。
// full-terminal 结束应以 OSC 133 D（命令真正结束）为准。
const FULL_TERMINAL_EXIT_SIGNAL_RE = /\x1b\[\?(?:1049|1047|47)l/;

export function hasFullTerminalSignal(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  return FULL_TERMINAL_SIGNAL_RE.test(new TextDecoder().decode(bytes));
}

/**
 * 检测 TUI 离开 alt screen 的序列（vim/less/htop 离开时，或多步 TUI 步骤切换时均可能发送）。
 * 不应用于立刻退出 full-terminal —— 见文件顶部说明。
 */
export function hasFullTerminalExitSignal(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  return FULL_TERMINAL_EXIT_SIGNAL_RE.test(new TextDecoder().decode(bytes));
}
