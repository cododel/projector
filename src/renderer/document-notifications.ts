import { useCallback, useEffect, useRef } from 'react';

/** Document frames publish only through their registered parent; no Electron IPC. */
export function useDocumentError(context: { artifactId: string; revisionId: string | null; paneId: string | null },
  shellOrigin: string, retry: () => Promise<void>): (error: string, operation?: string) => void {
  const retryRef = useRef(retry); retryRef.current = retry;
  const contextRef = useRef(context); contextRef.current = context;
  const registrations = useRef(new Set<string>());
  const retrying = useRef(false);
  const operations = useRef(new Map<string, string>());
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== shellOrigin || event.source !== window.parent || event.data?.type !== 'projector-notice-action' ||
        typeof event.data.id !== 'string' || typeof event.data.requestId !== 'string' || !registrations.current.has(event.data.id)) return;
      const { id, requestId } = event.data as { id: string; requestId: string };
      const reply = (error?: string) => window.parent.postMessage({ type: 'projector-notice-result', id, requestId, error }, shellOrigin);
      if (retrying.current) { reply('Another document retry is still running.'); return; }
      retrying.current = true;
      void retryRef.current().then(() => { registrations.current.delete(id);
        for (const [operation, registered] of operations.current) if (registered === id) operations.current.delete(operation);
        reply(); })
        .catch(error => reply(error instanceof Error ? error.message : String(error)))
        .finally(() => { retrying.current = false; });
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [shellOrigin]);
  return useCallback((body: string, operation = crypto.randomUUID()) => {
    if (!body) return;
    const id = operations.current.get(operation) ?? crypto.randomUUID();
    operations.current.set(operation, id); registrations.current.add(id);
    window.parent.postMessage({ type: 'projector-notice', id, body, ...contextRef.current }, shellOrigin);
  }, [shellOrigin]);
}
