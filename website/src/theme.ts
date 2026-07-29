export type ThemePref = "system" | "light" | "dark";

const STORAGE_KEY = "omnipanel-theme";

export function getThemePref(): ThemePref {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return "system";
}

export function resolveTheme(pref: ThemePref = getThemePref()): "light" | "dark" {
  if (pref === "light" || pref === "dark") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(pref: ThemePref = getThemePref()) {
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePref = pref;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "dark" ? "#0c1118" : "#f4f7fb");
}

export function setThemePref(pref: ThemePref) {
  localStorage.setItem(STORAGE_KEY, pref);
  applyTheme(pref);
  document.dispatchEvent(new CustomEvent("omnipanel:theme", { detail: { pref, resolved: resolveTheme(pref) } }));
}

/** 循环：跟随系统 → 亮色 → 暗色 */
export function cycleThemePref(): ThemePref {
  const order: ThemePref[] = ["system", "light", "dark"];
  const next = order[(order.indexOf(getThemePref()) + 1) % order.length]!;
  setThemePref(next);
  return next;
}

export function setupTheme() {
  applyTheme();

  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onSystem = () => {
    if (getThemePref() === "system") applyTheme("system");
  };
  mq.addEventListener("change", onSystem);

  document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]").forEach((btn) => {
    const sync = () => {
      const pref = getThemePref();
      btn.dataset.themePref = pref;
      btn.setAttribute(
        "aria-label",
        pref === "system" ? "Theme: system" : pref === "light" ? "Theme: light" : "Theme: dark",
      );
      const label = btn.querySelector("[data-theme-label]");
      if (label) {
        label.textContent = pref === "system" ? "Auto" : pref === "light" ? "Light" : "Dark";
      }
    };
    btn.addEventListener("click", () => {
      cycleThemePref();
      sync();
    });
    sync();
    document.addEventListener("omnipanel:theme", sync);
  });
}
