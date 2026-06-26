import { memo, useEffect, useRef, useState } from "react";
import { FileEntryIcon } from "../../components/ui/FileEntryIcon";
import type { FileEntry } from "../../ipc/bindings";
import {
  getCachedThumbnailUrl,
  resolveThumbnailUrl,
} from "./fileGridThumbnailLoader";
import { isGridImageFile } from "./utils";

export interface FileGridThumbnailProps {
  connectionId: string;
  entry: FileEntry;
}

function FileGridThumbnailInner({ connectionId, entry }: FileGridThumbnailProps) {
  const isDir = entry.kind === "dir";
  const isImage = !isDir && isGridImageFile(entry.name);
  const hostRef = useRef<HTMLSpanElement>(null);
  const [inView, setInView] = useState(false);
  const [src, setSrc] = useState<string | null>(() => {
    if (!isImage) return null;
    return getCachedThumbnailUrl(connectionId, entry.path);
  });

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !isImage) return;
    const root = el.closest(".fm-grid") as HTMLElement | null;
    const observer = new IntersectionObserver(
      ([item]) => setInView(item?.isIntersecting ?? false),
      { root, rootMargin: "120px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [isImage]);

  useEffect(() => {
    if (!isImage || !inView) return;
    let cancelled = false;
    void resolveThumbnailUrl(connectionId, entry)
      .then((url) => {
        if (!cancelled && url) setSrc(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connectionId, entry.path, entry.kind, entry.name, entry.size, isImage, inView]);

  return (
    <span ref={hostRef} className="grid-thumb-host">
      {isDir ? (
        <FileEntryIcon type="dir" />
      ) : src ? (
        <img
          src={src}
          alt=""
          className="grid-thumb"
          decoding="async"
          draggable={false}
        />
      ) : (
        <FileEntryIcon type="file" fileName={entry.name} size={40} />
      )}
    </span>
  );
}

export const FileGridThumbnail = memo(
  FileGridThumbnailInner,
  (prev, next) =>
    prev.connectionId === next.connectionId
    && prev.entry.path === next.entry.path
    && prev.entry.kind === next.entry.kind
    && prev.entry.name === next.entry.name,
);
