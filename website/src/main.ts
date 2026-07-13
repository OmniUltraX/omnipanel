import "./styles/main.css";

const REPO_URL = "https://github.com/anomalyco/omnipanel";

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

document.querySelectorAll<HTMLAnchorElement>("[data-repo-link]").forEach((el) => {
  el.href = REPO_URL;
});

document.querySelectorAll<HTMLAnchorElement>("[data-releases-link]").forEach((el) => {
  el.href = `${REPO_URL}/releases`;
});

setupSmoothScroll();
setupMobileNav();
setupFooterYear();
