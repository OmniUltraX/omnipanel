import { memo, useMemo, useRef } from "react";
import type { TerminalSessionType } from "@/stores/terminalStore";
import { LsListingView } from "./LsListingView";
import type { LsEntry, LsListing } from "./parseLsListing";
import { resolveListingDirectoryForBlock } from "./resolveLsListingDirectory";
import { useSftpEnrichedLsListing } from "./useSftpEnrichedLsListing";
import { useTerminalFilePreviewStore } from "../terminalFilePreviewStore";
import { joinListingEntryPath } from "./resolveLsListingDirectory";
import { LOCAL_CONNECTION_ID } from "../../files/utils";
import { FeedSearchHighlightText } from "../FeedSearchHighlightText";
type EnrichedLsListingViewProps = {
  listing: LsListing;
  command: string;
  cwd: string;
  sessionId: string;
  sessionType?: TerminalSessionType;
  sessionUser?: string | null;
  resourceId?: string | null;
  fallbackOutput: string;
  isError?: boolean;
  rawOutput?: string | null;
  onRunCommand?: (command: string) => void;
  highlightQuery?: string;
};

function EnrichedLsListingViewInner({
  listing,
  command,
  cwd,
  sessionId,
  sessionType = "remote",
  sessionUser,
  resourceId,
  rawOutput,
  fallbackOutput,
  isError = false,
  onRunCommand,
  highlightQuery = "",
}: EnrichedLsListingViewProps) {
  const listingDirectory = useMemo(
    () => resolveListingDirectoryForBlock(command, cwd, sessionUser, rawOutput),
    [command, cwd, sessionUser, rawOutput],
  );

  const { listing: resolved, ready } = useSftpEnrichedLsListing(
    listing,
    command,
    cwd,
    sessionId,
    sessionType,
    sessionUser,
    resourceId,
  );
  const lastResolvedRef = useRef<LsListing | null>(null);

  const openFilePreview = useTerminalFilePreviewStore((state) => state.open);

  const handleOpenFile = useMemo(
    () => (entry: LsEntry) => {
      const absolutePath = joinListingEntryPath(listingDirectory, entry.name);
      // 本地 sessionType：connectionId 必须用 LOCAL_CONNECTION_ID（与 Rust file_manager
      // 严格匹配 "__local__"），resourceId 不传（或传 null），走 file_manager 通道的 local_read
      // 远端 SSH：connectionId 用 SSH 资源 id（与后端 sftp_download/upload 通道对齐），
      // 同时把 SSH 资源 id 放在 resourceId 字段供 customIO 走 sftp_xxx 直通通道
      const isLocal = sessionType === "local";
      openFilePreview({
        connectionId: isLocal ? LOCAL_CONNECTION_ID : resourceId ?? "",
        absolutePath,
        name: entry.name,
        resourceId: isLocal ? null : resourceId ?? null,
        sessionType,
      });
    },
    [listingDirectory, sessionType, resourceId, openFilePreview],
  );

  if (ready && resolved) {
    lastResolvedRef.current = resolved;
  }

  const displayListing = resolved ?? lastResolvedRef.current ?? listing;
  if (displayListing) {
    if (ready && resolved) {
      lastResolvedRef.current = resolved;
    }
    return (
      <LsListingView
        listing={displayListing}
        listingDirectory={listingDirectory}
        onRunCommand={onRunCommand}
        onOpenFile={handleOpenFile}
        highlightQuery={highlightQuery}
      />
    );
  }

  return (
    <pre className={`term-warp-output${isError ? " term-warp-output--error" : ""}`}>
      <FeedSearchHighlightText text={fallbackOutput} query={highlightQuery} />
    </pre>
  );
}

export const EnrichedLsListingView = memo(EnrichedLsListingViewInner);
