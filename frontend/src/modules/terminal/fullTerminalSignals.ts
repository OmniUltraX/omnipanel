const FULL_TERMINAL_SIGNAL_RE =
  /\x1b\[\?(?:1049|1047|47)h|\x1b\[\?(?:1000|1002|1003|1006)h|\x1b\[[0-9]+;[0-9]+[Hf]/;

export function hasFullTerminalSignal(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  return FULL_TERMINAL_SIGNAL_RE.test(new TextDecoder().decode(bytes));
}
