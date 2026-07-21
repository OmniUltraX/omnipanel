/** 从单模块 ContextProvider 文本中提取现场条芯片标签。 */
export function parseModuleContextChipLabel(text: string): string | null {
  const sections = text.split(/\n---\n|\n## /);
  for (const raw of sections) {
    const section = raw.replace(/^#+\s*/, "").trimStart();
    const title =
      section.match(/^(Docker|数据库|文件|SSH|终端)[^\n]*/)?.[0] ??
      section.match(/^\[Terminal Context\]/)?.[0];
    if (!title) continue;
    const conn =
      section.match(/连接名称[：:]\s*(.+)/)?.[1]?.trim() ||
      section.match(/连接 ID[：:]\s*(.+)/)?.[1]?.trim() ||
      section.match(/主机[：:]\s*(.+)/)?.[1]?.trim() ||
      section.match(/Host:\s*(.+)/i)?.[1]?.trim();
    const extra =
      section.match(/当前数据库[：:]\s*(.+)/)?.[1]?.trim() ||
      section.match(/容器名称[：:]\s*(.+)/)?.[1]?.trim() ||
      section.match(/当前路径[：:]\s*(.+)/)?.[1]?.trim() ||
      section.match(/Working directory:\s*(.+)/i)?.[1]?.trim() ||
      section.match(/地址[：:]\s*(.+)/)?.[1]?.trim();
    const label = [title.replace(/^#+ /, "").replace(/^\[|\]$/g, ""), conn, extra]
      .filter(Boolean)
      .join(" · ");
    if (label) return label;
  }
  return null;
}
