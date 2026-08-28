import type { StateStorage } from "zustand/middleware";
import { wrapTeamScopedStorage } from "./teamPersist";

/**
 * zustand persist 兼容的 IndexedDB storage adapter。
 *
 * 背景：dockview 的 SerializedDockview 在多 tab 场景下序列化体积可能超过
 * localStorage 的 5MB 上限，触发 QuotaExceededError 刷屏。IndexedDB 配额
 * 远大于 localStorage（通常数百 MB 甚至 GB），适合存储布局等大体量数据。
 *
 * 旧数据迁移：getItem 在 IndexedDB miss 时自动 fallback 读 localStorage，
 * 命中后异步写入 IndexedDB 并清理 localStorage 旧值，实现无缝迁移。
 * 错误兜底：getItem 失败返回 null（触发 store 重置），setItem 失败静默
 * （避免配额或事务错误刷屏）。
 */
const DB_NAME = "omnipanel";
const STORE_NAME = "kv";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txGet(db: IDBDatabase, key: string): Promise<string | null> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve((req.result as string) ?? null);
    req.onerror = () => resolve(null);
  });
}

function txPut(db: IDBDatabase, key: string, value: string): Promise<void> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

function txDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export function createIndexedDBStorage(): StateStorage {
  return wrapTeamScopedStorage({
    async getItem(name: string): Promise<string | null> {
      // 1. 先查 IndexedDB
      try {
        const db = await openDb();
        const val = await txGet(db, name);
        if (val != null) return val;
      } catch {
        // IndexedDB 不可用（隐私模式等），走 localStorage fallback
      }

      // 2. IndexedDB miss：fallback 读 localStorage（一次性迁移旧数据）
      try {
        const legacy = localStorage.getItem(name);
        if (legacy != null) {
          // 异步写入 IndexedDB 供下次命中，并清理 localStorage 旧值
          void openDb()
            .then((db) => txPut(db, name, legacy))
            .then(() => {
              try {
                localStorage.removeItem(name);
              } catch {
                // ignore
              }
            })
            .catch(() => {
              // ignore
            });
          return legacy;
        }
      } catch {
        // ignore
      }
      return null;
    },

    async setItem(name: string, value: string): Promise<void> {
      try {
        const db = await openDb();
        await txPut(db, name, value);
      } catch {
        // 静默：避免配额或事务错误刷屏
      }
    },

    async removeItem(name: string): Promise<void> {
      try {
        const db = await openDb();
        await txDelete(db, name);
      } catch {
        // 静默
      }
      // 同步清理可能残留的 localStorage 旧值
      try {
        localStorage.removeItem(name);
      } catch {
        // ignore
      }
    },
  });
}
