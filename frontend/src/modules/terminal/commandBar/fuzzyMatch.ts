/** 折叠空白与路径分隔符，便于跨段匹配 */
function collapsedText(text: string): string {
  return text.toLowerCase().replace(/[\s/\\_.-]+/g, "");
}

/** 路径/命令各段的缩写，如 `cd /dev/prod/m` → `cdpm` */
function pathInitials(text: string): string {
  return text
    .split(/[\s/\\]+/)
    .filter(Boolean)
    .map((part) => part[0] ?? "")
    .join("")
    .toLowerCase();
}

function scoreSubsequence(query: string, target: string): number {
  if (!query || !target) return 0;
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let ti = 0; ti < target.length && qi < query.length; ti += 1) {
    if (target[ti] !== query[qi]) continue;
    score += 10;
    if (ti === prev + 1) score += 6;
    if (ti === 0) score += 4;
    prev = ti;
    qi += 1;
  }
  return qi === query.length ? score : 0;
}

/** 允许跳过少量未命中的查询字符（仅用于路径段首字母，且首字符须匹配） */
function scorePathInitialsLoose(query: string, target: string): number {
  const initials = pathInitials(target);
  if (!initials || query[0] !== initials[0]) return 0;
  const strict = scoreSubsequence(query, initials);
  if (strict > 0) return strict;
  let qi = 0;
  let ti = 0;
  let skips = 0;
  const maxSkips = 1;
  while (qi < query.length && ti < initials.length) {
    if (query[qi] === initials[ti]) {
      qi += 1;
      ti += 1;
      continue;
    }
    if (skips < maxSkips) {
      qi += 1;
      skips += 1;
      continue;
    }
    ti += 1;
  }
  while (qi < query.length && skips < maxSkips) {
    qi += 1;
    skips += 1;
  }
  return qi === query.length ? 10 * query.length - skips * 3 : 0;
}

type PathSegment = { index: number; char: string };

function listPathSegments(target: string): PathSegment[] {
  const segments: PathSegment[] = [];
  const regex = /[^\s/\\]+/g;
  let match: RegExpExecArray | null = regex.exec(target);
  while (match) {
    const char = match[0]![0];
    if (char) segments.push({ index: match.index, char: char.toLowerCase() });
    match = regex.exec(target);
  }
  return segments;
}

function subsequenceIndices(query: string, target: string): number[] {
  const q = query.toLowerCase();
  const lower = target.toLowerCase();
  const indices: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < lower.length && qi < q.length; ti += 1) {
    if (lower[ti] !== q[qi]) continue;
    indices.push(ti);
    qi += 1;
  }
  return qi === q.length ? indices : [];
}

function collapsedSubsequenceIndices(query: string, target: string): number[] {
  const q = query.toLowerCase();
  const indices: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < q.length; ti += 1) {
    if (/[\s/\\_.-]/.test(target[ti]!)) continue;
    if (target[ti]!.toLowerCase() !== q[qi]) continue;
    indices.push(ti);
    qi += 1;
  }
  return qi === q.length ? indices : [];
}

function pathInitialsIndices(query: string, target: string): number[] {
  const q = query.toLowerCase();
  const segments = listPathSegments(target);
  let qi = 0;
  let si = 0;
  const indices: number[] = [];
  while (qi < q.length && si < segments.length) {
    if (segments[si]!.char === q[qi]) {
      indices.push(segments[si]!.index);
      qi += 1;
    }
    si += 1;
  }
  return qi === q.length ? indices : [];
}

function pathInitialsLooseIndices(query: string, target: string): number[] {
  const q = query.toLowerCase();
  const segments = listPathSegments(target);
  if (!segments.length || q[0] !== segments[0]!.char) return [];
  const strict = pathInitialsIndices(q, target);
  if (strict.length === q.length) return strict;
  let qi = 0;
  let si = 0;
  let skips = 0;
  const maxSkips = 1;
  const indices: number[] = [];
  while (qi < q.length && si < segments.length) {
    if (q[qi] === segments[si]!.char) {
      indices.push(segments[si]!.index);
      qi += 1;
      si += 1;
      continue;
    }
    if (skips < maxSkips) {
      qi += 1;
      skips += 1;
      continue;
    }
    si += 1;
  }
  while (qi < q.length && skips < maxSkips) {
    qi += 1;
    skips += 1;
  }
  return qi === q.length ? indices : [];
}

/** 返回应高亮的字符下标（与 fuzzyMatchScore 策略一致） */
export function fuzzyHighlightIndices(query: string, target: string): number[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const options = [
    subsequenceIndices(normalized, target),
    collapsedSubsequenceIndices(normalized, target),
    pathInitialsIndices(normalized, target),
    pathInitialsLooseIndices(normalized, target),
  ];
  return options.sort((a, b) => b.length - a.length)[0] ?? [];
}

/** 查询字符按顺序出现在目标中（不要求连续） */
export function fuzzyMatches(query: string, target: string): boolean {
  return fuzzyMatchScore(query, target) > 0;
}

/** 分数越高越靠前；0 表示不匹配 */
export function fuzzyMatchScore(query: string, target: string): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 1;
  const lower = target.toLowerCase();
  let score = Math.max(
    scoreSubsequence(normalized, lower),
    scoreSubsequence(normalized, collapsedText(target)),
    scoreSubsequence(normalized, pathInitials(target)),
    scorePathInitialsLoose(normalized, target),
  );
  // 前缀匹配显著优先于中间命中（如 `a` → apps 高于 cloudcanal）
  if (score > 0 && lower.startsWith(normalized)) {
    score += 100;
  }
  return score;
}
