/** 同一目录下分配不重复的 SQL 文件名（不含扩展名），如 query、query 2。 */
export function allocateSqlFileStem(
  nodes: ReadonlyArray<{ parentId: string | null; type: string; name: string }>,
  parentId: string | null,
  stem: string,
): string {
  const clean = stem.trim().replace(/\.sql$/i, "") || "query";
  const taken = new Set(
    nodes
      .filter((node) => node.parentId === parentId && node.type === "file")
      .map((node) => node.name.replace(/\.sql$/i, "").toLowerCase()),
  );
  if (!taken.has(clean.toLowerCase())) {
    return clean;
  }
  let index = 2;
  while (taken.has(`${clean} ${index}`.toLowerCase())) {
    index += 1;
  }
  return `${clean} ${index}`;
}
