import { useCallback, useEffect, useRef, useState } from "react";
import type { TextEditorIO } from "./types";

export function useTextEditorDocument(io: TextEditorIO | null, enabled = true) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const savedRef = useRef("");
  const ioRef = useRef(io);
  ioRef.current = io;

  const dirty = text !== savedRef.current;

  const reload = useCallback(async () => {
    const current = ioRef.current;
    if (!current) return;
    setLoading(true);
    setError(null);
    try {
      const content = await current.readText();
      savedRef.current = content;
      setText(content);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      savedRef.current = "";
      setText("");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !io) {
      setLoading(false);
      setError(null);
      savedRef.current = "";
      setText("");
      return;
    }
    void reload();
  }, [enabled, io, reload]);

  const save = useCallback(async () => {
    const current = ioRef.current;
    if (!current || text === savedRef.current) return;
    await current.writeText(text);
    savedRef.current = text;
  }, [text]);

  const canSave = Boolean(io) && dirty && !loading && !error;

  return {
    loading,
    error,
    text,
    setText,
    dirty,
    canSave,
    save,
    reload,
  };
}
