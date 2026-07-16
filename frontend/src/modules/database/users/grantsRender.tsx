import type { GrantSummaryLine } from "./grantsLoader";

function privilegeTokens(detail: string): { head: string; privs: string } | null {
  const idx = detail.indexOf(" — ");
  if (idx < 0) return null;
  return { head: detail.slice(0, idx), privs: detail.slice(idx + 3) };
}

/** 彩色授权摘要行 */
export function GrantsSummaryView({
  lines,
  emptyText,
  onRevoke,
  revokeLabel,
}: {
  lines: GrantSummaryLine[];
  emptyText: string;
  onRevoke?: (line: GrantSummaryLine) => void;
  revokeLabel?: string;
}) {
  if (lines.length === 0) {
    return <div className="db-users-grants-empty">{emptyText}</div>;
  }

  return (
    <div className="db-users-grants-summary" role="list">
      {lines.map((line) => {
        const split = privilegeTokens(line.detail);
        return (
          <div key={line.id} className="db-users-grants-line" role="listitem">
            <span className={`db-users-grants-label db-users-grants-label--${line.kind}`}>
              {line.label}
            </span>
            <span className="db-users-grants-sep">:</span>
            {split ? (
              <>
                <span className="db-users-grants-target">{split.head}</span>
                <span className="db-users-grants-sep"> — </span>
                <span className="db-users-grants-privs">{split.privs}</span>
              </>
            ) : (
              <span className="db-users-grants-detail">{line.detail}</span>
            )}
            {onRevoke && line.revokePrivileges && line.revokeScope ? (
              <button
                type="button"
                className="db-users-grants-revoke"
                onClick={() => onRevoke(line)}
              >
                {revokeLabel ?? "Revoke"}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
