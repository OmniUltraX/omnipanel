export type ChecklistItem = {
  text: string;
  done: boolean;
};

export type ParsedChecklist = {
  title: string;
  items: ChecklistItem[];
};

const CHECK_ITEM_RE =
  /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.+?)\s*$/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*$/;

/**
 * 从助手回复中解析 Markdown 勾选列表（`- [ ]` / `- [x]`）。
 * 标题优先取首个标题行，否则用首条待办前的非空行，再否则用 fallbackTitle。
 */
export function parseMarkdownChecklist(
  markdown: string,
  fallbackTitle = "新待办列表",
): ParsedChecklist | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const items: ChecklistItem[] = [];
  let titleFromHeading: string | null = null;
  let titleBeforeItems: string | null = null;

  for (const line of lines) {
    const check = line.match(CHECK_ITEM_RE);
    if (check) {
      const text = (check[2] ?? "").trim();
      if (!text) continue;
      items.push({
        text,
        done: (check[1] ?? " ").toLowerCase() === "x",
      });
      continue;
    }

    if (items.length > 0) continue;

    const heading = line.match(HEADING_RE);
    if (heading) {
      const t = (heading[1] ?? "").trim();
      if (t) titleFromHeading = t;
      continue;
    }

    const plain = line.trim();
    if (
      plain &&
      !plain.startsWith("```") &&
      !/^[-*_]{3,}$/.test(plain)
    ) {
      titleBeforeItems = plain.replace(/^["「]|["」]$/g, "");
    }
  }

  if (items.length === 0) return null;

  const title =
    (titleFromHeading ?? titleBeforeItems ?? fallbackTitle).trim() || fallbackTitle;

  return { title, items };
}

/** 从消息 parts 拼出纯文本（仅 text part）。 */
export function textFromMessageParts(
  parts: ReadonlyArray<{ type: string; text?: string }>,
): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
}
