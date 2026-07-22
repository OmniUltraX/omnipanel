import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useI18n } from "../../i18n";
import { buildCrepeFeatureConfigs } from "./crepeBlockEditI18n";
import { getKnowledgeCodeMirrorLanguages } from "./knowledgeCodeMirrorLangs";
import { bindKnowledgeCodePlaceholderHighlight } from "./knowledgeCodePlaceholderHighlight";
import {
  KNOWLEDGE_LINK_SCHEME,
  markdownLinksToWikilinks,
  parseKnowledgeAssetHref,
  parseKnowledgeLinkHref,
  wikilinksToMarkdownLinks,
} from "./metadata/wikilink";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/classic.css";
import "./knowledgeCrepe.css";

const MARKDOWN_CHANGE_DEBOUNCE_MS = 280;

export type KnowledgeLinkNavigate = {
  entryId: string | null;
  missingTitle: string | null;
  heading: string | null;
  clientX: number;
  clientY: number;
  openMode: "preview" | "permanent";
};

interface KnowledgeCrepeEditorProps {
  entryId: string;
  defaultContent: string;
  placeholder: string;
  resolveTitleToId?: (title: string) => string | null;
  idToTitle?: (id: string) => string | null;
  onChange: (markdown: string) => void;
  onNavigateLink?: (nav: KnowledgeLinkNavigate) => void;
  onHoverLink?: (nav: KnowledgeLinkNavigate | null) => void;
  jumpHeadingText?: string | null;
  onJumpHeadingHandled?: () => void;
}

function assetToDisplayMarkdown(markdown: string, pathCache: Map<string, string>): string {
  return markdown.replace(
    /!\[([^\]]*)\]\((knowledge-asset:\/\/[^)\s]+)\)/g,
    (raw, alt: string, href: string) => {
      const parsed = parseKnowledgeAssetHref(href);
      if (!parsed) return raw;
      const key = `${parsed.entryId}/${parsed.fileName}`;
      const display = pathCache.get(key);
      if (!display) return raw;
      return `![${alt}](${display})`;
    },
  );
}

function displayToAssetMarkdown(markdown: string, reverseCache: Map<string, string>): string {
  let next = markdown;
  for (const [display, assetHref] of reverseCache) {
    next = next.split(display).join(assetHref);
  }
  return next;
}

async function buildAssetDisplayMaps(
  markdown: string,
): Promise<{ pathCache: Map<string, string>; reverseCache: Map<string, string> }> {
  const pathCache = new Map<string, string>();
  const reverseCache = new Map<string, string>();
  const re = /!\[[^\]]*\]\((knowledge-asset:\/\/[^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  const jobs: Promise<void>[] = [];
  while ((match = re.exec(markdown)) !== null) {
    const href = match[1];
    const parsed = parseKnowledgeAssetHref(href);
    if (!parsed) continue;
    const key = `${parsed.entryId}/${parsed.fileName}`;
    if (pathCache.has(key)) continue;
    jobs.push(
      unwrapCommand(commands.knowledgeAssetPath(parsed.entryId, parsed.fileName))
        .then((abs) => {
          const src = convertFileSrc(abs);
          pathCache.set(key, src);
          reverseCache.set(src, href);
        })
        .catch(() => {
          /* keep unresolved */
        }),
    );
  }
  await Promise.all(jobs);
  return { pathCache, reverseCache };
}

function CrepeEditorMount({
  entryId,
  defaultContent,
  placeholder,
  reverseAssetRef,
  idToTitleRef,
  onChangeRef,
}: {
  entryId: string;
  defaultContent: string;
  placeholder: string;
  reverseAssetRef: MutableRefObject<Map<string, string>>;
  idToTitleRef: MutableRefObject<(id: string) => string | null>;
  onChangeRef: MutableRefObject<(markdown: string) => void>;
}) {
  const { t, locale } = useI18n();
  const skipInitialUpdateRef = useRef(true);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEditor((root) => {
    skipInitialUpdateRef.current = true;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    const featureConfigs = buildCrepeFeatureConfigs(t);

    const crepe = new Crepe({
      root,
      defaultValue: defaultContent,
      features: {
        [CrepeFeature.TopBar]: false,
        [CrepeFeature.AI]: false,
        [CrepeFeature.Latex]: false,
      },
      featureConfigs: {
        ...featureConfigs,
        [CrepeFeature.Placeholder]: {
          text: placeholder,
          mode: "block",
        },
        [CrepeFeature.CodeMirror]: {
          ...featureConfigs[CrepeFeature.CodeMirror],
          languages: getKnowledgeCodeMirrorLanguages(),
        },
      },
    });

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        if (skipInitialUpdateRef.current) {
          skipInitialUpdateRef.current = false;
          return;
        }
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(() => {
          debounceTimerRef.current = null;
          const withAssets = displayToAssetMarkdown(markdown, reverseAssetRef.current);
          const withWikilinks = markdownLinksToWikilinks(withAssets, (id) =>
            idToTitleRef.current(id),
          );
          onChangeRef.current(withWikilinks);
        }, MARKDOWN_CHANGE_DEBOUNCE_MS);
      });
    });

    const destroy = crepe.destroy.bind(crepe);
    crepe.destroy = ((...args: Parameters<typeof destroy>) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      return destroy(...args);
    }) as typeof crepe.destroy;

    return crepe;
  }, [entryId, locale, defaultContent]);

  return <Milkdown />;
}

