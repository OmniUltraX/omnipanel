/** Parser 在语句尚未写完、光标仍位于该语句内时的典型报错。 */
export function isIncompleteAtEndParseError(message: string): boolean {
  return /end of input found/i.test(message);
}

/** 光标是否仍位于当前语句范围内（含末尾，表示用户正在输入）。 */
export function isCursorInStatement(cursor: number, partFrom: number, partTo: number): boolean {
  return cursor >= partFrom && cursor <= partTo;
}

export function shouldSuppressParseErrorWhileTyping(
  parseError: string,
  cursor: number,
  partFrom: number,
  partTo: number,
): boolean {
  return isIncompleteAtEndParseError(parseError) && isCursorInStatement(cursor, partFrom, partTo);
}
