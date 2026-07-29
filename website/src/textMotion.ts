/** 标题拆字/拆词动效；语言切换后重建 */

const REDUCE = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function clearSplit(el: HTMLElement) {
  if (el.dataset.splitSource) {
    el.textContent = el.dataset.splitSource;
    delete el.dataset.splitSource;
    el.classList.remove("is-split", "is-split-ready");
  }
}

function splitElement(el: HTMLElement) {
  const mode = el.dataset.split || "words";
  const source = (el.dataset.splitSource ?? el.textContent ?? "").trim();
  if (!source) return;

  el.dataset.splitSource = source;
  el.classList.add("is-split");
  el.setAttribute("aria-label", source);
  el.textContent = "";

  if (mode === "chars") {
    // 中文按字、英文按字符；空格保留
    const parts = Array.from(source);
    parts.forEach((ch, i) => {
      if (ch === " ") {
        el.appendChild(document.createTextNode(" "));
        return;
      }
      const span = document.createElement("span");
      span.className = "split-ch";
      span.style.setProperty("--i", String(i));
      span.textContent = ch;
      el.appendChild(span);
    });
  } else {
    // 空格分词；中文整句无空格时按字
    const hasSpace = /\s/.test(source);
    const parts = hasSpace ? source.split(/(\s+)/) : Array.from(source);
    let i = 0;
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        el.appendChild(document.createTextNode(part));
        continue;
      }
      const span = document.createElement("span");
      span.className = hasSpace ? "split-word" : "split-ch";
      span.style.setProperty("--i", String(i));
      span.textContent = part;
      el.appendChild(span);
      i += 1;
    }
  }

  // 下一帧触发，保证 transition 生效
  requestAnimationFrame(() => {
    el.classList.add("is-split-ready");
  });
}

function prepareSplits() {
  document.querySelectorAll<HTMLElement>("[data-split]").forEach((el) => {
    clearSplit(el);
    if (!REDUCE()) splitElement(el);
  });
}

function setupRevealStagger() {
  document.querySelectorAll<HTMLElement>("[data-reveal]").forEach((block) => {
    const kids = block.querySelectorAll<HTMLElement>(
      ":scope > .eyebrow, :scope > .h1, :scope > .h2, :scope > .lead, :scope > .hero-cta, :scope > .pill-row, :scope > .section-head > *",
    );
    kids.forEach((kid, i) => {
      kid.style.setProperty("--reveal-i", String(i));
      kid.classList.add("reveal-child");
    });
  });
}

function setupContactQrTilt() {
  const stage = document.querySelector<HTMLElement>("[data-contact-qr]");
  if (!stage || REDUCE()) return;

  stage.addEventListener("pointermove", (event) => {
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    stage.style.setProperty("--qr-tilt-x", `${(-y * 8).toFixed(2)}deg`);
    stage.style.setProperty("--qr-tilt-y", `${(x * 12).toFixed(2)}deg`);
  });

  stage.addEventListener("pointerleave", () => {
    stage.style.setProperty("--qr-tilt-x", "0deg");
    stage.style.setProperty("--qr-tilt-y", "0deg");
  });
}

export function setupTextMotion() {
  prepareSplits();
  setupRevealStagger();
  setupContactQrTilt();

  document.addEventListener("omnipanel:locale", () => {
    // i18n 已写回纯文本，重新拆分
    requestAnimationFrame(() => {
      prepareSplits();
      setupRevealStagger();
    });
  });
}
