/** 将本地图片压缩为可用于 avatar_url 的 data URL（正方形 JPEG）。 */
export async function compressImageToAvatarDataUrl(
  bytes: Uint8Array,
  mimeHint?: string,
): Promise<string> {
  const mime = mimeHint && mimeHint.startsWith("image/") ? mimeHint : "image/png";
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const bitmap = await createImageBitmap(blob);
  try {
    const maxSize = 256;
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("无法创建画布");
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}

export function guessImageMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "image/jpeg";
}
