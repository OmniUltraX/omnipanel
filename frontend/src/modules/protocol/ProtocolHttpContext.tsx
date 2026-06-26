import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { commands, type HttpCollection, type HttpHistoryEntry, type SavedHttpRequest } from "../../ipc/bindings";
import { useProtocolHttpLayoutStore } from "../../stores/protocolHttpLayoutStore";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
export type BodyType = "JSON" | "Form" | "Multipart" | "Raw" | "Binary";
export type AuthType = "Bearer Token" | "Basic Auth" | "API Key" | "OAuth 2.0";

export interface HttpKvPair {
  key: string;
  value: string;
  enabled: boolean;
}

export interface HttpEditorState {
  method: HttpMethod;
  url: string;
  params: HttpKvPair[];
  headers: HttpKvPair[];
  body: string;
  bodyType: BodyType;
  authType: AuthType;
}

interface ProtocolHttpContextValue {
  history: HttpHistoryEntry[];
  collections: HttpCollection[];
  savedRequests: SavedHttpRequest[];
  selectedRequestId: string | null;
  activeCollectionId: string | null;
  setActiveCollectionId: (id: string | null) => void;
  editor: HttpEditorState;
  setEditor: (patch: Partial<HttpEditorState>) => void;
  loadHistory: () => Promise<void>;
  loadCollections: () => Promise<void>;
  loadSavedRequests: () => Promise<void>;
  createCollection: (name: string) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;
  deleteSavedRequest: (id: string) => Promise<void>;
  applyHistoryEntry: (entry: HttpHistoryEntry) => void;
  applySavedRequest: (req: SavedHttpRequest) => void;
  selectRequest: (req: SavedHttpRequest) => void;
  createRequest: (name: string, parentFolderId: string | null) => Promise<void>;
  saveCurrentRequest: (name: string, collectionId: string | null) => Promise<void>;
  updateRequestCollection: (requestId: string, collectionId: string | null) => Promise<void>;
  recordSendHistory: (data: {
    method: string;
    url: string;
    statusCode: number | null;
    responseTimeMs: number | null;
    requestSize: number | null;
    responseSize: number | null;
  }) => Promise<void>;
}

const ProtocolHttpContext = createContext<ProtocolHttpContextValue | null>(null);

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const DEFAULT_EDITOR: HttpEditorState = {
  method: "GET",
  url: "https://api.example.com/v1/users",
  params: [
    { key: "page", value: "1", enabled: true },
    { key: "limit", value: "20", enabled: true },
    { key: "sort", value: "created_at", enabled: false },
  ],
  headers: [
    { key: "Content-Type", value: "application/json", enabled: true },
    { key: "Authorization", value: "Bearer eyJhbG...token", enabled: true },
    { key: "Accept", value: "application/json", enabled: true },
  ],
  body: '{\n  "name": "John Doe",\n  "email": "john@example.com",\n  "role": "admin"\n}',
  bodyType: "JSON",
  authType: "Bearer Token",
};

