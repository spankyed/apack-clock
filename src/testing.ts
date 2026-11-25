// Deterministic virtual-time driver for tests (`@apackdev/clock/testing`).
//
// Wraps the real `ClockController` through `ClockSources` rather than reimplementing a second clock, so tests
// exercise 100% of production semantics (monotonic clamping, `MAX_TIMER_MS` hops, `AbortSignal`, `ClockClosedError`,
// one-callback-per-turn isolation, and `suspend`/`resume`) with zero drift and O(1) driver state.
import { ClockController, type Clock } from './index.ts'

export interface TestClockOptions {
  /** Initial wall-clock reading in milliseconds since 1970 (default `0`). */
  readonly wall?: number
  /** Maximum turns or timer hops per `advance()` or `drain()` call before throwing `RangeError` (default `10_000`). */
  readonly maxSteps?: number
}

const DEFAULT_MAX_STEPS = 10_000

/**
 * Deterministic test controller built on `ClockController` via `ClockSources`.
 *
 * Hand `testClock.clock` to code under test and drive virtual time with `await testClock.advance(ms)`,
 * `await testClock.next()`, `await testClock.drain()`, and `testClock.setWall(ms)`.
 */
export class TestClock {
  /** Frozen consumer `Clock` from the underlying `ClockController`. */
  readonly clock: Clock
  /** Count of entries currently waiting to run. */
  readonly waiting: () => number
  /** Suspends counting: elapsed virtual time until `resume()` is not counted against waiting entries. */
  readonly suspend: () => void
  /** Resumes counting from the current virtual monotonic timestamp. */
  readonly resume: () => void
  /** Closes the underlying clock and releases the driver's microtask barrier channel. */
  readonly close: () => void
  /**
   * Advances virtual time by finite non-negative `ms`, jumping event-by-event across pending turns and timer hops
   * and flushing microtasks after every step. Throws `RangeError` if `ms` is invalid or `maxSteps` is exceeded.
   */
  readonly advance: (ms: number) => Promise<void>
  /**
   * Runs the next pending turn, or jumps directly to the next armed timer wakeup and runs it, flushing microtasks.
   * Returns `true` if a step ran, or `false` when nothing is queued or armed.
   * Waits longer than `MAX_TIMER_MS` wake in `MAX_TIMER_MS` hops; use `advance(ms)` or `drain()` to cross them in one call.
   */
  readonly next: () => Promise<boolean>
  /**
   * Runs `next()` repeatedly until nothing remains queued or armed, flushing microtasks after each step.
   * Throws `RangeError` if `maxSteps` is exceeded.
   */
  readonly drain: () => Promise<void>
  /** Sets the virtual wall-clock reading (forward, backward, or non-finite) without moving monotonic time. */
  readonly setWall: (ms: number) => void

  constructor(options: TestClockOptions = {}) {
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
      throw new RangeError(`TestClock expects maxSteps to be a positive safe integer, and was given ${String(maxSteps)}`)
    }

    let mono = 0
    let wall = options.wall ?? 0
    let armed: { readonly due: number; readonly run: () => void } | undefined
    let pendingTurn: (() => void) | undefined
    let stepping = false
    let closed = false

    let channel: InstanceType<typeof MessageChannel> | undefined
    let port1: { onmessage: (() => void) | null; ref?: () => void; unref?: () => void } | undefined
    let onFlush: (() => void) | undefined

    const closeChannel = (): void => {
      if (!channel) return
      port1!.onmessage = null
      channel.port1.close()
      channel.port2.close()
      channel = undefined
      port1 = undefined
    }

    /** Macrotask barrier: resolves only after every queued microtask has settled, without holding Node open when idle. */
    const flush = (): Promise<void> => new Promise((resolve) => {
      if (!channel) {
        channel = new MessageChannel()
        port1 = channel.port1 as unknown as { onmessage: (() => void) | null; ref?: () => void; unref?: () => void }
        port1.onmessage = () => {
          port1!.unref?.()
          const done = onFlush!
          onFlush = undefined
          done()
        }
      }
      onFlush = resolve
      port1!.ref?.()
      channel.port2.postMessage(0)
    })

    const controller = new ClockController({
      monotonic: () => mono,
      wall: () => wall,
      timer: (ms, run) => {
        armed = { due: mono + ms, run }
        return () => { armed = undefined }
      },
      turn: (run) => {
        pendingTurn = run
      },
    })

    const stepOne = (limit: number): boolean => {
      if (pendingTurn) {
        const run = pendingTurn
        pendingTurn = undefined
        run()
        return true
      }
      if (armed && armed.due <= limit) {
        const { due, run } = armed
        armed = undefined
        const delta = due - mono
        mono = due
        wall += delta
        run()
        return true
      }
      return false
    }

    const guard = async <T>(work: () => Promise<T>): Promise<T> => {
      if (stepping) throw new Error('TestClock is already stepping; await the previous advance, next, or drain call first')
      stepping = true
      try {
        return await work()
      } finally {
        stepping = false
        if (closed) closeChannel()
      }
    }

    this.clock = controller.clock
    this.waiting = controller.waiting
    this.suspend = () => {
      controller.suspend()
      // Drain any pre-suspend turn now: `ClockController` already marked itself suspended, so it only clears `turning`.
      if (pendingTurn) {
        const run = pendingTurn
        pendingTurn = undefined
        run()
      }
    }
    this.resume = controller.resume
    this.close = () => {
      closed = true
      controller.close()
      pendingTurn = undefined
      if (!stepping) closeChannel()
    }
    this.advance = (ms) => guard(async () => {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError(`TestClock.advance expects a finite non-negative duration, and was given ${String(ms)}`)
      }
      const target = mono + ms
      await flush()
      let steps = 0
      while (stepOne(target)) {
        await flush()
        if (++steps >= maxSteps && (pendingTurn !== undefined || (armed !== undefined && armed.due <= target))) {
          throw new RangeError(`TestClock exceeded maxSteps (${maxSteps}) during advance(${ms})`)
        }
      }
      const remaining = target - mono
      mono = target
      wall += remaining
    })
    this.next = () => guard(async () => {
      await flush()
      if (!stepOne(Number.POSITIVE_INFINITY)) return false
      await flush()
      return true
    })
    this.drain = () => guard(async () => {
      await flush()
      let steps = 0
      while (stepOne(Number.POSITIVE_INFINITY)) {
        await flush()
        if (++steps >= maxSteps && (pendingTurn !== undefined || armed !== undefined)) {
          throw new RangeError(`TestClock exceeded maxSteps (${maxSteps}) during drain()`)
        }
      }
    })
    this.setWall = (ms) => { wall = ms }
  }
}
