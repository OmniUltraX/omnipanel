export type LineOp =
  | { type: "equal"; text: string }
  | { type: "delete"; text: string }
  | { type: "insert"; text: string };

export type TextSpan = { text: string; mark: boolean };

export type DiffViewRow =
  | { kind: "ctx"; leftNo: number; rightNo: number; text: string }
  | { kind: "del"; leftNo: number; text: string }
  | { kind: "add"; rightNo: number; text: string }
  | { kind: "edit"; leftNo: number; rightNo: number; left: TextSpan[]; right: TextSpan[] }
  | { kind: "gap"; count: number; rows: DiffViewRow[] };

const CONTEXT = 3;
const CELL_LIMIT = 1_200_000;

export function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/** 行级 Myers。两边很像时只跟着改动走，适合打开一份冲突正文。 */
export function diffLines(before: string[], after: string[]): LineOp[] {
  if (before.length * after.length > CELL_LIMIT) return myersDiff(before, after);
  return lcsDiff(before, after);
}

export function buildDiffRows(current: string, saved: string): DiffViewRow[] {
  const ops = diffLines(splitLines(current), splitLines(saved));
  return collapseContext(pairOps(ops));
}

export function diffSpans(left: string, right: string): { left: TextSpan[]; right: TextSpan[] } {
  const a = left.match(/\s+|[^\s]+/g) ?? [];
  const b = right.match(/\s+|[^\s]+/g) ?? [];
  if (a.length === 0 && b.length === 0) {
    return { left: [], right: [] };
  }
  if (a.length > 240 || b.length > 240 || a.length * b.length > 40_000) {
    return {
      left: [{ text: left, mark: true }],
      right: [{ text: right, mark: true }],
    };
  }
  return spansFromOps(diffLines(a, b));
}

function lcsDiff(a: string[], b: string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ type: "insert", text }));
  if (m === 0) return a.map((text) => ({ type: "delete", text }));

  const width = m + 1;
  const dir = new Uint8Array((n + 1) * width);
  let prev = new Int32Array(width);
  let curr = new Int32Array(width);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const at = i * width + j;
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        dir[at] = 1;
      } else if (prev[j] >= curr[j - 1]) {
        curr[j] = prev[j];
        dir[at] = 2;
      } else {
        curr[j] = curr[j - 1];
        dir[at] = 3;
      }
    }
    const swap = prev;
    prev = curr;
    curr = swap;
    curr.fill(0);
  }

  const ops: LineOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dir[i * width + j] === 1) {
      i -= 1;
      j -= 1;
      ops.push({ type: "equal", text: a[i] });
    } else if (i > 0 && (j === 0 || dir[i * width + j] === 2)) {
      i -= 1;
      ops.push({ type: "delete", text: a[i] });
    } else {
      j -= 1;
      ops.push({ type: "insert", text: b[j] });
    }
  }
  ops.reverse();
  return ops;
}

function myersDiff(a: string[], b: string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ type: "insert", text }));
  if (m === 0) return a.map((text) => ({ type: "delete", text }));

  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  v[offset + 1] = 0;

  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice());
        return backtrack(trace, a, b, offset);
      }
    }
    trace.push(v.slice());
  }
  return [
    ...a.map((text) => ({ type: "delete" as const, text })),
    ...b.map((text) => ({ type: "insert" as const, text })),
  ];
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number): LineOp[] {
  const ops: LineOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const frontier = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && frontier[offset + k - 1] < frontier[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = frontier[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ type: "equal", text: a[x] });
    }
    if (d === 0) break;
    if (x === prevX) {
      y -= 1;
      ops.push({ type: "insert", text: b[y] });
    } else {
      x -= 1;
      ops.push({ type: "delete", text: a[x] });
    }
  }
  ops.reverse();
  return ops;
}

function pairOps(ops: LineOp[]): DiffViewRow[] {
  const rows: DiffViewRow[] = [];
  let leftNo = 1;
  let rightNo = 1;
  let index = 0;
  while (index < ops.length) {
    if (ops[index].type === "equal") {
      rows.push({ kind: "ctx", leftNo, rightNo, text: ops[index].text });
      leftNo += 1;
      rightNo += 1;
      index += 1;
      continue;
    }
    const deleted: string[] = [];
    const inserted: string[] = [];
    while (index < ops.length && ops[index].type !== "equal") {
      if (ops[index].type === "delete") deleted.push(ops[index].text);
      else inserted.push(ops[index].text);
      index += 1;
    }
    const paired = Math.min(deleted.length, inserted.length);
    for (let i = 0; i < paired; i++) {
      const spans = diffSpans(deleted[i], inserted[i]);
      rows.push({ kind: "edit", leftNo, rightNo, left: spans.left, right: spans.right });
      leftNo += 1;
      rightNo += 1;
    }
    for (let i = paired; i < deleted.length; i++) {
      rows.push({ kind: "del", leftNo, text: deleted[i] });
      leftNo += 1;
    }
    for (let i = paired; i < inserted.length; i++) {
      rows.push({ kind: "add", rightNo, text: inserted[i] });
      rightNo += 1;
    }
  }
  return rows;
}

function spansFromOps(ops: LineOp[]): { left: TextSpan[]; right: TextSpan[] } {
  const left: TextSpan[] = [];
  const right: TextSpan[] = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index].type === "equal") {
      left.push({ text: ops[index].text, mark: false });
      right.push({ text: ops[index].text, mark: false });
      index += 1;
      continue;
    }
    let deleted = "";
    let inserted = "";
    while (index < ops.length && ops[index].type !== "equal") {
      if (ops[index].type === "delete") deleted += ops[index].text;
      else inserted += ops[index].text;
      index += 1;
    }
    if (deleted) left.push({ text: deleted, mark: true });
    if (inserted) right.push({ text: inserted, mark: true });
  }
  return { left: mergeSpans(left), right: mergeSpans(right) };
}

function mergeSpans(spans: TextSpan[]): TextSpan[] {
  const merged: TextSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && last.mark === span.mark) last.text += span.text;
    else merged.push({ ...span });
  }
  return merged;
}

function collapseContext(rows: DiffViewRow[]): DiffViewRow[] {
  const changed = rows.some((row) => row.kind !== "ctx");
  if (!changed) return rows;
  const keep = rows.map((row) => row.kind !== "ctx");
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === "ctx") continue;
    const from = Math.max(0, i - CONTEXT);
    const to = Math.min(rows.length - 1, i + CONTEXT);
    for (let j = from; j <= to; j++) keep[j] = true;
  }
  const out: DiffViewRow[] = [];
  let hidden: DiffViewRow[] = [];
  const flush = () => {
    if (hidden.length === 0) return;
    out.push({ kind: "gap", count: hidden.length, rows: hidden });
    hidden = [];
  };
  for (let i = 0; i < rows.length; i++) {
    if (!keep[i]) {
      hidden.push(rows[i]);
      continue;
    }
    flush();
    out.push(rows[i]);
  }
  flush();
  return out;
}
