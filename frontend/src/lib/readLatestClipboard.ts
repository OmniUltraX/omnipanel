export type ClipboardTextSnapshot = {
  kind: "text";
  text: string;
};

export type ClipboardImageSnapshot = {
  kind: "image";
  src: string;
  mimeType: string;
};

export type ClipboardSnapshot = ClipboardTextSnapshot | ClipboardImageSnapshot;

export function revokeClipboardSnapshot(snapshot: ClipboardSnapshot | null | undefined) {
  if (snapshot?.kind === "image") {
    URL.revokeObjectURL(snapshot.src);
  }
}

async function readViaClipboardItems(): Promise<ClipboardSnapshot | null> {
  if (!navigator.clipboard?.read) return null;
  const items = await navigator.clipboard.read();
  const item = items[0];
  if (!item) return null;

  const imageType = item.types.find((type) => type.startsWith("image/"));
  if (imageType) {
    const blob = await item.getType(imageType);
    return {
      kind: "image",
      src: URL.createObjectURL(blob),
      mimeType: imageType,
    };
  }

  if (item.types.includes("text/plain")) {
    const blob = await item.getType("text/plain");
    const text = (await blob.text()).trim();
    if (text) return { kind: "text", text };
  }

  return null;
}

/** 读取剪贴板最新一条内容（优先图片，其次文本） */
export async function readLatestClipboard(): Promise<ClipboardSnapshot | null> {
  try {
    const fromItems = await readViaClipboardItems();
    if (fromItems) return fromItems;
  } catch {
    // fall through to readText
  }

  if (!navigator.clipboard?.readText) {
    throw new Error("CLIPBOARD_UNAVAILABLE");
  }

  const text = (await navigator.clipboard.readText()).trim();
  return text ? { kind: "text", text } : null;
}
