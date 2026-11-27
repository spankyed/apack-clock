// Deterministic virtual-time driver for tests (`@apackdev/clock/testing`).
//
// Wraps the real `ClockController` through `ClockSources` rather than reimplementing a second clock, so tests
// exercise production semantics (monotonic clamping, `AbortSignal`, `ClockClosedError`, one-callback-per-turn
// isolation, and `suspend`/`resume`) with zero drift and O(1) direct deadline jumps.
import { ClockController, clockInternals, type Clock } from './clock.ts'

export interface TestClockOptions {
  /** Initial wall-clock reading in milliseconds since 1970, or a `Date` (default `0`). */
  readonly wall?: number | Date
  /** Maximum dispatched callbacks per `advance()` or `drain()` call before throwing `RangeError` (default `10_000`). */
  readonly maxSteps?: number
}

const DEFAULT_MAX_STEPS = 10_000

const f64 = new Float64Array(1)
const u64 = new BigUint64Array(f64.buffer)
/** Smallest float64 strictly greater than positive finite `x` (maps `Number.MAX_VALUE` to `+Infinity`). */
const nextUpPositive = (x: number): number => {
  f64[0] = x
  u64[0] = u64[0]! + 1n
  return f64[0]!
}

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
  /** Total virtual monotonic ms elapsed (starts at `0`; includes suspended time, unlike `clock.monotonic()`). */
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
   * Advances both virtual monotonic and wall time by finite non-negative `ms`, jumping event-by-event across due
   * callbacks (including fractional and multi-decade waits) and flushing microtasks after every callback.
   * Throws `RangeError` if `ms` is invalid, `elapsed() + ms` overflows, or `maxSteps` is exceeded.
   * If a callback throws, advancement stops at that callback's timestamp and the error rejects this promise.
   */
  readonly advance: (ms: number) => Promise<void>
  /**
   * Runs the next due callback (advancing virtual monotonic and wall time, skipping cancelled turns) and flushes
   * microtasks. Returns `false` when idle, suspended, or closed; rejects with `RangeError` past `Number.MAX_VALUE`.
   */
  readonly next: () => Promise<boolean>
  /**
   * Runs all due callbacks in order, flushing microtasks after each.
   * Rejects with `RangeError` if callbacks exceed `maxSteps` or a deadline exceeds `Number.MAX_VALUE`.
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
    let suspended = false
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

    const nextRawDue = (): number => {
      const due = internal.nextDue()
      const base = internal.activeBase()
      const anchor = internal.resumeAnchor()
      let wakeAt = anchor + (due - base)
      while (base + (wakeAt - anchor) < due) wakeAt = nextUpPositive(wakeAt)
      return wakeAt
    }

    const stepOne = (limit: number): boolean => {
      if (pendingTurn) {
        const run = pendingTurn
        pendingTurn = undefined
        run()
        return true
      }
      if (armed) {
        // Jump straight to the exact finite raw deadline in O(1): fractional waits fire at their exact deadline,
        // and extreme durations never stall or spin through intermediate `MAX_TIMER_MS` hops.
        const wakeAt = nextRawDue()
        if (wakeAt <= limit) {
          if (!Number.isFinite(wakeAt)) {
            throw new RangeError('TestClock cannot advance to a deadline beyond Number.MAX_VALUE')
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
      !suspended && controller.waiting() > 0 && nextRawDue() <= limit

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
    this.suspend = () => {
      suspended = true
      controller.suspend()
    }
    this.resume = () => {
      suspended = false
      controller.resume()
    }
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
