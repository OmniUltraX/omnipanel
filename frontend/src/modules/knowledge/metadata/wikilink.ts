/** Obsidian 子集：`[[Note]]` / `[[Note|别名]]` / `[[Note#Heading]]` */

export type ParsedWikilink = {
  /** 原始完整匹配，含括号 */
  raw: string;
  targetTitle: string;
  heading?: string;
  alias?: string;
  /** 在正文中的起始下标 */
  index: number;
};

const WIKILINK_RE = /\[\[([^\]\n|#]+)(?:#([^\]\n|]+))?(?:\|([^\]\n]+))?\]\]/g;

export function parseWikilinks(markdown: string): ParsedWikilink[] {
  const out: ParsedWikilink[] = [];
  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(markdown)) !== null) {
    const targetTitle = match[1]?.trim() ?? "";
    if (!targetTitle) continue;
    const heading = match[2]?.trim() || undefined;
    const alias = match[3]?.trim() || undefined;
    out.push({
      raw: match[0],
      targetTitle,
      heading,
      alias,
      index: match.index,
    });
  }
  return out;
}

export function wikilinkDisplayText(link: Pick<ParsedWikilink, "targetTitle" | "heading" | "alias">): string {
  if (link.alias) return link.alias;
  if (link.heading) return `${link.targetTitle} › ${link.heading}`;
  return link.targetTitle;
}

/** 编辑器内可点击链接协议：knowledge://id/{id} 或 knowledge://missing/{title} */
export const KNOWLEDGE_LINK_SCHEME = "knowledge://";

export function knowledgeLinkHref(entryId: string | null, title: string, heading?: string): string {
  const base = entryId
    ? `${KNOWLEDGE_LINK_SCHEME}id/${encodeURIComponent(entryId)}`
    : `${KNOWLEDGE_LINK_SCHEME}missing/${encodeURIComponent(title)}`;
  return heading ? `${base}#${encodeURIComponent(heading)}` : base;
}

export function parseKnowledgeLinkHref(href: string): {
  entryId: string | null;
  missingTitle: string | null;
  heading: string | null;
} | null {
  if (!href.startsWith(KNOWLEDGE_LINK_SCHEME)) return null;
  const rest = href.slice(KNOWLEDGE_LINK_SCHEME.length);
  const [pathPart, hashPart] = rest.split("#");
  const heading = hashPart ? decodeURIComponent(hashPart) : null;
  if (pathPart.startsWith("id/")) {
    return {
      entryId: decodeURIComponent(pathPart.slice(3)),
      missingTitle: null,
      heading,
    };
  }
  if (pathPart.startsWith("missing/")) {
    return {
      entryId: null,
      missingTitle: decodeURIComponent(pathPart.slice(8)),
      heading,
    };
  }
  return null;
}

export type TitleResolver = (title: string) => string | null;

/** 将 `[[...]]` 转为标准 Markdown 链接，供 Crepe 渲染 */
export function wikilinksToMarkdownLinks(markdown: string, resolveTitle: TitleResolver): string {
  return markdown.replace(WIKILINK_RE, (_raw, title: string, heading?: string, alias?: string) => {
    const targetTitle = title.trim();
    const h = heading?.trim();
    const a = alias?.trim();
    const id = resolveTitle(targetTitle);
    const href = knowledgeLinkHref(id, targetTitle, h || undefined);
    const text = wikilinkDisplayText({
      targetTitle,
      heading: h || undefined,
      alias: a || undefined,
    });
    return `[${text}](${href})`;
  });
}

/** 将 knowledge:// Markdown 链接还原为 `[[...]]` 再保存 */
export function markdownLinksToWikilinks(markdown: string, idToTitle: (id: string) => string | null): string {
  return markdown.replace(
    /\[([^\]]*)\]\((knowledge:\/\/[^)\s]+)\)/g,
    (_raw, text: string, href: string) => {
      const parsed = parseKnowledgeLinkHref(href);
      if (!parsed) return _raw;
      if (parsed.entryId) {
        const title = idToTitle(parsed.entryId) ?? text;
        const heading = parsed.heading ? `#${parsed.heading}` : "";
        const alias = text && text !== title && text !== `${title} › ${parsed.heading ?? ""}` ? `|${text}` : "";
        if (alias && parsed.heading) {
          return `[[${title}#${parsed.heading}|${text}]]`;
        }
        if (alias) return `[[${title}|${text}]]`;
        return `[[${title}${heading}]]`;
      }
      if (parsed.missingTitle) {
        const heading = parsed.heading ? `#${parsed.heading}` : "";
        const alias = text && text !== parsed.missingTitle ? `|${text}` : "";
        if (alias && parsed.heading) {
          return `[[${parsed.missingTitle}#${parsed.heading}|${text}]]`;
        }
        if (alias) return `[[${parsed.missingTitle}|${text}]]`;
        return `[[${parsed.missingTitle}${heading}]]`;
      }
      return _raw;
    },
  );
}

/** 本地资产协议 knowledge-asset://{entryId}/{fileName} */
export const KNOWLEDGE_ASSET_SCHEME = "knowledge-asset://";

export function knowledgeAssetHref(entryId: string, fileName: string): string {
  return `${KNOWLEDGE_ASSET_SCHEME}${encodeURIComponent(entryId)}/${encodeURIComponent(fileName)}`;
}

export function parseKnowledgeAssetHref(href: string): { entryId: string; fileName: string } | null {
  if (!href.startsWith(KNOWLEDGE_ASSET_SCHEME)) return null;
  const rest = href.slice(KNOWLEDGE_ASSET_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  return {
    entryId: decodeURIComponent(rest.slice(0, slash)),
    fileName: decodeURIComponent(rest.slice(slash + 1)),
  };
}
