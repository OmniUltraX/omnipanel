export interface SqlErrorUnderline {
  from: number;
  to: number;
}

export interface SqlRepairNote {
  /** 这次解读属于哪条结果，切换历史或重新执行后不再显示。 */
  sessionId: string;
  text: string;
  sql: string | null;
}

let repairNote: SqlRepairNote | null = null;
const repairListeners = new Set<() => void>();

export function setSqlRepairNote(note: SqlRepairNote | null) {
  repairNote = note;
  for (const listener of repairListeners) listener();
}

export function subscribeSqlRepairNote(listener: () => void): () => void {
  repairListeners.add(listener);
  return () => repairListeners.delete(listener);
}

export function readSqlRepairNote(): SqlRepairNote | null {
  return repairNote;
}

let applyRepair: ((sql: string) => void) | null = null;

export function registerSqlRepairApply(apply: (sql: string) => void): () => void {
  applyRepair = apply;
  return () => {
    if (applyRepair === apply) applyRepair = null;
  };
}

export function applySqlRepair(sql: string) {
  applyRepair?.(sql);
  setSqlRepairNote(null);
}

const WRAP_MARK = "__omnipanel_wrap__";

/** 把分页包装从报错里剥掉。包装自己造成的冲突改成人话，不再甩给用户原文。 */
export function presentSqlExecError(raw: string): string {
  if (!raw.includes(WRAP_MARK)) return raw;
  return "分页包装和语句末尾的 LIMIT 撞上了。语句本身已有行数限制，已改为不再套一层子查询。重新执行即可。";
}

function unwrapSentSql(sent: string): string {
  const marker = `) AS ${WRAP_MARK}`;
  const start = sent.indexOf("SELECT * FROM (");
  const end = sent.indexOf(marker);
  if (start < 0 || end < 0 || end <= start) return sent;
  return sent.slice(start + "SELECT * FROM (".length, end);
}

/** MySQL `near '…'` 对得上用户原文时返回区间；片段只存在于包装里则不标。 */
export function sqlErrorUnderline(userSql: string, rawError: string): SqlErrorUnderline | null {
  const near = rawError.match(/near '([^']+)'/i);
  if (!near?.[1]) return null;
  const snippet = near[1];
  if (snippet.includes(WRAP_MARK)) return null;
  const source = unwrapSentSql(userSql);
  const at = source.indexOf(snippet);
  if (at < 0) return null;
  const base = userSql.indexOf(source);
  const from = (base < 0 ? 0 : base) + at;
  return { from, to: from + snippet.length };
}
