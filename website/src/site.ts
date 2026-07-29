const REPO_URL = "https://github.com/OmniUltraX/omnipanel";

export function downloadPageHref(): string {
  return new URL("download.html", window.location.href).href;
}

export function setupSiteChrome() {
  document.querySelectorAll<HTMLAnchorElement>("[data-repo-link]").forEach((el) => {
    el.href = REPO_URL;
  });

  document.querySelectorAll<HTMLAnchorElement>("[data-download-link]").forEach((el) => {
    el.href = downloadPageHref();
  });

  document.querySelectorAll<HTMLAnchorElement>("[data-license-link]").forEach((el) => {
    el.href = `${REPO_URL}/blob/master/LICENSE`;
  });

  setupSmoothScroll();
  setupMobileNav();
  setupFooterYear();
  setupReveal();
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