function CrepeEditorInner(props: KnowledgeCrepeEditorProps) {
  const {
    entryId,
    defaultContent,
    placeholder,
    resolveTitleToId = () => null,
    idToTitle = () => null,
    onChange,
    jumpHeadingText,
    onJumpHeadingHandled,
  } = props;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const resolveRef = useRef(resolveTitleToId);
  resolveRef.current = resolveTitleToId;
  const idToTitleRef = useRef(idToTitle);
  idToTitleRef.current = idToTitle;
  const reverseAssetRef = useRef(new Map<string, string>());
  const [editorContent, setEditorContent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEditorContent(null);
    void (async () => {
      const withWikilinks = wikilinksToMarkdownLinks(defaultContent, (title) =>
        resolveRef.current(title),
      );
      const maps = await buildAssetDisplayMaps(withWikilinks);
      if (cancelled) return;
      reverseAssetRef.current = maps.reverseCache;
      setEditorContent(assetToDisplayMarkdown(withWikilinks, maps.pathCache));
    })();
    return () => {
      cancelled = true;
    };
    // 仅在挂载 / entry 切换时初始化；正文编辑由内部 onChange 回写，避免重置光标
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId]);

  useEffect(() => {
    if (!jumpHeadingText) return;
    const root = document.querySelector(".knowledge-crepe-shell .ProseMirror");
    if (!root) return;
    const headings = root.querySelectorAll("h1,h2,h3,h4,h5,h6");
    for (const node of headings) {
      if ((node.textContent ?? "").trim() === jumpHeadingText.trim()) {
        node.scrollIntoView({ behavior: "smooth", block: "start" });
        break;
      }
    }
    onJumpHeadingHandled?.();
  }, [jumpHeadingText, onJumpHeadingHandled]);

  if (editorContent == null) {
    return <div className="knowledge-crepe-loading" />;
  }

  return (
    <CrepeEditorMount
      entryId={entryId}
      defaultContent={editorContent}
      placeholder={placeholder}
      reverseAssetRef={reverseAssetRef}
      idToTitleRef={idToTitleRef}
      onChangeRef={onChangeRef}
    />
  );
}

export function KnowledgeCrepeEditor(props: KnowledgeCrepeEditorProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const navigateRef = useRef(props.onNavigateLink);
  navigateRef.current = props.onNavigateLink;
  const hoverRef = useRef(props.onHoverLink);
  hoverRef.current = props.onHoverLink;

  useEffect(() => {
    const root = shellRef.current;
    if (!root) return;
    return bindKnowledgeCodePlaceholderHighlight(root);
  }, [props.entryId]);

  useEffect(() => {
    const root = shellRef.current;
    if (!root) return;

    const resolveFromAnchor = (anchor: HTMLAnchorElement) => {
      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith(KNOWLEDGE_LINK_SCHEME)) return null;
      return parseKnowledgeLinkHref(href);
    };

    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      const parsed = resolveFromAnchor(anchor);
      if (!parsed) return;
      event.preventDefault();
      event.stopPropagation();
      navigateRef.current?.({
        ...parsed,
        clientX: event.clientX,
        clientY: event.clientY,
        openMode: event.metaKey || event.ctrlKey ? "permanent" : "preview",
      });
    };

    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    const onOver = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      const parsed = resolveFromAnchor(anchor);
      if (!parsed) return;
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        hoverRef.current?.({
          ...parsed,
          clientX: event.clientX,
          clientY: event.clientY,
          openMode: "preview",
        });
      }, 280);
    };
    const onOut = (event: MouseEvent) => {
      const related = event.relatedTarget as HTMLElement | null;
      if (related?.closest?.(".knowledge-hover-preview")) return;
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverRef.current?.(null);
    };

    root.addEventListener("click", onClick);
    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseout", onOut);
    return () => {
      root.removeEventListener("click", onClick);
      root.removeEventListener("mouseover", onOver);
      root.removeEventListener("mouseout", onOut);
      if (hoverTimer) clearTimeout(hoverTimer);
    };
  }, [props.entryId]);

  return (
    <div ref={shellRef} className="knowledge-crepe-shell">
      <MilkdownProvider>
        <CrepeEditorInner {...props} />
      </MilkdownProvider>
    </div>
  );
}
