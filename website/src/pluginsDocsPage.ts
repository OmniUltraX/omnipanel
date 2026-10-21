import "./styles/main.css";
import { setupSiteChrome } from "./site";

setupSiteChrome();

// 文档页 TOC：滚动时高亮当前章节
const tocLinks = Array.from(
  document.querySelectorAll<HTMLAnchorElement>("[data-docs-toc] a[href^='#']"),
);
const sections = tocLinks
  .map((link) => {
    const id = link.getAttribute("href")?.slice(1);
    if (!id) return null;
    const el = document.getElementById(id);
    return el ? { id, el, link } : null;
  })
  .filter((x): x is { id: string; el: HTMLElement; link: HTMLAnchorElement } => Boolean(x));

if (sections.length && "IntersectionObserver" in window) {
  const visible = new Set<string>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).id;
        if (entry.isIntersecting) visible.add(id);
        else visible.delete(id);
      }
      const activeId =
        sections.map((s) => s.id).find((id) => visible.has(id)) ?? sections[0]?.id;
      for (const s of sections) {
        s.link.classList.toggle("is-active", s.id === activeId);
      }
    },
    { rootMargin: "-20% 0px -60% 0px", threshold: 0.01 },
  );
  sections.forEach((s) => observer.observe(s.el));
}
