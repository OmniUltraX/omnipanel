import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { commands, type HttpCollection, type HttpEnvironment, type HttpHistoryEntry, type SavedHttpRequest } from "../../ipc/bindings";
import { scheduleAssistantSnapshotSync } from "../assistant";
import { useProtocolHttpDockStore } from "../../stores/protocolHttpDockStore";
import { useProtocolHttpLayoutStore } from "../../stores/protocolHttpLayoutStore";
import { useProtocolWorkspaceStore } from "../../stores/protocolWorkspaceStore";
import { formatHttpJsonBody } from "./httpJsonBody";
import { parseHttpHeaders, serializeHttpHeaders } from "./httpHeaderUtils";
import { parsePathParams, serializePathParams, syncPathParamsFromUrl } from "./httpPathParams";
import {
  historyEntryToSession,
  hasStoredResponse,
  makeHttpResponseSessionId,
  makeHttpResponseSessionLabel,
  resolveResponseRequestKey,
  responseDataToHistoryFields,
  type HttpResponseData,
  type HttpResponseSession,
} from "./httpResponseState";
import {
  readStoredActiveEnvironmentId,
  splitUrlByEnvironment,
  writeStoredActiveEnvironmentId,
} from "./httpEnvironment";
import type { HttpPathParamPair } from "./httpPathParams";

async function persistHttpRequest(req: SavedHttpRequest) {
  const res = await commands.httpSaveRequest(req);
  if (res.status === "ok") {
    scheduleAssistantSnapshotSync();
  }
  return res;
}

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

export const AUTH_TYPES: AuthType[] = [
  "Bearer Token",
  "Basic Auth",
  "API Key",
  "OAuth 2.0",
  "Authorization",
];

export const AUTH_TYPE_I18N_KEYS: Record<
  AuthType,
  "bearerToken" | "basicAuth" | "apiKey" | "oauth2" | "authorization"
> = {
  "Bearer Token": "bearerToken",
  "Basic Auth": "basicAuth",
  "API Key": "apiKey",
  "OAuth 2.0": "oauth2",
  Authorization: "authorization",
};

export interface HttpKvPair {
  key: string;
  value: string;
  enabled: boolean;
}

export type {
  HttpHeaderKeyKind,
  HttpHeaderPair,
  HttpHeaderValueType,
} from "./httpHeaderUtils";

export interface HttpEditorState {
  method: HttpMethod;
  environmentId: string | null;
  url: string;
  pathParams: HttpPathParamPair[];
  params: HttpKvPair[];
  headers: import("./httpHeaderUtils").HttpHeaderPair[];
  body: string;
  bodyType: BodyType;
  authType: AuthType;
  authValue: string;
}

interface ProtocolHttpContextValue {
  history: HttpHistoryEntry[];
  collections: HttpCollection[];
  environments: HttpEnvironment[];
  savedRequests: SavedHttpRequest[];
  selectedRequestId: string | null;
  activeCollectionId: string | null;
  setActiveCollectionId: (id: string | null) => void;
  editor: HttpEditorState;
  setEditor: (patch: Partial<HttpEditorState>) => void;
  loadHistory: () => Promise<void>;
  loadCollections: () => Promise<void>;
  loadEnvironments: () => Promise<void>;
  loadSavedRequests: () => Promise<void>;
  saveEnvironment: (env: HttpEnvironment) => Promise<void>;
  deleteEnvironment: (id: string) => Promise<void>;
  createCollection: (name: string) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;
  deleteSavedRequest: (id: string) => Promise<void>;
  deleteHistoryEntry: (id: string) => Promise<void>;
  renameHistoryEntry: (id: string, label: string) => Promise<void>;
  clearRequestHistory: (requestId: string) => Promise<void>;
  applyHistoryEntry: (entry: HttpHistoryEntry) => void;
  applySavedRequest: (req: SavedHttpRequest) => void;
  selectRequest: (req: SavedHttpRequest) => void;
  openRequestTab: (req: SavedHttpRequest) => void;
  clearSelectedRequest: () => void;
  createRequest: (name: string, parentFolderId: string | null) => Promise<SavedHttpRequest | null>;
  saveCurrentRequest: (name: string, collectionId: string | null) => Promise<string | null>;
  persistCurrentRequest: () => Promise<boolean>;
  renameSavedRequest: (requestId: string, name: string) => Promise<void>;
  updateRequestCollection: (requestId: string, collectionId: string | null) => Promise<void>;
  responseSessions: HttpResponseSession[];
  activeResponseSessionId: string | null;
  setActiveResponseSession: (sessionId: string) => void;
  closeResponseSession: (sessionId: string) => void;
  addResponseSession: (
    response: HttpResponseData,
    historyId: string | null,
    curlCommand?: string | null,
  ) => void;
  recordSendHistory: (data: {
    method: string;
    url: string;
    environmentId: string | null;
    statusCode: number | null;
    responseTimeMs: number | null;
    requestSize: number | null;
    responseSize: number | null;
    response: HttpResponseData;
    curlCommand?: string | null;
    requestId?: string | null;
  }) => Promise<void>;
}

