import { describe, expect, it } from 'vitest'

interface BrowserWorker {
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onerror: ((event: { readonly message?: string }) => void) | null
  terminate(): void
}
interface WorkerConstructor {
  new (url: URL, options?: { readonly type?: 'classic' | 'module' }): BrowserWorker
}

const GlobalWorker = (globalThis as unknown as { readonly Worker?: WorkerConstructor }).Worker

describe('in a dedicated Web Worker', () => {
  it.skipIf(typeof GlobalWorker !== 'function')('runs cleanly with no window, no document, and no setImmediate', async () => {
    const WorkerCtor = GlobalWorker!
    const worker = new WorkerCtor(new URL('./support/clock-worker.ts', import.meta.url), { type: 'module' })
    try {
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        worker.onmessage = (event) => { resolve(event.data as Record<string, unknown>) }
        worker.onerror = (event) => { reject(new Error(event.message ?? 'worker error')) }
      })
      expect(result).toEqual({
        ok: true,
        hasWindow: false,
        hasSetImmediate: false,
        ran: ['zero-1', 'zero-2:1', 'delayed'],
        abortResult: 'worker-abort',
        closedAfter: true,
        pending: 0,
      })
    } finally {
      worker.terminate()
    }
  })
})
