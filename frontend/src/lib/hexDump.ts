/** 将字节格式化为经典 hex dump（offset / hex / ASCII）。 */
export function formatHexDump(bytes: Uint8Array, bytesPerLine = 16): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += bytesPerLine) {
    const chunk = bytes.subarray(offset, offset + bytesPerLine);
    const offsetLabel = offset.toString(16).padStart(8, "0");
    const hexParts: string[] = [];
    for (let i = 0; i < bytesPerLine; i += 1) {
      if (i === 8) {
        hexParts.push("");
      }
      hexParts.push(i < chunk.length ? chunk[i]!.toString(16).padStart(2, "0") : "  ");
    }
    const ascii = Array.from(chunk, (byte) =>
      byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".",
    ).join("");
    lines.push(`${offsetLabel}  ${hexParts.join(" ")}  |${ascii}|`);
  }
  return lines.join("\n");
}
