/** dotext 后缀图标（Vite 构建时收集 `assets/dotext/*.png`）。 */
const dotextPngModules = import.meta.glob<string>(
  "../assets/dotext/*.png",
  { eager: true, import: "default" },
);

const ICON_BY_EXT: Record<string, string> = Object.create(null);

for (const [path, url] of Object.entries(dotextPngModules)) {
  const base = path.split("/").pop()?.replace(/\.png$/i, "").toLowerCase();
  if (base) ICON_BY_EXT[base] = url;
}

/** 默认文件 / 文件夹图标（dotext/file.png、dotext/folder.png）。 */
export const DOTEXT_DEFAULT_FILE_ICON_URL = ICON_BY_EXT.file ?? "";
export const DOTEXT_FOLDER_ICON_URL = ICON_BY_EXT.folder ?? "";

/** 无专用图标时的后缀别名。 */
const EXT_ALIASES: Record<string, string> = {
  jpeg: "jpg",
  jpe: "jpg",
  htm: "html",
  hpp: "h",
  hxx: "h",
  cc: "cpp",
  cxx: "cpp",
  yaml: "yml",
  md: "txt",
  markdown: "txt",
  json: "xml",
  js: "txt",
  mjs: "txt",
  cjs: "txt",
  ts: "txt",
  tsx: "txt",
  jsx: "txt",
  rs: "c",
  go: "c",
  sh: "txt",
  bash: "txt",
  zsh: "txt",
  ps1: "exe",
  bat: "exe",
  cmd: "exe",
  svg: "png",
  webp: "png",
  mpeg: "mpg",
  mkv: "mp4",
  csv: "xls",
  xlsm: "xlsx",
  pptx: "ppt",
  potx: "ppt",
  pot: "ppt",
  docm: "docx",
  xlsb: "xlsx",
  log: "txt",
  ini: "txt",
  cfg: "txt",
  conf: "txt",
  toml: "txt",
};

function extractExtension(fileName: string): string {
  const lower = fileName.toLowerCase().trim();
  if (!lower || lower.endsWith("/")) return "";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tar.bz2") || lower.endsWith(".tar.xz")) {
    return "tgz";
  }
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}

function resolveExtKey(ext: string): string | null {
  if (!ext) return null;
  if (ICON_BY_EXT[ext]) return ext;
  const alias = EXT_ALIASES[ext];
  if (alias && ICON_BY_EXT[alias]) return alias;
  return null;
}

/** 根据文件名返回 dotext 图标 URL；无后缀匹配时返回 file.png。 */
export function resolveFileExtensionIconUrl(fileName?: string): string {
  const fallback = DOTEXT_DEFAULT_FILE_ICON_URL;
  if (!fileName?.trim()) return fallback;

  const ext = extractExtension(fileName);
  const key = resolveExtKey(ext);
  if (key) return ICON_BY_EXT[key] ?? fallback;
  return fallback;
}
