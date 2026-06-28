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
import { useProtocolHttpDockStore } from "../../stores/protocolHttpDockStore";
import { useProtocolHttpLayoutStore } from "../../stores/protocolHttpLayoutStore";
import { formatHttpJsonBody } from "./httpJsonBody";
import {
  buildSessionsFromHistory,
  historyEntryToSession,
  hasStoredResponse,
  makeHttpResponseSessionId,
  makeHttpResponseSessionLabel,
  resolveResponseRequestKey,
  responseDataToHistoryFields,
  type HttpResponseData,
  type HttpResponseSession,
} from "./httpResponseState";
import { filterHistoryForRequest } from "./protocolLayoutTree";

export type { HttpResponseData, HttpResponseSession };

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"
  | "WEBSOCKET";

export const HTTP_METHOD_OPTIONS: HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "WEBSOCKET",
];

export function isWebSocketMethod(method: string): boolean {
  return method.toUpperCase() === "WEBSOCKET";
}
export type BodyType = "JSON" | "Form" | "Multipart" | "Raw" | "Binary";
export type AuthType = "Bearer Token" | "Basic Auth" | "API Key" | "OAuth 2.0" | "Authorization";

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
  authValue: string;
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
  deleteHistoryEntry: (id: string) => Promise<void>;
  clearRequestHistory: (requestId: string) => Promise<void>;
  applyHistoryEntry: (entry: HttpHistoryEntry) => void;
  applySavedRequest: (req: SavedHttpRequest) => void;
  selectRequest: (req: SavedHttpRequest) => void;
  openRequestTab: (req: SavedHttpRequest) => void;
  clearSelectedRequest: () => void;
  createRequest: (name: string, parentFolderId: string | null) => Promise<void>;
  saveCurrentRequest: (name: string, collectionId: string | null) => Promise<void>;
  persistCurrentRequest: () => Promise<boolean>;
  renameSavedRequest: (requestId: string, name: string) => Promise<void>;
  updateRequestCollection: (requestId: string, collectionId: string | null) => Promise<void>;
  responseSessions: HttpResponseSession[];
  activeResponseSessionId: string | null;
  setActiveResponseSession: (sessionId: string) => void;
  closeResponseSession: (sessionId: string) => void;
  addResponseSession: (response: HttpResponseData, historyId: string | null) => void;
  recordSendHistory: (data: {
    method: string;
    url: string;
    statusCode: number | null;
    responseTimeMs: number | null;
    requestSize: number | null;
    responseSize: number | null;
    response: HttpResponseData;
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
  authValue: "eyJhbG...token",
};

function authTypeToStorage(authType: AuthType): string {
  switch (authType) {
    case "Basic Auth":
      return "basic";
    case "API Key":
      return "api_key";
    case "OAuth 2.0":
      return "oauth2";
    case "Authorization":
      return "authorization";
    default:
      return "bearer";
  }
}

function editorToSavedRequest(
  editor: HttpEditorState,
  meta: {
    id: string;
    name: string;
    collectionId: string | null;
    createdAt: number;
    updatedAt: number;
  },
): SavedHttpRequest {
  const enabledHeaders = editor.headers.filter((h) => h.enabled && h.key);
  const headerMap: Record<string, string> = {};
  for (const h of enabledHeaders) {
    headerMap[h.key] = h.value;
  }
  const body =
    editor.bodyType === "JSON" ? formatHttpJsonBody(editor.body) : editor.body;
  return {
    id: meta.id,
    name: meta.name.trim(),
    method: editor.method,
    url: editor.url,
    headers: JSON.stringify(headerMap),
    body,
    authType: authTypeToStorage(editor.authType),
    authValue: editor.authValue,
    collectionId: meta.collectionId,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

function editorWithFormattedJsonBody(editor: HttpEditorState): HttpEditorState {
  if (editor.bodyType !== "JSON") return editor;
  const body = formatHttpJsonBody(editor.body);
  if (body === editor.body) return editor;
  return { ...editor, body };
}

export function ProtocolHttpProvider({ children }: { children: ReactNode }) {
  const [history, setHistory] = useState<HttpHistoryEntry[]>([]);
  const [collections, setCollections] = useState<HttpCollection[]>([]);
  const [savedRequests, setSavedRequests] = useState<SavedHttpRequest[]>([]);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);
  const [editor, setEditorState] = useState<HttpEditorState>(DEFAULT_EDITOR);
  const [responseSessionsByRequest, setResponseSessionsByRequest] = useState<
    Record<string, HttpResponseSession[]>
  >({});
  const [activeResponseSessionByRequest, setActiveResponseSessionByRequest] = useState<
    Record<string, string | null>
  >({});

  const responseRequestKey = resolveResponseRequestKey(selectedRequestId);

  const responseSessions = useMemo(
    () => responseSessionsByRequest[responseRequestKey] ?? [],
    [responseSessionsByRequest, responseRequestKey],
  );

  const activeResponseSessionId = useMemo(
    () => activeResponseSessionByRequest[responseRequestKey] ?? null,
    [activeResponseSessionByRequest, responseRequestKey],
  );

  const syncResponseSessionsForRequest = useCallback(
    (requestId: string, req?: SavedHttpRequest | null) => {
      const request = req ?? savedRequests.find((item) => item.id === requestId) ?? null;
      const entries = filterHistoryForRequest(history, request);
      const sessions = buildSessionsFromHistory(entries);
      setResponseSessionsByRequest((prev) => ({ ...prev, [requestId]: sessions }));
      setActiveResponseSessionByRequest((prev) => ({
        ...prev,
        [requestId]: sessions[sessions.length - 1]?.id ?? null,
      }));
    },
    [history, savedRequests],
  );

  const setActiveResponseSession = useCallback(
    (sessionId: string) => {
      const requestKey = resolveResponseRequestKey(selectedRequestId);
      setActiveResponseSessionByRequest((prev) => ({
        ...prev,
        [requestKey]: sessionId,
      }));
    },
    [selectedRequestId],
  );

  const addResponseSession = useCallback(
    (response: HttpResponseData, historyId: string | null) => {
      const requestKey = resolveResponseRequestKey(selectedRequestId);
      const sessionId = historyId ?? makeHttpResponseSessionId();
      setResponseSessionsByRequest((prev) => {
        const existing = prev[requestKey] ?? [];
        if (historyId && existing.some((item) => item.historyId === historyId)) {
          return prev;
        }
        const session: HttpResponseSession = {
          id: sessionId,
          historyId,
          label: makeHttpResponseSessionLabel(existing.length + 1, response.status),
          response,
          createdAt: Date.now(),
        };
        return { ...prev, [requestKey]: [...existing, session] };
      });
      setActiveResponseSessionByRequest((prev) => ({
        ...prev,
        [requestKey]: sessionId,
      }));
    },
    [selectedRequestId],
  );

  const closeResponseSession = useCallback(
    (sessionId: string) => {
      const requestKey = resolveResponseRequestKey(selectedRequestId);
      setResponseSessionsByRequest((prev) => {
        const existing = prev[requestKey] ?? [];
        const next = existing.filter((item) => item.id !== sessionId);
        setActiveResponseSessionByRequest((activePrev) => {
          if (activePrev[requestKey] !== sessionId) return activePrev;
          return { ...activePrev, [requestKey]: next[next.length - 1]?.id ?? null };
        });
        return { ...prev, [requestKey]: next };
      });
    },
    [selectedRequestId],
  );

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
        useProtocolHttpDockStore.getState().removeTab(id);
        if (selectedRequestId === id) {
          setSelectedRequestId(null);
        }
        await loadSavedRequests();
      }
    },
    [loadSavedRequests, selectedRequestId],
  );

  const deleteHistoryEntry = useCallback(
    async (id: string) => {
      const res = await commands.httpDeleteHistory(id);
      if (res.status === "ok") {
        setResponseSessionsByRequest((prev) => {
          const next: Record<string, HttpResponseSession[]> = {};
          for (const [requestId, sessions] of Object.entries(prev)) {
            next[requestId] = sessions.filter((item) => item.historyId !== id);
          }
          setActiveResponseSessionByRequest((activePrev) => {
            const activeNext = { ...activePrev };
            for (const [requestId, activeId] of Object.entries(activePrev)) {
              if (activeId === id) {
                const remaining = next[requestId] ?? [];
                activeNext[requestId] = remaining[remaining.length - 1]?.id ?? null;
              }
            }
            return activeNext;
          });
          return next;
        });
        await loadHistory();
      }
    },
    [loadHistory],
  );

  const clearRequestHistory = useCallback(
    async (requestId: string) => {
      const res = await commands.httpClearHistoryForRequest(requestId);
      if (res.status === "ok") {
        setResponseSessionsByRequest((prev) => ({ ...prev, [requestId]: [] }));
        setActiveResponseSessionByRequest((prev) => ({ ...prev, [requestId]: null }));
        await loadHistory();
      }
    },
    [loadHistory],
  );

  const applyHistoryEntry = useCallback(
    (entry: HttpHistoryEntry) => {
      setEditorState((prev) => ({
        ...prev,
        method: entry.method as HttpMethod,
        url: entry.url,
      }));
      const requestId = entry.requestId ?? selectedRequestId;
      if (!requestId || !hasStoredResponse(entry)) return;

      setResponseSessionsByRequest((prev) => {
        const existing = prev[requestId] ?? [];
        if (existing.some((item) => item.historyId === entry.id)) {
          return prev;
        }
        const index = existing.length + 1;
        const session = historyEntryToSession(entry, index);
        return {
          ...prev,
          [requestId]: [...existing, session].sort((a, b) => a.createdAt - b.createdAt),
        };
      });
      setActiveResponseSessionByRequest((prev) => ({ ...prev, [requestId]: entry.id }));
    },
    [selectedRequestId],
  );

  const parseHeaders = useCallback((raw: string): HttpKvPair[] => {
    if (!raw.trim()) {
      return [{ key: "", value: "", enabled: true }];
    }
    try {
      const map = JSON.parse(raw) as Record<string, string>;
      const pairs = Object.entries(map).map(([key, value]) => ({
        key,
        value,
        enabled: true,
      }));
      return pairs.length > 0 ? pairs : [{ key: "", value: "", enabled: true }];
    } catch {
      return [{ key: "", value: "", enabled: true }];
    }
  }, []);

  const applySavedRequest = useCallback(
    (req: SavedHttpRequest) => {
      const authType: AuthType =
        req.authType === "basic"
          ? "Basic Auth"
          : req.authType === "api_key"
            ? "API Key"
            : req.authType === "oauth2"
              ? "OAuth 2.0"
              : req.authType === "authorization"
                ? "Authorization"
                : "Bearer Token";

      setEditorState({
        method: req.method as HttpMethod,
        url: req.url,
        body: req.body ?? "",
        bodyType: "JSON",
        authType,
        authValue: req.authValue ?? "",
        params: [{ key: "", value: "", enabled: true }],
        headers: parseHeaders(req.headers),
      });
    },
    [parseHeaders],
  );

  const selectRequest = useCallback(
    (req: SavedHttpRequest) => {
      applySavedRequest(req);
      setSelectedRequestId(req.id);
      syncResponseSessionsForRequest(req.id, req);
    },
    [applySavedRequest, syncResponseSessionsForRequest],
  );

  const openRequestTab = useCallback(
    (req: SavedHttpRequest) => {
      useProtocolHttpDockStore.getState().openTab(req.id);
      selectRequest(req);
    },
    [selectRequest],
  );

  const clearSelectedRequest = useCallback(() => {
    setSelectedRequestId(null);
  }, []);

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
        if (parentFolderId) {
          layout.ensureFolderExpanded(parentFolderId);
        }
        layout.reorderSibling(
          `request:${req.id}`,
          parentFolderId ? { kind: "folder", folderId: parentFolderId } : { kind: "root" },
        );
        await loadSavedRequests();
        openRequestTab(req);
      } else {
        console.error("[protocol] create request failed:", res.error);
      }
    },
    [loadSavedRequests, openRequestTab],
  );

  const saveCurrentRequest = useCallback(
    async (name: string, collectionId: string | null) => {
      const now = Date.now();
      const prepared = editorWithFormattedJsonBody(editor);
      if (prepared.body !== editor.body) {
        setEditorState(prepared);
      }
      const req = editorToSavedRequest(prepared, {
        id: generateId(),
        name,
        collectionId,
        createdAt: now,
        updatedAt: now,
      });
      const res = await commands.httpSaveRequest(req);
      if (res.status === "ok") {
        await loadSavedRequests();
        setSelectedRequestId(req.id);
        useProtocolHttpDockStore.getState().openTab(req.id);
      }
    },
    [editor, loadSavedRequests],
  );

  const persistCurrentRequest = useCallback(async () => {
    const now = Date.now();
    if (selectedRequestId) {
      const existing = savedRequests.find((r) => r.id === selectedRequestId);
      if (!existing) return false;
      const prepared = editorWithFormattedJsonBody(editor);
      if (prepared.body !== editor.body) {
        setEditorState(prepared);
      }
      const req = editorToSavedRequest(prepared, {
        id: existing.id,
        name: existing.name,
        collectionId: existing.collectionId,
        createdAt: existing.createdAt ?? now,
        updatedAt: now,
      });
      const res = await commands.httpSaveRequest(req);
      if (res.status === "ok") {
        await loadSavedRequests();
        return true;
      }
      return false;
    }
    return false;
  }, [editor, loadSavedRequests, savedRequests, selectedRequestId]);

  const renameSavedRequest = useCallback(
    async (requestId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const existing = savedRequests.find((r) => r.id === requestId);
      if (!existing) return;
      const req: SavedHttpRequest = {
        ...existing,
        name: trimmed,
        updatedAt: Date.now(),
      };
      const res = await commands.httpSaveRequest(req);
      if (res.status === "ok") {
        await loadSavedRequests();
      }
    },
    [loadSavedRequests, savedRequests],
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
      response: HttpResponseData;
    }) => {
      const historyId = generateId();
      const responseFields = responseDataToHistoryFields(data.response);
      const entry: HttpHistoryEntry = {
        id: historyId,
        method: data.method,
        url: data.url,
        statusCode: data.statusCode,
        responseTimeMs: data.responseTimeMs,
        requestSize: data.requestSize,
        responseSize: data.responseSize,
        createdAt: Date.now(),
        requestId: selectedRequestId,
        responseStatusText: responseFields.responseStatusText,
        responseContentType: responseFields.responseContentType,
        responseHeaders: responseFields.responseHeaders,
        responseBody: responseFields.responseBody,
      };
      const res = await commands.httpAddHistory(entry);
      if (res.status === "ok") {
        addResponseSession(data.response, historyId);
        await loadHistory();
      }
    },
    [addResponseSession, loadHistory, selectedRequestId],
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
      deleteHistoryEntry,
      clearRequestHistory,
      applyHistoryEntry,
      applySavedRequest,
      selectRequest,
      openRequestTab,
      clearSelectedRequest,
      createRequest,
      saveCurrentRequest,
      persistCurrentRequest,
      renameSavedRequest,
      updateRequestCollection,
      responseSessions,
      activeResponseSessionId,
      setActiveResponseSession,
      closeResponseSession,
      addResponseSession,
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
      deleteHistoryEntry,
      clearRequestHistory,
      applyHistoryEntry,
      applySavedRequest,
      selectRequest,
      openRequestTab,
      clearSelectedRequest,
      createRequest,
      saveCurrentRequest,
      persistCurrentRequest,
      renameSavedRequest,
      updateRequestCollection,
      responseSessions,
      activeResponseSessionId,
      setActiveResponseSession,
      closeResponseSession,
      addResponseSession,
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

