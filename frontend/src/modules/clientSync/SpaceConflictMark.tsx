import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { useSpaceConflictStore } from "../../stores/spaceConflictStore";
import { SpaceConflictCompare } from "./SpaceConflictCompare";
import { SpaceConflictOverview } from "./SpaceConflictOverview";
import "./SpaceConflictMark.css";

/** 资源旁边只留一颗红色「冲突」，点开对比。批量处理在总览里。 */
export function SpaceConflictMark({ path }: { path: string }) {
  const { t } = useI18n();
  const hit = useSpaceConflictStore((s) => s.byPath[path]);
  const [open, setOpen] = useState(false);
  if (!hit) return null;
  return (
    <span className="space-conflict-mark" title={t("app.conflict.hint")}>
      <button
        type="button"
        className="sidebar-tag-chip space-conflict-mark__open"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        {t("app.conflict.mark")}
      </button>
      {open ? <SpaceConflictCompare id={hit.id} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

export function SpaceConflictHost() {
  const refresh = useSpaceConflictStore((s) => s.refresh);
  const overviewOpen = useSpaceConflictStore((s) => s.overviewOpen);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return overviewOpen ? <SpaceConflictOverview /> : null;
}
