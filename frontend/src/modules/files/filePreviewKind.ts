import {
  isAudioPreviewFile,
  isPreviewImageFile,
  isVideoPreviewFile,
} from "./utils";
import { parsePreviewJsonText } from "../../lib/contentPreview";

export { parsePreviewJsonText };

export type FilePreviewKind = "json" | "text" | "image" | "audio" | "video" | "archive" | "unsupported";

const JSON_EXTENSIONS = new Set(["json", "jsonc", "json5", "geojson"]);

/** 压缩包扩展名：远端执行 unzip/tar/7z/unrar 列条目（不在本地下载文件）。
 *  复合扩展名（tar.gz/tgz 等）通过 isArchivePreviewFile 单独匹配。 */
const ARCHIVE_EXTENSIONS = new Set([
  "zip", "7z", "rar",
  // 单扩展名 tar 变体
  "tar", "tgz", "tbz2", "tbz", "txz", "tzst",
]);

/** 复合压缩扩展名（必须先于单扩展名判断） */
const ARCHIVE_COMPOUND_SUFFIXES = [
  ".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst",
];

export function isArchivePreviewFile(name: string): boolean {
  const lower = name.toLowerCase();
  // 优先匹配复合扩展名
  for (const suffix of ARCHIVE_COMPOUND_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  const ext = lower.split(".").pop() ?? "";
  return ARCHIVE_EXTENSIONS.has(ext);
}

/** 明确不支持预览的二进制 / 办公 / 难播视频容器等扩展名 */
const UNSUPPORTED_EXTENSIONS = new Set([
  // 可执行 / 库
  "exe", "dll", "so", "dylib", "bin", "o", "obj", "a", "lib", "wasm", "class", "com", "msi",
  // 压缩 / 打包：已迁移到 ARCHIVE_EXTENSIONS（zip/7z/rar/tar/tgz/tbz2/txz/tzst）
  // 仍不支持：cab/iso/dmg/img/jar/war/ear/apk/ipa/deb/rpm/pkg
  "cab", "iso", "dmg", "img",
  "jar", "war", "ear", "apk", "ipa", "deb", "rpm", "pkg",
  // 单层压缩（非 tar 容器）：gz/bz2/xz/zst 只压单文件，列条目意义不大
  "gz", "bz2", "xz", "zst",
  // 办公 / 文档（无内置解码）
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  // WebView 通常无法直接播放的视频
  "mkv", "avi", "wmv", "flv", "mpeg", "mpg", "ts", "mts", "vob",
  // 字体
  "woff", "woff2", "ttf", "otf", "eot",
  // 设计源文件
  "psd", "ai", "sketch", "fig", "xd",
]);

const TEXT_EXTENSIONS = new Set([
  // 纯文本
  "txt", "md", "rst", "log", "env", "csv", "tsv",
  // 配置 / 数据
  "json", "jsonc", "json5", "geojson", "xml", "yaml", "yml", "toml",
  "ini", "cfg", "conf", "properties", "lock",
  // 脚本 / shell
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "dockerfile", "makefile",
  // Web / 前端
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "sass", "less", "html", "htm", "svg", "vue", "svelte",
  // 编程语言
  "py", "rb", "pl", "lua", "rs", "go", "java", "kt", "scala", "swift",
  "c", "h", "cpp", "cxx", "hpp", "hxx", "cc", "m", "mm",
  "cs", "fs", "vb", "php", "dart", "r", "jl", "ex", "exs", "clj", "cljs", "elm",
  // 数据库 / 查询
  "sql",
  // 构建 / 项目
  "gradle", "cmake", "ninja", "sbt",
]);

export function isJsonPreviewFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return JSON_EXTENSIONS.has(ext);
}

export function isTextPreviewFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * 文件是否有"明显"的扩展名：有点号且最后一段为非空字母数字
 * （用于在无扩展名匹配时按文本尝试，但太特殊的二进制名（无点）仍判为 unsupported）
 */
function hasRecognizableExtension(name: string): boolean {
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return false;
  const ext = name.slice(idx + 1);
  return /^[A-Za-z0-9]{1,8}$/.test(ext);
}

/** 常见无扩展名但确实是文本的约定文件名（Dockerfile、Makefile、README、LICENSE 等） */
const TEXT_FILENAMES = new Set([
  "dockerfile", "containerfile", "makefile", "rakefile", "gemfile", "procfile",
  "vagrantfile", "brewfile", "podfile", "fastfile", "justfile",
  "readme", "license", "licence", "changelog", "authors", "contributors",
  "todo", "notice", "copying", "install", "news", "thanks",
  "cmakelists", "manifest", "pipfile", "poetry", "go.mod", "go.sum",
  "cargo.lock", "yarn.lock", "pnpm-lock", "composer.lock", "gemfile.lock",
  ".bashrc", ".zshrc", ".profile", ".bash_profile", ".vimrc", ".gitconfig",
  ".gitignore", ".dockerignore", ".editorconfig", ".eslintrc", ".prettierrc",
  ".npmrc", ".yarnrc",
]);

