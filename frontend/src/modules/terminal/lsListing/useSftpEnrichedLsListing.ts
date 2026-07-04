import { useEffect, useMemo, useState } from "react";
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

const inflightSftpLists = new Map<string, Promise<SftpEntry[] | null>>();

function fetchSftpDirectory(resourceId: string, directory: string): Promise<SftpEntry[] | null> {
  const key = `${resourceId}\0${directory}`;
  const existing = inflightSftpLists.get(key);
  if (existing) return existing;

  const promise = commands
    .sftpList(resourceId, directory)
    .then((result) => {
      if (result.status !== "ok") return null;
      const entries = result.data.map((entry) => ({
        ...entry,
        size: entry.size ?? 0,
      }));
      useSshDetailNavigationStore.getState().setSftpCache(resourceId, {
        path: directory,
        entries,
      });
      return entries;
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

/**
 * plain ls 在远程 SSH 会话中通过 SFTP 反向确认类型。
 *
 * 关键设计：SFTP fetch 与 listing 引用解耦。
 *  - fetchKey 依赖稳定的 (sessionId, command, cwd, resourceId, directory) — 与 listing 引用无关
 *  - SFTP fetch 独立 effect，只在 fetchKey 变化时拉取，结果写入 sftpEntries
 *  - 实时 enriched listing 用 useMemo(listing, sftpEntries) 算 —— listing 引用变化不重 fetch
 *  - 这保证 stream 期间 listing 引用频繁变化时（首次 ls）也能拿到 enrich
 */
export function useSftpEnrichedLsListing(
  listing: LsListing | null,
  command: string,
  cwd: string,
  sessionId: string,
  sessionType: TerminalSessionType,
  sessionUser?: string | null,
  resourceIdOverride?: string | null,
): SftpEnrichedLsListingState {
  const needsRemoteEnrich =
    listing != null && sessionType === "remote" && listing.layout === "grid";

  const fetchKey = useMemo<{
    resourceId: string;
    directory: string;
  } | null>(() => {
    if (!needsRemoteEnrich) return null;
    const directory = resolveLsListingDirectory(command, cwd, sessionUser);
    if (!directory) return null;
    const resourceId =
      resourceIdOverride ?? findTerminalPane(sessionId)?.resourceId ?? null;
    if (!resourceId) return null;
    return { resourceId, directory };
  }, [needsRemoteEnrich, sessionId, command, cwd, sessionUser, resourceIdOverride]);

  // in-memory 缓存：同一 listing 内容下复用 enrich 结果
  const resolveKey = useMemo(() => {
    if (!listing) return null;
    return buildLsListingResolveKey(sessionId, command, cwd, listing);
  }, [sessionId, command, cwd, listing]);

  const persistedListing = resolveKey ? readResolvedLsListing(resolveKey) : null;

  // 独立的 SFTP fetch effect：只依赖 fetchKey，不依赖 listing 引用
  const [sftpEntries, setSftpEntries] = useState<SftpEntry[] | null>(() => {
    if (!fetchKey) return null;
    const cache = useSshDetailNavigationStore.getState().sftpCaches[fetchKey.resourceId];
    if (cache && cache.path === fetchKey.directory) return cache.entries;
    return null;
  });

  useEffect(() => {
    if (!fetchKey) {
      setSftpEntries(null);
      return;
    }
    // 先看 store cache（其他组件可能已写）
    const cache = useSshDetailNavigationStore.getState().sftpCaches[fetchKey.resourceId];
    if (cache && cache.path === fetchKey.directory) {
      setSftpEntries(cache.entries);
      return;
    }
    let cancelled = false;
    void fetchSftpDirectory(fetchKey.resourceId, fetchKey.directory).then((entries) => {
      if (cancelled) return;
      setSftpEntries(entries);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchKey]);

  // 用最新 listing + sftpEntries 实时计算 enriched
  const resolved = useMemo<LsListing | null>(() => {
    if (!listing || !sftpEntries) return null;
    return enrichLsListingWithSftp(listing, sftpEntries);
  }, [listing, sftpEntries]);

  // 写 in-memory 缓存（resolved 引用变化时写）
  useEffect(() => {
    if (resolved && resolveKey) {
      writeResolvedLsListing(resolveKey, resolved);
    }
  }, [resolved, resolveKey]);

  if (!listing) {
    return { listing: null, ready: false };
  }

  if (!needsRemoteEnrich) {
    return { listing, ready: true };
  }

  if (!fetchKey) {
    return { listing, ready: true };
  }

  if (persistedListing) {
    return { listing: persistedListing, ready: true };
  }

  if (resolved) {
    return { listing: resolved, ready: true };
  }

  // 等待 SFTP 期间先展示基础解析
  return { listing, ready: false };
}