const ProtocolHttpContext = createContext<ProtocolHttpContextValue | null>(null);

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const DEFAULT_EDITOR: HttpEditorState = {
  method: "GET",
  environmentId: null,
  url: "/v1/users",
  pathParams: [],
  params: [
    { key: "page", value: "1", enabled: true },
    { key: "limit", value: "20", enabled: true },
    { key: "sort", value: "created_at", enabled: false },
  ],
  headers: [
    {
      key: "Content-Type",
      value: "application/json",
      enabled: true,
      keyKind: "preset",
      valueType: "string",
    },
    {
      key: "Authorization",
      value: "Bearer eyJhbG...token",
      enabled: true,
      keyKind: "preset",
      valueType: "string",
    },
    {
      key: "Accept",
      value: "application/json",
      enabled: true,
      keyKind: "preset",
      valueType: "string",
    },
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
  const body =
    editor.bodyType === "JSON" ? formatHttpJsonBody(editor.body) : editor.body;
  return {
    id: meta.id,
    name: meta.name.trim(),
    method: editor.method,
    url: editor.url,
    headers: serializeHttpHeaders(editor.headers),
    pathParams: serializePathParams(editor.pathParams),
    body,
    authType: authTypeToStorage(editor.authType),
    authValue: editor.authValue,
    collectionId: meta.collectionId,
    environmentId: editor.environmentId,
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
  const [environments, setEnvironments] = useState<HttpEnvironment[]>([]);
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
  const selectedRequestIdRef = useRef<string | null>(null);
  selectedRequestIdRef.current = selectedRequestId;

  const responseRequestKey = resolveResponseRequestKey(selectedRequestId);

  const responseSessions = useMemo(
    () => responseSessionsByRequest[responseRequestKey] ?? [],
    [responseSessionsByRequest, responseRequestKey],
  );

  const activeResponseSessionId = useMemo(
    () => activeResponseSessionByRequest[responseRequestKey] ?? null,
    [activeResponseSessionByRequest, responseRequestKey],
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
    (response: HttpResponseData, historyId: string | null, curlCommand?: string | null) => {
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
          curlCommand: curlCommand?.trim() || null,
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
    setEditorState((prev) => {
      const next = { ...prev, ...patch };
      if ("environmentId" in patch) {
        writeStoredActiveEnvironmentId(next.environmentId);
      }
      return next;
    });
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

  const loadEnvironments = useCallback(async () => {
    const res = await commands.httpListEnvironments();
    if (res.status === "ok") {
      setEnvironments(res.data);
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
    void loadEnvironments();
    void loadSavedRequests();
  }, [loadHistory, loadCollections, loadEnvironments, loadSavedRequests]);

  useEffect(() => {
    if (environments.length === 0) return;
    setEditorState((prev) => {
      if (prev.environmentId && environments.some((item) => item.id === prev.environmentId)) {
        return prev;
      }
      const storedId = readStoredActiveEnvironmentId();
      const storedEnv = storedId
        ? environments.find((item) => item.id === storedId) ?? null
        : null;
      const fallback = storedEnv ?? environments[0] ?? null;
      if (!fallback) return prev;
      return { ...prev, environmentId: fallback.id };
    });
  }, [environments]);

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

  const saveEnvironment = useCallback(
    async (env: HttpEnvironment) => {
      const res = await commands.httpSaveEnvironment(env);
      if (res.status === "ok") {
        await loadEnvironments();
        writeStoredActiveEnvironmentId(env.id);
        setEditorState((prev) => ({ ...prev, environmentId: env.id }));
      }
    },
    [loadEnvironments],
  );

  const deleteEnvironment = useCallback(
    async (id: string) => {
      const res = await commands.httpDeleteEnvironment(id);
      if (res.status === "ok") {
        await loadEnvironments();
        await loadSavedRequests();
        setEditorState((prev) => {
          if (prev.environmentId !== id) return prev;
          const remaining = environments.filter((item) => item.id !== id);
          const nextId = remaining[0]?.id ?? null;
          writeStoredActiveEnvironmentId(nextId);
          return { ...prev, environmentId: nextId };
        });
      }
    },
    [environments, loadEnvironments, loadSavedRequests],
  );

  const deleteSavedRequest = useCallback(
    async (id: string) => {
      const res = await commands.httpDeleteRequest(id);
      if (res.status === "ok") {
        scheduleAssistantSnapshotSync();
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

  const renameHistoryEntry = useCallback(
    async (id: string, label: string) => {
      const trimmed = label.trim();
      const res = await commands.httpRenameHistory(id, trimmed);
      if (res.status === "ok") {
        setResponseSessionsByRequest((prev) => {
          const next: Record<string, HttpResponseSession[]> = {};
          for (const [requestId, sessions] of Object.entries(prev)) {
            next[requestId] = sessions.map((item, index) => {
              if (item.historyId !== id) return item;
              return {
                ...item,
                label: trimmed || makeHttpResponseSessionLabel(index + 1, item.response.status),
              };
            });
          }
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
      const split = splitUrlByEnvironment(entry.url, environments);
      setEditorState((prev) => ({
        ...prev,
        method: entry.method as HttpMethod,
        environmentId: entry.environmentId ?? split.environmentId ?? prev.environmentId,
        url: split.path,
      }));
      const resolvedEnvId = entry.environmentId ?? split.environmentId;
      if (resolvedEnvId) {
        writeStoredActiveEnvironmentId(resolvedEnvId);
      }
      const requestId = entry.requestId ?? selectedRequestId;
      if (!requestId || !hasStoredResponse(entry)) return;

      setResponseSessionsByRequest((prev) => {
        const existing = prev[requestId] ?? [];
        const found = existing.find((item) => item.historyId === entry.id);
        if (found) {
          setActiveResponseSessionByRequest((activePrev) => ({
            ...activePrev,
            [requestId]: found.id,
          }));
          return prev;
        }
        const index = existing.length + 1;
        const nextSession = historyEntryToSession(entry, index);
        setActiveResponseSessionByRequest((activePrev) => ({
          ...activePrev,
          [requestId]: nextSession.id,
        }));
        return {
          ...prev,
          [requestId]: [...existing, nextSession].sort((a, b) => a.createdAt - b.createdAt),
        };
      });
    },
    [environments, selectedRequestId],
  );

  const parseHeaders = useCallback((raw: string) => parseHttpHeaders(raw), []);

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

      const split = req.environmentId
        ? { environmentId: req.environmentId, path: req.url }
        : splitUrlByEnvironment(req.url, environments);
      const environmentId =
        split.environmentId ??
        readStoredActiveEnvironmentId() ??
        environments[0]?.id ??
        null;

      const storedPathParams = parsePathParams(
        (req as SavedHttpRequest & { pathParams?: string }).pathParams,
      );

      setEditorState({
        method: req.method as HttpMethod,
        environmentId,
        url: split.path,
        pathParams: syncPathParamsFromUrl(split.path, storedPathParams),
        body: req.body ?? "",
        bodyType: "JSON",
        authType,
        authValue: req.authValue ?? "",
        params: [{ key: "", value: "", enabled: true }],
        headers: parseHeaders(req.headers),
      });
      if (environmentId) {
        writeStoredActiveEnvironmentId(environmentId);
      }
    },
    [environments, parseHeaders],
  );

  const selectRequest = useCallback(
    (req: SavedHttpRequest) => {
      const alreadySelected = selectedRequestIdRef.current === req.id;
      if (!alreadySelected) {
        applySavedRequest(req);
        setSelectedRequestId(req.id);
      }
    },
    [applySavedRequest],
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
        pathParams: "[]",
        body: "",
        authType: "",
        authValue: "",
        collectionId: null,
        environmentId: null,
        createdAt: now,
        updatedAt: now,
      };
      const res = await persistHttpRequest(req);
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
        return req;
      }
      console.error("[protocol] create request failed:", res.error);
      return null;
    },
    [loadSavedRequests],
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
      const res = await persistHttpRequest(req);
      if (res.status === "ok") {
        await loadSavedRequests();
        setSelectedRequestId(req.id);
        useProtocolHttpDockStore.getState().openTab(req.id);
        useProtocolWorkspaceStore.getState().openSessionTab({
          protocol: "http",
          resourceId: req.id,
          label: req.name,
        });
        return req.id;
      }
      return null;
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
      const res = await persistHttpRequest(req);
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
      const res = await persistHttpRequest(req);
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
      const res = await persistHttpRequest(req);
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
      environmentId: string | null;
      statusCode: number | null;
      responseTimeMs: number | null;
      requestSize: number | null;
      responseSize: number | null;
      response: HttpResponseData;
      curlCommand?: string | null;
      requestId?: string | null;
    }) => {
      const historyId = generateId();
      const responseFields = responseDataToHistoryFields(data.response);
      const requestId =
        data.requestId !== undefined ? data.requestId : selectedRequestIdRef.current;
      const entry = {
        id: historyId,
        label: "",
        method: data.method,
        url: data.url,
        statusCode: data.statusCode,
        responseTimeMs: data.responseTimeMs,
        requestSize: data.requestSize,
        responseSize: data.responseSize,
        createdAt: Date.now(),
        requestId,
        environmentId: data.environmentId,
        responseStatusText: responseFields.responseStatusText,
        responseContentType: responseFields.responseContentType,
        responseHeaders: responseFields.responseHeaders,
        responseBody: responseFields.responseBody,
        requestCurl: data.curlCommand?.trim() || "",
      } as HttpHistoryEntry & { requestCurl?: string };
      const res = await commands.httpAddHistory(entry);
      if (res.status === "ok") {
        addResponseSession(data.response, historyId, data.curlCommand);
        await loadHistory();
      }
    },
    [addResponseSession, loadHistory],
  );

  const value = useMemo<ProtocolHttpContextValue>(
    () => ({
      history,
      collections,
      environments,
      savedRequests,
      selectedRequestId,
      activeCollectionId,
      setActiveCollectionId,
      editor,
      setEditor,
      loadHistory,
      loadCollections,
      loadEnvironments,
      loadSavedRequests,
      saveEnvironment,
      deleteEnvironment,
      createCollection,
      deleteCollection,
      deleteSavedRequest,
      deleteHistoryEntry,
      renameHistoryEntry,
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
      environments,
      savedRequests,
      selectedRequestId,
      activeCollectionId,
      editor,
      setEditor,
      loadHistory,
      loadCollections,
      loadEnvironments,
      loadSavedRequests,
      saveEnvironment,
      deleteEnvironment,
      createCollection,
      deleteCollection,
      deleteSavedRequest,
      deleteHistoryEntry,
      renameHistoryEntry,
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

