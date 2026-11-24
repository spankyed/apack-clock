// Runs inside a real browser DedicatedWorkerGlobalScope (no window, no document, no setImmediate).
import { clock, ClockClosedError } from '../../src/index.ts'

const workerScope = globalThis as unknown as {
  readonly window?: unknown
  readonly setImmediate?: unknown
  postMessage(message: unknown): void
}

const run = async (): Promise<void> => {
  const time = clock()
  try {
    const view = time.view()
    const ran: string[] = []
    let microtasks = 0
    view.after(0, () => { ran.push('zero-1'); void Promise.resolve().then(() => { microtasks++ }) })
    view.after(0, () => { ran.push(`zero-2:${microtasks}`) })
    view.after(15, () => { ran.push('delayed') })
    const controller = new AbortController()
    const aborted = view.sleep(5_000, { signal: controller.signal }).then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    controller.abort(new Error('worker-abort'))
    const abortResult = await aborted
    await view.sleep(35)
    time.close()
    let closedAfter = false
    try { view.after(1, () => {}) } catch (error) { closedAfter = error instanceof ClockClosedError }
    workerScope.postMessage({
      ok: true,
      hasWindow: typeof workerScope.window !== 'undefined',
      hasSetImmediate: typeof workerScope.setImmediate !== 'undefined',
      ran,
      abortResult,
      closedAfter,
      pending: time.pending(),
    })
  } catch (error) {
    time.close()
    workerScope.postMessage({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) })
  }
}

void run()
