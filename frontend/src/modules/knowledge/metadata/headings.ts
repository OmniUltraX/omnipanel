export type ParsedHeading = {
  level: number;
  text: string;
  /** 0-based line index */
  line: number;
  /** 在全文中的字符偏移 */
  index: number;
};

/** 解析 ATX 标题（# … ######），忽略代码块内的 # */
export function parseHeadings(markdown: string): ParsedHeading[] {
  const lines = markdown.split(/\r?\n/);
  const out: ParsedHeading[] = [];
  let inFence = false;
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = line.match(/^(`{3,}|~{3,})/);
    if (fence) {
      inFence = !inFence;
    } else if (!inFence) {
      const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (m) {
        out.push({
          level: m[1].length,
          text: m[2].trim(),
          line: i,
          index: offset,
        });
      }
    }
    offset += line.length + 1;
  }
  return out;
}

export function headingSlug(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, "-");
}