function isKnownTextFilename(name: string): boolean {
  return TEXT_FILENAMES.has(name.toLowerCase());
}

export function resolveFilePreviewKind(name: string): FilePreviewKind {
  if (isPreviewImageFile(name)) return "image";
  if (isAudioPreviewFile(name)) return "audio";
  if (isVideoPreviewFile(name)) return "video";
  if (isArchivePreviewFile(name)) return "archive";
  if (isJsonPreviewFile(name)) return "json";
  if (isTextPreviewFile(name)) return "text";
  // 常见无扩展名约定文件名：按文本预览
  if (isKnownTextFilename(name)) return "text";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (UNSUPPORTED_EXTENSIONS.has(ext)) return "unsupported";
  // 无扩展名且不是已知二进制文件：默认按文本预览（/etc 下几乎都是文本配置）
  if (!hasRecognizableExtension(name) && !isKnownBinaryFilename(name)) return "text";
  // 兜底：有可识别扩展名但不在白名单/黑名单 → 按文本尝试（加载后可按魔术字节回退）
  if (hasRecognizableExtension(name)) return "text";
  return "unsupported";
}

/** 已知二进制文件（无扩展名）—— 避免按文本乱码预览 */
const BINARY_FILENAMES = new Set([
  // 设备/虚拟文件
  "core", "core.dump",
  // 内核
  "vmlinuz", "vmlinux", "initrd", "initramfs",
  // swap
  "swap",
  // 常见二进制包
  "system.map",
  // 字体
]);

function isKnownBinaryFilename(name: string): boolean {
  return BINARY_FILENAMES.has(name.toLowerCase());
}

/**
 * 通过首字节魔术签名（magic bytes）检测内容类型。
 * 适用于无扩展名 / 扩展名被剥掉 / 扩展名错配的文件。
 * 返回 null 表示无法判定（调用方按默认 text 走）。
 */
