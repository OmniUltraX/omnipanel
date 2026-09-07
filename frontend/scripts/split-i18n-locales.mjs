import fs from "fs";
import path from "path";

function findMatchingBrace(src, openIdx) {
  let depth = 0;
  let inStr = null;
  let escape = false;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i++;
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (c === "{") {
      depth++;
      continue;
    }
    if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error("unclosed brace");
}

function splitBodyKeys(body) {
  const chunks = [];
  let d = 0;
  let inStr = null;
  let escape = false;
  let k = 0;
  while (k < body.length) {
    const ch = body[k];
    if (inStr) {
      if (escape) {
        escape = false;
        k++;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        k++;
        continue;
      }
      if (ch === inStr) inStr = null;
      k++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      k++;
      continue;
    }
    if (ch === "/" && body[k + 1] === "/") {
      while (k < body.length && body[k] !== "\n") k++;
      continue;
    }
    if (ch === "/" && body[k + 1] === "*") {
      k += 2;
      while (k < body.length && !(body[k] === "*" && body[k + 1] === "/")) k++;
      k += 2;
      continue;
    }
    if (ch === "{") {
      d++;
      k++;
      continue;
    }
    if (ch === "}") {
      d--;
      k++;
      continue;
    }
    if (ch === "[") {
      d++;
      k++;
      continue;
    }
    if (ch === "]") {
      d--;
      k++;
      continue;
    }
    if (d === 0) {
      const rest = body.slice(k);
      const m = rest.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
      if (m) {
        const name = m[2];
        const valueStart = k + m[0].length;
        let vd = 0;
        let vs = null;
        let ve = false;
        let p = valueStart;
        while (p < body.length) {
          const c2 = body[p];
          if (vs) {
            if (ve) {
              ve = false;
              p++;
              continue;
            }
            if (c2 === "\\") {
              ve = true;
              p++;
              continue;
            }
            if (c2 === vs) vs = null;
            p++;
            continue;
          }
          if (c2 === '"' || c2 === "'" || c2 === "`") {
            vs = c2;
            p++;
            continue;
          }
          if (c2 === "/" && body[p + 1] === "/") {
            while (p < body.length && body[p] !== "\n") p++;
            continue;
          }
          if (c2 === "/" && body[p + 1] === "*") {
            p += 2;
            while (p < body.length && !(body[p] === "*" && body[p + 1] === "/")) p++;
            p += 2;
            continue;
          }
          if (c2 === "{" || c2 === "[") {
            vd++;
            p++;
            continue;
          }
          if (c2 === "}" || c2 === "]") {
            if (vd === 0) break;
            vd--;
            p++;
            continue;
          }
          if ((c2 === "," || c2 === "}") && vd === 0) {
            chunks.push({ name, value: body.slice(valueStart, p).trim() });
            k = c2 === "," ? p + 1 : p;
            break;
          }
          p++;
        }
        continue;
      }
    }
    k++;
  }
  return chunks;
}

function splitLocale(filePath, exportName, outDir, locale) {
  const src = fs.readFileSync(filePath, "utf8");
  const markers = [
    `export const ${exportName} = {`,
    `export const ${exportName}: TranslationDict = {`,
  ];
  let start = -1;
  let marker = markers[0];
  for (const m of markers) {
    start = src.indexOf(m);
    if (start >= 0) {
      marker = m;
      break;
    }
  }
  if (start < 0) throw new Error(`marker not found for ${exportName}`);
  const openBrace = start + marker.length - 1;
  const closeBrace = findMatchingBrace(src, openBrace);
  const body = src.slice(openBrace + 1, closeBrace);
  const chunks = splitBodyKeys(body);
  if (chunks.length === 0) throw new Error(`no chunks for ${locale}`);

  fs.mkdirSync(outDir, { recursive: true });
  for (const { name, value } of chunks) {
    fs.writeFileSync(
      path.join(outDir, `${name}.ts`),
      `export default ${value} as const;\n`,
    );
  }
  const imports = chunks
    .map((c) => `import ${c.name} from "./${c.name}";`)
    .join("\n");
  const obj = chunks.map((c) => `  ${c.name}`).join(",\n");
  fs.writeFileSync(
    path.join(outDir, "index.ts"),
    `${imports}\n\nexport const ${exportName} = {\n${obj}\n} as const;\n\nexport default ${exportName};\n`,
  );
  console.log(locale, "chunks", chunks.length);
}

const root = "d:/omnipanel/frontend/src/i18n";
splitLocale(`${root}/zh-CN.ts`, "zhCN", `${root}/locales/zh-CN`, "zh-CN");
splitLocale(`${root}/en-US.ts`, "enUS", `${root}/locales/en-US`, "en-US");
