// Small promise-based RPC wrapper around the data worker.

type Pending = { resolve: (v: any) => void; reject: (e: any) => void; onProgress?: (p: any) => void };

export class WorkerError extends Error {
  cancelled: boolean;
  constructor(msg: string, cancelled: boolean) { super(msg); this.cancelled = cancelled; }
}

export class DataClient {
  private worker: Worker;
  private seq = 1;
  private pending = new Map<number, Pending>();
  onCrash: ((msg: string) => void) | null = null;

  constructor() {
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const w = new Worker(new URL('../worker/data.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if ('progress' in m) { p.onProgress?.(m.progress); return; }
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new WorkerError(m.error, !!m.cancelled));
    };
    w.onerror = (e) => {
      const msg = 'The data engine stopped unexpectedly (often because the browser ran out of memory). Please reload the page and try with fewer or smaller files.';
      for (const p of this.pending.values()) p.reject(new WorkerError(msg, false));
      this.pending.clear();
      this.onCrash?.(msg + (e.message ? ` (${e.message})` : ''));
    };
    return w;
  }

  /** Returns [promise, jobId] so long jobs can be cancelled. */
  call<T = any>(type: string, args: any[] = [], onProgress?: (p: any) => void): Promise<T> {
    return this.start<T>(type, args, onProgress)[0];
  }

  start<T = any>(type: string, args: any[] = [], onProgress?: (p: any) => void): [Promise<T>, number] {
    const id = this.seq++;
    const pr = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, type, args });
    });
    return [pr, id];
  }

  cancel(jobId: number) {
    this.worker.postMessage({ id: this.seq++, type: 'cancel', args: [jobId] });
  }

  /** Hard reset: terminate and restart the worker, releasing all memory. */
  restart() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new WorkerError('cancelled', true));
    this.pending.clear();
    this.worker = this.spawn();
  }
}
