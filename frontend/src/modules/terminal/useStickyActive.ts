import { useEffect, useState, type RefObject } from "react";

/** 哨兵滚出 Feed 顶部时，判定吸顶布局已生效 */
export function useStickyActive(
  sentinel: HTMLElement | null,
  scrollRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): boolean {
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    const scrollRoot = scrollRef.current;
    if (!enabled || !sentinel || !scrollRoot) {
      setIsActive(false);
      return;
    }

    const check = () => {
      const rootTop = scrollRoot.getBoundingClientRect().top;
      const sentinelTop = sentinel.getBoundingClientRect().top;
      setIsActive(sentinelTop < rootTop - 0.5);
    };

    check();
    scrollRoot.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);

    const observer = new ResizeObserver(check);
    observer.observe(scrollRoot);
    observer.observe(sentinel);

    return () => {
      scrollRoot.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
      observer.disconnect();
    };
  }, [enabled, scrollRef, sentinel]);

  return isActive;
}
