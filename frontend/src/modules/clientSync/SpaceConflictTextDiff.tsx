import { useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { buildDiffRows, type DiffViewRow, type TextSpan } from "./spaceConflictDiff";

function Spans({ spans }: { spans: TextSpan[] }) {
  return (
    <>
      {spans.map((span, index) =>
        span.mark ? <mark key={index}>{span.text}</mark> : <span key={index}>{span.text}</span>,
      )}
    </>
  );
}

function Line({
  no,
  kind,
  side,
  children,
}: {
  no?: number;
  kind: "ctx" | "del" | "add" | "edit" | "empty";
  side: "left" | "right";
  children?: ReactNode;
}) {
  return (
    <div className={`space-conflict-line space-conflict-line--${kind} space-conflict-line--${side}`}>
      <span className="space-conflict-line__no">{no ?? ""}</span>
      <span className="space-conflict-line__text">{children}</span>
    </div>
  );
}

function Row({ row }: { row: DiffViewRow }) {
  if (row.kind === "gap") return null;
  if (row.kind === "ctx") {
    return (
      <>
        <Line no={row.leftNo} kind="ctx" side="left">{row.text || " "}</Line>
        <Line no={row.rightNo} kind="ctx" side="right">{row.text || " "}</Line>
      </>
    );
  }
  if (row.kind === "del") {
    return (
      <>
        <Line no={row.leftNo} kind="del" side="left">{row.text || " "}</Line>
        <Line kind="empty" side="right" />
      </>
    );
  }
  if (row.kind === "add") {
    return (
      <>
        <Line kind="empty" side="left" />
        <Line no={row.rightNo} kind="add" side="right">{row.text || " "}</Line>
      </>
    );
  }
  return (
    <>
      <Line no={row.leftNo} kind="edit" side="left"><Spans spans={row.left} /></Line>
      <Line no={row.rightNo} kind="edit" side="right"><Spans spans={row.right} /></Line>
    </>
  );
}

/** 左右两栏的行 diff。相同的大段先折叠，点开再展开。 */
export function SpaceConflictTextDiff({
  current,
  saved,
}: {
  current: string;
  saved: string;
}) {
  const { t } = useI18n();
  const rows = useMemo(() => buildDiffRows(current, saved), [current, saved]);
  const [openGaps, setOpenGaps] = useState<Set<number>>(() => new Set());

  return (
    <div className="space-conflict-split">
      <div className="space-conflict-split__head space-conflict-split__head--current">
        {t("app.conflict.current")}
      </div>
      <div className="space-conflict-split__head space-conflict-split__head--saved">
        {t("app.conflict.saved")}
      </div>
      {rows.map((row, index) => {
        if (row.kind === "gap") {
          const open = openGaps.has(index);
          return (
            <div key={`gap-${index}`} className="space-conflict-split__gap">
              <button
                type="button"
                onClick={() =>
                  setOpenGaps((prev) => {
                    const next = new Set(prev);
                    if (next.has(index)) next.delete(index);
                    else next.add(index);
                    return next;
                  })
                }
              >
                {open
                  ? t("app.conflict.hideSameLines", { count: row.count })
                  : t("app.conflict.showSameLines", { count: row.count })}
              </button>
              {open ? (
                <div className="space-conflict-split__rows">
                  {row.rows.map((hidden, hiddenIndex) => (
                    <Row key={hiddenIndex} row={hidden} />
                  ))}
                </div>
              ) : null}
            </div>
          );
        }
        return <Row key={index} row={row} />;
      })}
    </div>
  );
}
