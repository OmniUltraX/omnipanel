import { useEffect } from "react";
import { commands, type FileEntry } from "../../ipc/bindings";
import { listDirectory } from "../files/fileApi";
import { LOCAL_CONNECTION_ID } from "../files/utils";
import { normalizeTerminalCwdForSftp } from "../server/ssh/utils/parseCommandPaths";
import {
  getCachedPathListing,
  isPathListingStale,
  pathListingCacheKey,
  setCachedPathListing,
  type CachedPathEntry,
} from "./commandBar/pathListingCache";

const PREFETCH_DEBOUNCE_MS = 80;

const inflight = new Map<string, Promise<CachedPathEntry[]>>();

function listingResourceId(
  sessionType: "local" | "remote",
  resourceId: string | null,
): string | null {
  return sessionType === "local" ? null : resourceId;
}

function normalizeLocalCwd(cwd: string): string {
  const trimmed = (cwd || "").trim() || "/";
  if (/^[A-Za-z]:/.test(trimmed)) {
    const drive = trimmed[0]!.toUpperCase();
    return `${drive}${trimmed.slice(1).replace(/\//g, "\\").replace(/\\+$/, "")}`;
  }
  return trimmed;
}

export function resolveCwdListingDir(
  sessionType: "local" | "remote",
  cwd: string,
): string {
  const trimmed = (cwd || "").trim() || "/";
  if (sessionType === "remote") {
    return normalizeTerminalCwdForSftp(trimmed) ?? (trimmed.startsWith("/") ? trimmed : "/");
  }
  return normalizeLocalCwd(trimmed);
}

async function listRemoteDirectory(resourceId: string, dir: string): Promise<CachedPathEntry[]> {
  const res = await commands.sftpList(resourceId, dir || "/");
  if (res.status !== "ok") return [];
  return res.data.map((entry) => ({ name: entry.name, isDir: entry.isDir }));
}

async function listLocalDirectory(dir: string): Promise<CachedPathEntry[]> {
  const result = await listDirectory(LOCAL_CONNECTION_ID, dir || "/", null, null, { quiet: true });
  return result.entries.map((entry: FileEntry) => ({
    name: entry.name,
    isDir: entry.kind === "dir",
  }));
}

export function lookupCwdPathName(
  sessionType: "local" | "remote",
  resourceId: string | null,
  cwd: string,
  name: string,
): CachedPathEntry | null {
  const dir = resolveCwdListingDir(sessionType, cwd);
  const key = pathListingCacheKey(sessionType, listingResourceId(sessionType, resourceId), dir);
  const entries = getCachedPathListing(key);
  if (!entries) return null;
  return entries.find((entry) => entry.name === name) ?? null;
}

export function getCwdPathListing(
  sessionType: "local" | "remote",
  resourceId: string | null,
  cwd: string,
): CachedPathEntry[] | null {
  const dir = resolveCwdListingDir(sessionType, cwd);
  return getCachedPathListing(
    pathListingCacheKey(sessionType, listingResourceId(sessionType, resourceId), dir),
  );
}

export async function prefetchCwdPathListing(
  sessionType: "local" | "remote",
  resourceId: string | null,
  cwd: string,
): Promise<CachedPathEntry[]> {
  const dir = resolveCwdListingDir(sessionType, cwd);
  const key = pathListingCacheKey(sessionType, listingResourceId(sessionType, resourceId), dir);
  const cached = getCachedPathListing(key);
  if (cached && !isPathListingStale(key)) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    try {
      const entries =
        sessionType === "local"
          ? await listLocalDirectory(dir)
          : resourceId
            ? await listRemoteDirectory(resourceId, dir)
            : [];
      setCachedPathListing(key, entries);
      return entries;
    } catch {
      return [];
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

export function usePrefetchCwdPathListing(params: {
  enabled: boolean;
  sessionType: "local" | "remote";
  resourceId: string | null;
  cwd: string;
}): void {
  const { enabled, sessionType, resourceId, cwd } = params;
  useEffect(() => {
    if (!enabled || !cwd) return;
    const timer = window.setTimeout(() => {
      void prefetchCwdPathListing(sessionType, resourceId, cwd);
    }, PREFETCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, sessionType, resourceId, cwd]);
}
