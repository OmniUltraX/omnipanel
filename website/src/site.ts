import { setupI18n } from "./i18n";
import { setupTextMotion } from "./textMotion";
import { setupTheme } from "./theme";

const REPO_URL = "https://github.com/OmniUltraX/omnipanel";
const REPO_API = "https://api.github.com/repos/OmniUltraX/omnipanel";
const STARS_CACHE_KEY = "omnipanel-gh-stars";
const STARS_CACHE_MS = 60 * 60 * 1000;

export function downloadSectionHref(): string {
  return new URL("#download", window.location.href.split("#")[0]).href;
}

export function setupSiteChrome() {
  setupTheme();
  setupI18n();

  document.querySelectorAll<HTMLAnchorElement>("[data-repo-link]").forEach((el) => {
    el.href = REPO_URL;
  });

  document.querySelectorAll<HTMLAnchorElement>("[data-download-link]").forEach((el) => {
    el.href = downloadSectionHref();
  });

  document.querySelectorAll<HTMLAnchorElement>("[data-license-link]").forEach((el) => {
    el.href = `${REPO_URL}/blob/master/LICENSE`;
  });

  setupSmoothScroll();
  setupMobileNav();
  setupFooterYear();
  setupReveal();
  setupTextMotion();
  void setupGithubStars();
}

function formatStarCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}

function readStarsCache(): number | null {
  try {
    const raw = sessionStorage.getItem(STARS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { count: number; at: number };
    if (typeof parsed.count !== "number" || Date.now() - parsed.at > STARS_CACHE_MS) return null;
    return parsed.count;
  } catch {
    return null;
  }
}

function writeStarsCache(count: number) {
  try {
    sessionStorage.setItem(STARS_CACHE_KEY, JSON.stringify({ count, at: Date.now() }));
  } catch {
    /* ignore */
  }
}

async function setupGithubStars() {
  const nodes = document.querySelectorAll<HTMLElement>("[data-star-count]");
  if (!nodes.length) return;

  const paint = (count: number) => {
    const text = formatStarCount(count);
    nodes.forEach((el) => {
      el.textContent = text;
    });
    document.querySelectorAll<HTMLElement>("[data-github-stars]").forEach((el) => {
      el.title = `${count.toLocaleString()} stars on GitHub`;
    });
  };

  const cached = readStarsCache();
  if (cached != null) paint(cached);

  try {
    const res = await fetch(REPO_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { stargazers_count?: number };
    if (typeof data.stargazers_count !== "number") return;
    writeStarsCache(data.stargazers_count);
    paint(data.stargazers_count);
  } catch {
    if (cached == null) {
      nodes.forEach((el) => {
        el.textContent = "★";
      });
    }
  }
}

function setupSmoothScroll() {
  document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener("click", (event) => {
      const id = anchor.getAttribute("href");
      if (!id || id === "#") return;
      const target = document.querySelector(id);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      history.pushState(null, "", id);
    });
  });
}

function setupMobileNav() {
  const toggle = document.querySelector<HTMLButtonElement>("[data-nav-toggle]");
  const nav = document.querySelector<HTMLElement>("[data-nav-menu]");
  if (!toggle || !nav) return;

  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });
}

function setupFooterYear() {
  const year = document.querySelector("[data-year]");
  if (year) year.textContent = String(new Date().getFullYear());
}

function setupReveal() {
  const nodes = document.querySelectorAll<HTMLElement>("[data-reveal]");
  if (!nodes.length) return;

  if (!("IntersectionObserver" in window)) {
    nodes.forEach((el) => el.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
  );

  nodes.forEach((el) => observer.observe(el));
}
