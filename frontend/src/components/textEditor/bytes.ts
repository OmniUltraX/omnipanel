export function decodeUtf8(bytes: number[]): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
}

export function encodeUtf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}
