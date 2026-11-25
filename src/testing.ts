// Deterministic virtual-time driver for tests (`@apackdev/clock/testing`).
//
// Wraps the real `ClockController` through `ClockSources` rather than reimplementing a second clock, so tests
// exercise 100% of production semantics (monotonic clamping, `MAX_TIMER_MS` hops, `AbortSignal`, `ClockClosedError`,
// one-callback-per-turn isolation, and `suspend`/`resume`) with zero drift and O(1) driver state.
import { ClockController, clockInternals, type Clock } from './clock.ts'

export interface TestClockOptions {
  /** Initial wall-clock reading in milliseconds since 1970, or a `Date` (default `0`). */
  readonly wall?: number | Date
  /** Maximum dispatched callbacks per `advance()` or `drain()` call before throwing `RangeError` (default `10_000`). */
  readonly maxSteps?: number
}

const DEFAULT_MAX_STEPS = 10_000

const toWall = (value: number | Date): number => (typeof value === 'number' ? value : value.getTime())

/**
 * Deterministic test controller built on `ClockController` via `ClockSources`.
 *
 * Hand `testClock.clock` to code under test and drive virtual time with `await testClock.advance(ms)`,
 * `await testClock.next()`, `await testClock.drain()`, and `testClock.setWall(ms)`.
 */
export class TestClock {
  /** Frozen consumer `Clock` from the underlying `ClockController`. */
  readonly clock: Clock
  /** Virtual monotonic time elapsed since this `TestClock` was created, in milliseconds (starts at `0`). */
  readonly elapsed: () => number
  /** Count of entries currently waiting to run. */
  readonly waiting: () => number
  /** Suspends counting: elapsed virtual time until `resume()` is not counted against waiting entries. */
  readonly suspend: () => void
  /** Resumes counting from the current virtual monotonic timestamp. */
  readonly resume: () => void
  /** Closes the underlying clock and releases the driver's microtask barrier channel. */
  readonly close: () => void
  /**
   * Advances virtual time by finite non-negative `ms`, jumping event-by-event across due callbacks (including
   * sub-millisecond and multi-hop waits) and flushing microtasks after every callback.
   * Throws `RangeError` if `ms` is invalid, `elapsed() + ms` overflows, or `maxSteps` is exceeded.
   * If a callback throws, advancement stops at that callback's timestamp and the error rejects this promise.
   */
  readonly advance: (ms: number) => Promise<void>
  /**
   * Runs the next due user callback (crossing any cancelled turns or internal `MAX_TIMER_MS` hops transparently)
   * and flushes microtasks. Returns `true` if a callback ran, or `false` when idle, suspended, or closed.
   */
  readonly next: () => Promise<boolean>
  /**
   * Runs all due callbacks in order until nothing runnable remains, flushing microtasks after each callback.
   * Throws `RangeError` if dispatched callbacks exceed `maxSteps`.
   */
  readonly drain: () => Promise<void>
  /** Sets the virtual wall-clock reading (number or `Date`, forward, backward, or non-finite) without moving monotonic time. */
  readonly setWall: (wall: number | Date) => void

  constructor(options: TestClockOptions = {}) {
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) {
      throw new RangeError(`TestClock expects maxSteps to be a positive safe integer, and was given ${String(maxSteps)}`)
    }

    let mono = 0
    let wall = toWall(options.wall ?? 0)
    let armed: (() => void) | undefined
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
      timer: (_ms, run) => {
        armed = run
        return () => { armed = undefined }
      },
      turn: (run) => {
        pendingTurn = run
      },
    })
    const internal = clockInternals.get(controller)!

    const stepOne = (limit: number): boolean => {
      if (pendingTurn) {
        const run = pendingTurn
        pendingTurn = undefined
        run()
        return true
      }
      if (armed) {
        // Jump straight to the exact deadline `nextDue()` in O(1): fractional waits fire at their exact deadline,
        // and extreme durations never stall or spin through intermediate `MAX_TIMER_MS` hops.
        const wakeAt = internal.nextDue()
        if (wakeAt <= limit) {
          if (!Number.isFinite(wakeAt)) {
            throw new RangeError('TestClock cannot advance to a non-finite deadline')
          }
          const run = armed
          armed = undefined
          const delta = wakeAt - mono
          mono = wakeAt
          wall += delta
          run()
          return true
        }
      }
      return false
    }

    const hasWorkUpTo = (limit: number): boolean =>
      (pendingTurn !== undefined && controller.waiting() > 0) ||
      (armed !== undefined && internal.nextDue() <= limit)

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

    const runUntil = async (limit: number, label: string): Promise<void> => {
      await flush()
      let steps = 0
      while (true) {
        const before = internal.dispatched()
        if (!stepOne(limit)) break
        if (internal.dispatched() > before) {
          await flush()
          if (++steps >= maxSteps && hasWorkUpTo(limit)) {
            throw new RangeError(`TestClock exceeded maxSteps (${maxSteps}) during ${label}`)
          }
        }
      }
    }

    this.clock = controller.clock
    this.elapsed = () => mono
    this.waiting = controller.waiting
    this.suspend = controller.suspend
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
      if (!Number.isFinite(target)) {
        throw new RangeError(`TestClock.advance(${String(ms)}) would overflow virtual monotonic time`)
      }
      await runUntil(target, `advance(${ms})`)
      const remaining = target - mono
      mono = target
      wall += remaining
    })
    this.next = () => guard(async () => {
      await flush()
      const before = internal.dispatched()
      while (stepOne(Number.POSITIVE_INFINITY)) {
        if (internal.dispatched() > before) {
          await flush()
          return true
        }
      }
      return false
    })
    this.drain = () => guard(() => runUntil(Number.POSITIVE_INFINITY, 'drain()'))
    this.setWall = (next) => { wall = toWall(next) }
  }
}
