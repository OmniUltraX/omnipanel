import { invoke, Channel } from "@tauri-apps/api/core";

export type AiHttpStreamEvent =
  | { kind: "chunk"; data: string }
  | { kind: "error"; message: string }
  | { kind: "done"; status: number };

/** 通过 Tauri 后端 reqwest 发起流式 POST，绕过 WebView fetch 对外网的限制。 */
export function streamPostViaTauri(
  url: string,
  headers: Record<string, string>,
  body: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): AsyncIterable<string> {
  const queue: string[] = [];
  let pendingResolve: (() => void) | null = null;
  let finished = false;
  let streamError: Error | null = null;
  let invokeError: unknown = null;

  const notify = () => {
    pendingResolve?.();
    pendingResolve = null;
  };

  const waitForData = () =>
    new Promise<void>((resolve) => {
      if (queue.length > 0 || finished || streamError) {
        resolve();
        return;
      }
      pendingResolve = resolve;
    });

  const onEvent = new Channel<AiHttpStreamEvent>();
  onEvent.onmessage = (event) => {
    if (event.kind === "chunk") {
      queue.push(event.data);
      notify();
      return;
    }
    if (event.kind === "error") {
      streamError = new Error(event.message);
      finished = true;
      notify();
      return;
    }
    finished = true;
    notify();
  };

  const onAbort = () => {
    finished = true;
    notify();
  };
  options?.signal?.addEventListener("abort", onAbort);

  void invoke("ai_http_stream_post", {
    url,
    headers,
    body,
    timeoutMs: options?.timeoutMs ?? 120_000,
    onEvent,
  }).catch((error) => {
    invokeError = error;
    finished = true;
    notify();
  });

  async function* generator(): AsyncGenerator<string> {
    try {
      while (true) {
        if (options?.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        await waitForData();
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        if (streamError) {
          throw streamError;
        }
        if (finished) {
          if (invokeError) {
            throw invokeError instanceof Error ? invokeError : new Error(String(invokeError));
          }
          break;
        }
      }
    } finally {
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    [Symbol.asyncIterator]() {
      return generator();
    },
  };
}
