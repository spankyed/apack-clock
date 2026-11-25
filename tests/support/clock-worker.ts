// Runs inside a real browser DedicatedWorkerGlobalScope (no window, no document, no setImmediate).
import { ClockController } from '../../src/index.ts'
import { TestClock } from '../../src/testing.ts'

const workerScope = globalThis as unknown as {
  readonly window?: unknown
  readonly setImmediate?: unknown
  postMessage(message: unknown): void
}

const run = async (): Promise<void> => {
  const controller = new ClockController()
  const { clock } = controller
  try {
    const ran: string[] = []
    let microtasks = 0
    clock.after(0, () => { ran.push('zero-1'); void Promise.resolve().then(() => { microtasks++ }) })
    clock.after(0, () => { ran.push(`zero-2:${microtasks}`) })
    clock.after(15, () => { ran.push('delayed') })
    const abortController = new AbortController()
    const aborted = clock.sleep(5_000, { signal: abortController.signal }).then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    abortController.abort(new Error('worker-abort'))
    const abortResult = await aborted
    await clock.sleep(35)
    controller.close()
    let closedAfter = false
    try { clock.after(1, () => {}) } catch (error) { closedAfter = error instanceof Error && error.name === 'ClockClosedError' }

    const testClock = new TestClock({ wall: 100 })
    let testClockWoke = -1
    const sleepDone = testClock.clock.sleep(12.5).then(() => { testClockWoke = testClock.elapsed() })
    await testClock.advance(20)
    await sleepDone
    testClock.close()

    workerScope.postMessage({
      ok: true,
      hasWindow: typeof workerScope.window !== 'undefined',
      hasSetImmediate: typeof workerScope.setImmediate !== 'undefined',
      ran,
      abortResult,
      closedAfter,
      waiting: controller.waiting(),
      testClockWoke,
    })
  } catch (error) {
    controller.close()
    workerScope.postMessage({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) })
  }
}

void run()
