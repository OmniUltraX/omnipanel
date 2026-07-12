const PREFIX = "[docker-dnd]";

export function logDockerDrag(step: string, detail?: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  if (detail && Object.keys(detail).length > 0) {
    console.log(PREFIX, step, detail);
  } else {
    console.log(PREFIX, step);
  }
}

export function snapshotDataTransfer(dataTransfer: DataTransfer | null | undefined): Record<string, unknown> {
  if (!dataTransfer) {
    return { present: false };
  }
  const types = Array.from(dataTransfer.types);
  const snapshot: Record<string, unknown> = {
    present: true,
    types,
    effectAllowed: dataTransfer.effectAllowed,
    dropEffect: dataTransfer.dropEffect,
  };
  for (const type of types) {
    try {
      snapshot[`data:${type}`] = dataTransfer.getData(type);
    } catch (error) {
      snapshot[`data:${type}`] = `[getData failed: ${String(error)}]`;
    }
  }
  return snapshot;
}
