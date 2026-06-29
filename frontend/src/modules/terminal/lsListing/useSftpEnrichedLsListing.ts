import { useEffect, useMemo, useRef, useState } from "react";
import { commands } from "@/ipc/bindings";
import type { SftpEntry } from "@/ipc/bindings";
import { findTerminalPane } from "@/stores/terminalStore";
import { useSshDetailNavigationStore } from "@/stores/sshDetailNavigationStore";
import type { TerminalSessionType } from "@/stores/terminalStore";
import { enrichLsListingWithSftp } from "./enrichLsListingWithSftp";
import {
  buildLsListingResolveKey,
  readResolvedLsListing,
  writeResolvedLsListing,
} from "./lsListingResolveCache";
import type { LsListing } from "./parseLsListing";
import { resolveLsListingDirectory } from "./resolveLsListingDirectory";

function readSftpCache(resourceId: string, path: string): SftpEntry[] | null {
  const cache = useSshDetailNavigationStore.getState().sftpCaches[resourceId];
  if (!cache || cache.path !== path) return null;
  return cache.entries;
}

const inflightSftpLists = new Map<string, Promise<SftpEntry[] | null>>();

function fetchSftpDirectory(resourceId: string, directory: string): Promise<SftpEntry[] | null> {
  const key = `${resourceId}\0${directory}`;
  const existing = inflightSftpLists.get(key);
  if (existing) return existing;

  const promise = commands
    .sftpList(resourceId, directory)
    .then((result) => {
      if (result.status !== "ok") return null;
      useSshDetailNavigationStore.getState().setSftpCache(resourceId, {
        path: directory,
        entries: result.data.map((entry) => ({
          ...entry,
          size: entry.size ?? 0,
        })),
      });
      return result.data.map((entry) => ({
        ...entry,
        size: entry.size ?? 0,
      }));
    })
    .finally(() => {
      inflightSftpLists.delete(key);
    });

  inflightSftpLists.set(key, promise);
  return promise;
}

export type SftpEnrichedLsListingState = {
  listing: LsListing | null;
  ready: boolean;
};

/** plain ls 在远程 SSH 会话中通过 SFTP 反向确认类型；结果持久缓存，避免滚动时回退到纯文本。 */
export function useSftpEnrichedLsListing(
  listing: LsListing | null,
  command: string,
  cwd: string,
  sessionId: string,
  sessionType: TerminalSessionType,
  sessionUser?: string | null,
): SftpEnrichedLsListingState {
  const needsRemoteEnrich =
    listing != null && sessionType === "remote" && listing.layout === "grid";

  const resolveKey = useMemo(() => {
    if (!listing) return null;
    return buildLsListingResolveKey(sessionId, command, cwd, listing);
  }, [sessionId, command, cwd, listing]);

  const directory = useMemo(() => {
    if (!needsRemoteEnrich) return null;
    return resolveLsListingDirectory(command, cwd, sessionUser);
  }, [needsRemoteEnrich, command, cwd, sessionUser]);

  const resourceId = useMemo(() => {
    if (!needsRemoteEnrich) return null;
    return findTerminalPane(sessionId)?.resourceId ?? null;
  }, [needsRemoteEnrich, sessionId]);

  const persistedListing = resolveKey ? readResolvedLsListing(resolveKey) : null;

  const cachedListing = useMemo(() => {
    if (!listing || !needsRemoteEnrich || !resourceId || !directory) return null;
    const cached = readSftpCache(resourceId, directory);
    if (!cached) return null;
    return enrichLsListingWithSftp(listing, cached);
  }, [listing, needsRemoteEnrich, resourceId, directory]);

  const [fetchedListing, setFetchedListing] = useState<LsListing | null>(null);
  const requestKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!listing || !needsRemoteEnrich || !resourceId || !directory || !resolveKey) {
      return;
    }

    if (persistedListing || cachedListing) {
      const resolved = persistedListing ?? cachedListing!;
      writeResolvedLsListing(resolveKey, resolved);
      return;
    }

    const requestKey = `${resourceId}\0${directory}\0${resolveKey}`;
    if (requestKeyRef.current === requestKey) {
      return;
    }
    requestKeyRef.current = requestKey;

    let cancelled = false;

    void fetchSftpDirectory(resourceId, directory).then((entries) => {
      if (cancelled || requestKeyRef.current !== requestKey) return;
      const resolved = entries ? enrichLsListingWithSftp(listing, entries) : listing;
      writeResolvedLsListing(resolveKey, resolved);
      setFetchedListing(resolved);
    });

    return () => {
      cancelled = true;
    };
  }, [
    listing,
    needsRemoteEnrich,
    resourceId,
    directory,
    cachedListing,
    persistedListing,
    resolveKey,
  ]);

  if (!listing) {
    return { listing: null, ready: false };
  }

  if (!needsRemoteEnrich) {
    return { listing, ready: true };
  }

  if (persistedListing) {
    return { listing: persistedListing, ready: true };
  }

  if (cachedListing) {
    writeResolvedLsListing(resolveKey!, cachedListing);
    return { listing: cachedListing, ready: true };
  }

  if (fetchedListing) {
    return { listing: fetchedListing, ready: true };
  }

  return { listing: null, ready: false };
}
