import { useEffect } from "react";
import { useI18n } from "../../i18n";
import { useSpaceConflictStore } from "../../stores/spaceConflictStore";

/** 冲突副本贴在资源旁边。丢掉的是本机没被采用的那一份，当前资源不动。 */
export function SpaceConflictMark({ path }: { path: string }) {
  const { t } = useI18n();
  const hit = useSpaceConflictStore((s) => s.byPath[path]);
  const dismiss = useSpaceConflictStore((s) => s.dismiss);
  if (!hit) return null;
  return (
    <span className="sidebar-tag-chip sidebar-conflict-mark" title={t("app.conflict.hint")}>
      {t("app.conflict.mark")}
      <button
        type="button"
        className="sidebar-conflict-mark__drop"
        onClick={(event) => {
          event.stopPropagation();
          void dismiss(hit.id);
        }}
      >
        {t("app.conflict.discard")}
      </button>
    </span>
  );
}

export function SpaceConflictHost() {
  const refresh = useSpaceConflictStore((s) => s.refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return null;
}
