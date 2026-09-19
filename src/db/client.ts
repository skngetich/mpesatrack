/**
 * Main-thread handle to the SQLite worker.
 *
 *   const info = await db.init();
 *   const rows = await db.listTransactions({ month: '2024-03' });
 *
 * `db` is fully typed from the worker's method table (DbMethods), so a new
 * worker method becomes available here without extra wiring.
 */
import type { DbMethods } from './worker';

type Api = {
  [K in keyof DbMethods]: (...args: Parameters<DbMethods[K]>) => Promise<Awaited<ReturnType<DbMethods[K]>>>;
};

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 1;

worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
  const p = pending.get(e.data.id);
  if (!p) return;
  pending.delete(e.data.id);
  if (e.data.error !== undefined) p.reject(new Error(e.data.error));
  else p.resolve(e.data.result);
};

worker.onerror = (e) => {
  // A crash while loading the worker (e.g. WASM blocked) rejects everything waiting.
  for (const p of pending.values()) p.reject(new Error(e.message || 'Database worker failed to start'));
  pending.clear();
};

export const db = new Proxy({} as Api, {
  get:
    (_t, method: string) =>
    (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, method, args });
      }),
});
