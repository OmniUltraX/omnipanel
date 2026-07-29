/** 实机截图 3D 景深：指针倾斜 + 点击切换主画面 */

type Pose = "left" | "center" | "right";

const POSES: Pose[] = ["left", "center", "right"];

function poseClass(pose: Pose): string {
  return `shot--${pose}`;
}

export function setupShowcase() {
  const root = document.querySelector<HTMLElement>("[data-showcase]");
  const stage = document.querySelector<HTMLElement>("[data-showcase-stage]");
  if (!root || !stage) return;

  const shots = Array.from(stage.querySelectorAll<HTMLElement>("[data-shot]"));
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-shot-tab]"));
  if (shots.length < 3) return;

  let active = 1;
  let raf = 0;
  let targetX = 0;
  let targetY = 0;
  let currentX = 0;
  let currentY = 0;

  function applyLayout(centerIndex: number) {
    active = ((centerIndex % shots.length) + shots.length) % shots.length;
    // 左 / 中 / 右 环绕 active
    const order = [
      (active + shots.length - 1) % shots.length,
      active,
      (active + 1) % shots.length,
    ];

    shots.forEach((shot, i) => {
      const pose = POSES[order.indexOf(i)] ?? "center";
      shot.classList.remove("shot--left", "shot--center", "shot--right", "is-active");
      shot.classList.add(poseClass(pose));
      if (pose === "center") shot.classList.add("is-active");
    });

    tabs.forEach((tab) => {
      const idx = Number(tab.dataset.shotTab);
      tab.classList.toggle("is-active", idx === active);
    });
  }

  function tick() {
    currentX += (targetX - currentX) * 0.12;
    currentY += (targetY - currentY) * 0.12;
    const rx = currentY * -8;
    const ry = currentX * 14;
    stage.style.setProperty("--tilt-x", `${rx.toFixed(2)}deg`);
    stage.style.setProperty("--tilt-y", `${ry.toFixed(2)}deg`);
    raf = requestAnimationFrame(tick);
  }

  function onPointerMove(event: PointerEvent) {
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    targetX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    targetY = ((event.clientY - rect.top) / rect.height) * 2 - 1;
  }

  function onPointerLeave() {
    targetX = 0;
    targetY = 0;
  }

  shots.forEach((shot) => {
    shot.addEventListener("click", () => {
      const idx = Number(shot.dataset.shotIndex);
      if (Number.isNaN(idx) || idx === active) return;
      applyLayout(idx);
    });
  });

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const idx = Number(tab.dataset.shotTab);
      if (Number.isNaN(idx)) return;
      applyLayout(idx);
    });
  });

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduceMotion) {
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerleave", onPointerLeave);
    raf = requestAnimationFrame(tick);
  }

  applyLayout(active);

  return () => {
    cancelAnimationFrame(raf);
  };
}
