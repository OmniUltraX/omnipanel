import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { logDockerDrag, snapshotDataTransfer } from "@/modules/docker/dockerDragDebug";
export type DockerServiceGroup = {
  id: string;
  name: string;
  containerIds: string[];
};

type DockerServiceGroupState = {
  groupsByConnection: Record<string, DockerServiceGroup[]>;
  getGroups: (connectionId: string) => DockerServiceGroup[];
  getGroup: (connectionId: string, groupId: string) => DockerServiceGroup | undefined;
  getContainerGroupId: (connectionId: string, containerId: string) => string | null;
  createGroup: (connectionId: string, name: string) => string;
  renameGroup: (connectionId: string, groupId: string, name: string) => void;
  deleteGroup: (connectionId: string, groupId: string) => void;
  assignContainerToGroup: (
    connectionId: string,
    containerId: string,
    groupId: string | null,
  ) => void;
};

function makeGroupId(): string {
  return `svcgrp:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeContainerId(containerId: string): string {
  return containerId.trim().toLowerCase();
}

const EMPTY_SERVICE_GROUPS: DockerServiceGroup[] = [];

export function selectDockerServiceGroups(connectionId: string) {
  return (state: DockerServiceGroupState) =>
    state.groupsByConnection[connectionId] ?? EMPTY_SERVICE_GROUPS;
}

export function selectDockerServiceGroup(connectionId: string, groupId: string) {
  return (state: DockerServiceGroupState) =>
    state.groupsByConnection[connectionId]?.find((group) => group.id === groupId);
}

export const useDockerServiceGroupStore = create<DockerServiceGroupState>()(
  persist(
    (set, get) => ({
      groupsByConnection: {},

      getGroups: (connectionId) =>
        get().groupsByConnection[connectionId] ?? EMPTY_SERVICE_GROUPS,

      getGroup: (connectionId, groupId) =>
        get().groupsByConnection[connectionId]?.find((group) => group.id === groupId),

      getContainerGroupId: (connectionId, containerId) => {
        const needle = normalizeContainerId(containerId);
        for (const group of get().getGroups(connectionId)) {
          if (group.containerIds.some((id) => normalizeContainerId(id) === needle)) {
            return group.id;
          }
        }
        return null;
      },

      createGroup: (connectionId, name) => {
        const trimmed = name.trim();
        if (!trimmed) return "";
        const id = makeGroupId();
        set((state) => ({
          groupsByConnection: {
            ...state.groupsByConnection,
            [connectionId]: [
              ...(state.groupsByConnection[connectionId] ?? []),
              { id, name: trimmed, containerIds: [] },
            ],
          },
        }));
        return id;
      },

      renameGroup: (connectionId, groupId, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        set((state) => ({
          groupsByConnection: {
            ...state.groupsByConnection,
            [connectionId]: (state.groupsByConnection[connectionId] ?? []).map((group) =>
              group.id === groupId ? { ...group, name: trimmed } : group,
            ),
          },
        }));
      },

      deleteGroup: (connectionId, groupId) => {
        set((state) => ({
          groupsByConnection: {
            ...state.groupsByConnection,
            [connectionId]: (state.groupsByConnection[connectionId] ?? []).filter(
              (group) => group.id !== groupId,
            ),
          },
        }));
      },

      assignContainerToGroup: (connectionId, containerId, groupId) => {
        const needle = normalizeContainerId(containerId);
        set((state) => {
          const nextGroups = (state.groupsByConnection[connectionId] ?? []).map((group) => ({
            ...group,
            containerIds: group.containerIds.filter((id) => normalizeContainerId(id) !== needle),
          }));

          if (groupId) {
            const targetIndex = nextGroups.findIndex((group) => group.id === groupId);
            if (targetIndex >= 0) {
              const target = nextGroups[targetIndex];
              if (!target.containerIds.some((id) => normalizeContainerId(id) === needle)) {
                nextGroups[targetIndex] = {
                  ...target,
                  containerIds: [...target.containerIds, containerId],
                };
              }
            }
          }

          return {
            groupsByConnection: {
              ...state.groupsByConnection,
              [connectionId]: nextGroups,
            },
          };
        });
      },
    }),
    {
      name: "omnipanel-docker-service-groups.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ groupsByConnection: state.groupsByConnection }),
    },
  ),
);

export const DOCKER_CONTAINER_DRAG_MIME = "application/x-omnipanel-docker-container";

export type DockerContainerDragPayload = {
  connectionId: string;
  containerId: string;
};

export function readDockerContainerDragPayload(
  dataTransfer: DataTransfer,
): DockerContainerDragPayload | null {
  const snapshot = snapshotDataTransfer(dataTransfer);
  let raw = dataTransfer.getData(DOCKER_CONTAINER_DRAG_MIME);
  let source: "custom-mime" | "text-plain" | null = raw ? "custom-mime" : null;
  if (!raw) {
    raw = dataTransfer.getData("text/plain");
    source = raw ? "text-plain" : null;
  }
  if (!raw) {
    logDockerDrag("payload:empty", snapshot);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as DockerContainerDragPayload;
    if (!parsed.connectionId || !parsed.containerId) {
      logDockerDrag("payload:invalid-shape", { source, raw, parsed, ...snapshot });
      return null;
    }
    logDockerDrag("payload:ok", { source, parsed });
    return parsed;
  } catch (error) {
    logDockerDrag("payload:parse-error", { source, raw, error: String(error), ...snapshot });
    return null;
  }
}