export function ProtocolHttpProvider({ children }: { children: ReactNode }) {
  const [history, setHistory] = useState<HttpHistoryEntry[]>([]);
  const [collections, setCollections] = useState<HttpCollection[]>([]);
  const [savedRequests, setSavedRequests] = useState<SavedHttpRequest[]>([]);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);
  const [editor, setEditorState] = useState<HttpEditorState>(DEFAULT_EDITOR);

  const setEditor = useCallback((patch: Partial<HttpEditorState>) => {
    setEditorState((prev) => ({ ...prev, ...patch }));
  }, []);

  const loadHistory = useCallback(async () => {
    const res = await commands.httpListHistory(200);
    if (res.status === "ok") {
      setHistory(res.data);
    }
  }, []);

  const loadCollections = useCallback(async () => {
    const res = await commands.httpListCollections();
    if (res.status === "ok") {
      setCollections(res.data);
    }
  }, []);

  const loadSavedRequests = useCallback(async () => {
    const res = await commands.httpListRequests(null);
    if (res.status === "ok") {
      setSavedRequests(res.data);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
    void loadCollections();
    void loadSavedRequests();
  }, [loadHistory, loadCollections, loadSavedRequests]);

  const createCollection = useCallback(
    async (name: string) => {
      const now = Date.now();
      const col: HttpCollection = {
        id: generateId(),
        name: name.trim(),
        description: "",
        createdAt: now,
        updatedAt: now,
      };
      const res = await commands.httpSaveCollection(col);
      if (res.status === "ok") {
        await loadCollections();
      }
    },
    [loadCollections],
  );

  const deleteCollection = useCallback(
    async (id: string) => {
      const res = await commands.httpDeleteCollection(id);
      if (res.status === "ok") {
        if (activeCollectionId === id) {
          setActiveCollectionId(null);
        }
        await loadCollections();
        await loadSavedRequests();
      }
    },
    [activeCollectionId, loadCollections, loadSavedRequests],
  );

  const deleteSavedRequest = useCallback(
    async (id: string) => {
      const res = await commands.httpDeleteRequest(id);
      if (res.status === "ok") {
        if (selectedRequestId === id) {
          setSelectedRequestId(null);
        }
        await loadSavedRequests();
      }
    },
    [loadSavedRequests, selectedRequestId],
  );

  const applyHistoryEntry = useCallback((entry: HttpHistoryEntry) => {
    setEditorState((prev) => ({
      ...prev,
      method: entry.method as HttpMethod,
      url: entry.url,
    }));
  }, []);

  const applySavedRequest = useCallback((req: SavedHttpRequest) => {
    setEditorState((prev) => {
      const next = {
        ...prev,
        method: req.method as HttpMethod,
        url: req.url,
        body: req.body,
      };
      if (req.headers) {
        try {
          const map = JSON.parse(req.headers) as Record<string, string>;
          const newHeaders = Object.entries(map).map(([key, value]) => ({
            key,
            value,
            enabled: true,
          }));
          if (newHeaders.length > 0) {
            return { ...next, headers: newHeaders };
          }
        } catch {
          /* ignore */
        }
      }
      return next;
    });
  }, []);

  const selectRequest = useCallback(
    (req: SavedHttpRequest) => {
      applySavedRequest(req);
      setSelectedRequestId(req.id);
    },
    [applySavedRequest],
  );

  const createRequest = useCallback(
    async (name: string, parentFolderId: string | null) => {
      const now = Date.now();
      const req: SavedHttpRequest = {
        id: generateId(),
        name: name.trim(),
        method: "GET",
        url: "",
        headers: "{}",
        body: "",
        authType: "",
        authValue: "",
        collectionId: null,
        createdAt: now,
        updatedAt: now,
      };
      const res = await commands.httpSaveRequest(req);
      if (res.status === "ok") {
        const layout = useProtocolHttpLayoutStore.getState();
        layout.setRequestParent(req.id, parentFolderId);
        layout.reorderSibling(
          `request:${req.id}`,
          parentFolderId ? { kind: "folder", folderId: parentFolderId } : { kind: "root" },
        );
        await loadSavedRequests();
        selectRequest(req);
      }
    },
    [loadSavedRequests, selectRequest],
  );

  const saveCurrentRequest = useCallback(
    async (name: string, collectionId: string | null) => {
      const now = Date.now();
      const enabledHeaders = editor.headers.filter((h) => h.enabled && h.key);
      const headerMap: Record<string, string> = {};
      for (const h of enabledHeaders) {
        headerMap[h.key] = h.value;
      }
      const req: SavedHttpRequest = {
        id: generateId(),
        name: name.trim(),
        method: editor.method,
        url: editor.url,
        headers: JSON.stringify(headerMap),
        body: editor.body,
        authType: editor.authType === "Bearer Token" ? "bearer" : "",
        authValue: "",
        collectionId,
        createdAt: now,
        updatedAt: now,
      };
      const res = await commands.httpSaveRequest(req);
      if (res.status === "ok") {
        await loadSavedRequests();
        setSelectedRequestId(req.id);
      }
    },
    [editor, loadSavedRequests],
  );

  const updateRequestCollection = useCallback(
    async (requestId: string, collectionId: string | null) => {
      const existing = savedRequests.find((r) => r.id === requestId);
      if (!existing) return;
      const req: SavedHttpRequest = {
        ...existing,
        collectionId,
        updatedAt: Date.now(),
      };
      const res = await commands.httpSaveRequest(req);
      if (res.status === "ok") {
        await loadSavedRequests();
      }
    },
    [savedRequests, loadSavedRequests],
  );

  const recordSendHistory = useCallback(
    async (data: {
      method: string;
      url: string;
      statusCode: number | null;
      responseTimeMs: number | null;
      requestSize: number | null;
      responseSize: number | null;
    }) => {
      const entry: HttpHistoryEntry = {
        id: generateId(),
        method: data.method,
        url: data.url,
        statusCode: data.statusCode,
        responseTimeMs: data.responseTimeMs,
        requestSize: data.requestSize,
        responseSize: data.responseSize,
        createdAt: Date.now(),
        requestId: selectedRequestId,
      };
      const res = await commands.httpAddHistory(entry);
      if (res.status === "ok") {
        await loadHistory();
      }
    },
    [loadHistory, selectedRequestId],
  );

  const value = useMemo<ProtocolHttpContextValue>(
    () => ({
      history,
      collections,
      savedRequests,
      selectedRequestId,
      activeCollectionId,
      setActiveCollectionId,
      editor,
      setEditor,
      loadHistory,
      loadCollections,
      loadSavedRequests,
      createCollection,
      deleteCollection,
      deleteSavedRequest,
      applyHistoryEntry,
      applySavedRequest,
      selectRequest,
      createRequest,
      saveCurrentRequest,
      updateRequestCollection,
      recordSendHistory,
    }),
    [
      history,
      collections,
      savedRequests,
      selectedRequestId,
      activeCollectionId,
      editor,
      setEditor,
      loadHistory,
      loadCollections,
      loadSavedRequests,
      createCollection,
      deleteCollection,
      deleteSavedRequest,
      applyHistoryEntry,
      applySavedRequest,
      selectRequest,
      createRequest,
      saveCurrentRequest,
      updateRequestCollection,
      recordSendHistory,
    ],
  );

  return <ProtocolHttpContext.Provider value={value}>{children}</ProtocolHttpContext.Provider>;
}

export function useProtocolHttp() {
  const ctx = useContext(ProtocolHttpContext);
  if (!ctx) {
    throw new Error("useProtocolHttp must be used within ProtocolHttpProvider");
  }
  return ctx;
}

export function useProtocolHttpOptional() {
  return useContext(ProtocolHttpContext);
}
