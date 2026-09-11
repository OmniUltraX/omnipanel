import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

function run(query, max) {
  const out = execFileSync("node", ["scripts/curate-rubick-seed.mjs", query, String(max)], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out).plugins;
}

const seen = new Map();
for (const p of [...run("rubick-plugin", 12), ...run("rubick", 25), ...run("utools", 20), ...run("utools plugin", 15)]) {
  if (!seen.has(p.id)) seen.set(p.id, p);
}
const plugins = [...seen.values()].slice(0, 20);
console.log(`total: ${plugins.length}`);
for (const p of plugins) {
  console.log(`${p.id} | ${p.versions[0].version} | ${(p.description || "").slice(0, 44)} | npm=${p._npm}`);
}
writeFileSync(
  new URL(`file:///${process.env.TEMP}/rubick-merged.json`.replace(/\\/g, "/")),
  JSON.stringify({ schemaVersion: 2, plugins }, null, 2),
);
