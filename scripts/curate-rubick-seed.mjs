// Rubick 种子收录：npm 搜索候选 → packument 取 tarball/integrity → 输出 RegistryFile v2 条目。
// 用法：node scripts/curate-rubick-seed.mjs [query] [max]
const query = process.argv[2] || "rubick-plugin";
const max = Number(process.argv[3] || 15);

function sanitize(name) {
  let out = "";
  for (const c of String(name).toLowerCase()) {
    if (/[a-z0-9._-]/.test(c)) out += c;
    else if (!out.endsWith("-")) out += "-";
  }
  out = out.replace(/^[-.]+|[-.]+$/g, "");
  return out || "external";
}

async function main() {
  const search = await fetch(
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${max * 3}`,
    { headers: { Accept: "application/json" } },
  ).then((r) => r.json());
  const seen = new Set();
  const entries = [];
  for (const hit of search.objects ?? []) {
    const name = hit.package?.name;
    if (!name || seen.has(name)) continue;
    // 只要 rubick 生态包（名含 rubick 或 keywords 含 rubick）
    const kws = (hit.package.keywords ?? []).join(" ").toLowerCase();
    if (!name.toLowerCase().includes("rubick") && !kws.includes("rubick")) continue;
    seen.add(name);
    const version = hit.package.version;
    let dist = null;
    try {
      const doc = await fetch(
        `https://registry.npmjs.org/${name.replace("/", "%2F")}/${version}`,
        { headers: { Accept: "application/json" } },
      ).then((r) => (r.ok ? r.json() : null));
      dist = doc?.dist ?? null;
    } catch {}
    if (!dist?.tarball) continue;
    entries.push({
      id: `omni.ext.${sanitize(name)}`,
      kind: "addon",
      name: hit.package.title || name,
      description: hit.package.description || "",
      versions: [
        {
          version,
          minHostApi: 1,
          artifact: {
            url: dist.tarball,
            integrity: dist.integrity || "",
            size: 0,
          },
        },
      ],
      _npm: name,
    });
    if (entries.length >= max) break;
  }
  console.log(JSON.stringify({ schemaVersion: 2, plugins: entries }, null, 2));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
