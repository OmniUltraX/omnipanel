import { memo, useMemo, useRef } from "react";
import type { TerminalSessionType } from "@/stores/terminalStore";
import { LsListingView } from "./LsListingView";
import type { LsListing } from "./parseLsListing";
import { resolveListingDirectoryForBlock } from "./resolveLsListingDirectory";
import { useSftpEnrichedLsListing } from "./useSftpEnrichedLsListing";
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
      />
    );
  }

  return (
    <pre className={`term-warp-output${isError ? " term-warp-output--error" : ""}`}>
      {fallbackOutput}
    </pre>
  );
}

export const EnrichedLsListingView = memo(EnrichedLsListingViewInner);