export function detectPreviewKindFromBytes(bytes: Uint8Array | number[]): FilePreviewKind | null {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.length === 0) return null;

  // 8-byte 头部匹配（最常见文件格式）
  const head8 = view.subarray(0, Math.min(8, view.length));
  const head16 = view.subarray(0, Math.min(16, view.length));

  // 图片
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (head8.length >= 8 && head8[0] === 0x89 && head8[1] === 0x50 && head8[2] === 0x4e && head8[3] === 0x47) return "image";
  // JPEG: FF D8 FF
  if (head8.length >= 3 && head8[0] === 0xff && head8[1] === 0xd8 && head8[2] === 0xff) return "image";
  // GIF: 47 49 46 38
  if (head8.length >= 4 && head8[0] === 0x47 && head8[1] === 0x49 && head8[2] === 0x46 && head8[3] === 0x38) return "image";
  // WebP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
  if (
    head16.length >= 12 &&
    head16[0] === 0x52 && head16[1] === 0x49 && head16[2] === 0x46 && head16[3] === 0x46 &&
    head16[8] === 0x57 && head16[9] === 0x45 && head16[10] === 0x42 && head16[11] === 0x50
  ) return "image";
  // BMP: 42 4D
  if (head8.length >= 2 && head8[0] === 0x42 && head8[1] === 0x4d) return "image";

  // 音频（需在 NUL 字节检测之前，二进制音频常含 0x00）
  if (isWavMagic(head16)) return "audio";
  if (isOggMagic(head8)) return "audio";
  if (isFlacMagic(head8)) return "audio";
  if (isMp3Magic(view)) return "audio";
  if (isMp4ContainerMagic(head8)) return "audio";

  // 压缩包 magic bytes（必须在 NUL 字节检测之前，压缩文件头部几乎必含 0x00）
  // zip: 50 4B 03 04 (PK\x03\x04) / 50 4B 05 06 (空 zip) / 50 4B 07 08 (分卷)
  if (head8.length >= 4 && head8[0] === 0x50 && head8[1] === 0x4b
    && (head8[2] === 0x03 || head8[2] === 0x05 || head8[2] === 0x07)
    && (head8[3] === 0x04 || head8[3] === 0x06 || head8[3] === 0x08)) return "archive";
  // 7z: 37 7A BC AF 27 1C
  if (head8.length >= 6 && head8[0] === 0x37 && head8[1] === 0x7a && head8[2] === 0xbc
    && head8[3] === 0xaf && head8[4] === 0x27 && head8[5] === 0x1c) return "archive";
  // rar v4/v5: 52 61 72 21 1A 07 (00/01 00)
  if (head8.length >= 7 && head8[0] === 0x52 && head8[1] === 0x61 && head8[2] === 0x72
    && head8[3] === 0x21 && head8[4] === 0x1a && head8[5] === 0x07) return "archive";
  // bzip2: 42 5A 68 ("BZh")
  if (head8.length >= 3 && head8[0] === 0x42 && head8[1] === 0x5a && head8[2] === 0x68) return "archive";
  // xz: FD 37 7A 58 5A 00
  if (head8.length >= 6 && head8[0] === 0xfd && head8[1] === 0x37 && head8[2] === 0x7a
    && head8[3] === 0x58 && head8[4] === 0x5a && head8[5] === 0x00) return "archive";
  // zstd: 28 B5 2F FD
  if (head8.length >= 4 && head8[0] === 0x28 && head8[1] === 0xb5
    && head8[2] === 0x2f && head8[3] === 0xfd) return "archive";
  // gzip: 1F 8B（tar.gz 走外层 gzip magic，archive kind 由后端命令识别 tar 容器）
  if (head8.length >= 2 && head8[0] === 0x1f && head8[1] === 0x8b) return "archive";
  // tar: ustar 位于偏移 257（需读取 ≥263 字节）
  if (view.length >= 263) {
    const tarMagic = view.subarray(257, 262);
    if (tarMagic[0] === 0x75 && tarMagic[1] === 0x73 && tarMagic[2] === 0x74
      && tarMagic[3] === 0x61 && tarMagic[4] === 0x72) return "archive"; // "ustar"
  }

  // PDF: 25 50 44 46
  const isPdf = head8.length >= 4 && head8[0] === 0x25 && head8[1] === 0x50 && head8[2] === 0x44 && head8[3] === 0x46;

  // 二进制启发式：含 NUL 字节 → binary（不按文本预览）
  if (containsNulByte(view, 256)) return "unsupported";
  // 已经判定为二进制格式（未实现具体解码） → unsupported
  if (isPdf) return "unsupported";

  // 文本格式魔术字节
  // SVG: 包含 <svg 或 <?xml
  const ascii = head8ToAscii(head8);
  if (ascii) {
    const trimmed = ascii.trimStart();
    if (trimmed.startsWith("<?xml") || trimmed.startsWith("<svg") || /^\s*<\?xml/.test(trimmed)) {
      // XML/SVG 用 image kind（FilePreviewContent 会按 image 渲染）—— 但只对真 svg
      if (trimmed.includes("<svg") || /<svg[\s>]/i.test(ascii)) return "image";
    }
    // HTML
    if (/^\s*<!doctype\s+html/i.test(trimmed) || /^\s*<html[\s>]/i.test(trimmed)) return "text";
    // shebang → 文本
    if (trimmed.startsWith("#!")) return "text";
    // JSON 启发式
    const firstNonWs = ascii.trimStart();
    if (firstNonWs.startsWith("{") || firstNonWs.startsWith("[")) {
      // 用完整 bytes 试解析 JSON
      const text = decodePreviewBytes(Array.from(view));
      if (parsePreviewJsonText(text) != null) return "json";
    }
  }

  return null;
}

function isWavMagic(view: Uint8Array): boolean {
  if (view.length < 12) return false;
  // RIFF....WAVE 或大文件 RF64....WAVE
  const isRiff =
    view[0] === 0x52 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x46;
  const isRf64 =
    view[0] === 0x52 && view[1] === 0x46 && view[2] === 0x36 && view[3] === 0x34;
  const isWave =
    view[8] === 0x57 && view[9] === 0x45 && view[10] === 0x41 && view[11] === 0x56;
  return (isRiff || isRf64) && isWave;
}

function isOggMagic(view: Uint8Array): boolean {
  return view.length >= 4 && view[0] === 0x4f && view[1] === 0x67 && view[2] === 0x67 && view[3] === 0x53;
}

function isFlacMagic(view: Uint8Array): boolean {
  return view.length >= 4 && view[0] === 0x66 && view[1] === 0x4c && view[2] === 0x61 && view[3] === 0x43;
}

function isMp3Magic(view: Uint8Array): boolean {
  if (view.length >= 3 && view[0] === 0x49 && view[1] === 0x44 && view[2] === 0x33) {
    return true;
  }
  if (view.length >= 2 && view[0] === 0xff && (view[1]! & 0xe0) === 0xe0) {
    return true;
  }
  return false;
}

function isMp4ContainerMagic(view: Uint8Array): boolean {
  return view.length >= 8 && view[4] === 0x66 && view[5] === 0x74 && view[6] === 0x79 && view[7] === 0x70;
}

function head8ToAscii(view: Uint8Array): string {
  let s = "";
  for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i]!);
  return s;
}

function containsNulByte(view: Uint8Array, scanLimit: number): boolean {
  const limit = Math.min(view.length, scanLimit);
  for (let i = 0; i < limit; i++) {
    if (view[i] === 0) return true;
  }
  return false;
}

export function decodePreviewBytes(bytes: number[]): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
  } catch {
    return "";
  }
}
