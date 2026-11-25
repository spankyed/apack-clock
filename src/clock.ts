// A clock a program is handed in place of `setTimeout` and `Date.now()`: something to run after this long, and the
// time it is. One `DeadlineQueue` of what waits, ordered by when each is due, and at most one armed timer for what is
// due first.
//
// How long is counted on `monotonic`, so setting the time of day moves nothing that waits. The time it is comes from
// `wall`, and is never earlier than what `now` last said.
//
// What it reads and what wakes it are handed in (`ClockSources`). A program hands in nothing and gets the real ones; a
// spec hands in its own and chooses when each thing happens.
import { DeadlineQueue } from './queue.ts'

/** What a clock reads and is woken by. Each is the real one unless given. */
export interface ClockSources {
  /** Milliseconds on a clock that only goes forward, from any start: `performance.now()`. Must stay finite and never decrease. */
  monotonic(): number
  /** The time of day, in milliseconds since 1970: `Date.now()`. May go back or read non-finite; `now` never follows it back. */
  wall(): number
  /**
   * Calls `run` once, about `ms` from now, unless what it returns is called first: `setTimeout`. Must not invoke `run`
   * inline, and must return a cancel function. May wake early, late, or stale. `ms` is always finite in `(0, MAX_TIMER_MS]`.
   */
  timer(ms: number, run: () => void): () => void
  /** Calls `run` on a later turn of the event loop, in the order asked. Must not invoke `run` inline. */
  turn(run: () => void): void
}

export interface ClockSleepOptions {
  /** Aborts the sleep, calling off what waits and rejecting with `signal.reason`. */
  readonly signal?: AbortSignal
}

/**
 * Thrown by `after`, or rejected from `sleep`, once the clock is closed.
 * Match by `error instanceof Error && error.name === 'ClockClosedError'` rather than `instanceof` across realms or
 * duplicate package copies.
 */
export class ClockClosedError extends Error {
  constructor() {
    super('The clock is closed; nothing new may be asked of it')
    this.name = 'ClockClosedError'
  }
}

/** What a consumer is handed: read what is said and wait, with no authority to suspend or close the clock. */
export interface Clock {
  /**
   * The time of day, in milliseconds since 1970, and never earlier than what this clock last said: where `wall` goes
   * back or reads non-finite, it keeps what it last said until `wall` passes that.
   *
   * Note: `now()` is wall time (`Date.now()`), not monotonic time; `now() + ms` is not when `after(ms)` fires.
   */
  now(): number
  /**
   * Runs `run` once when `ms` have passed on `monotonic`, unless what it returns is called first. Never before it is
   * due, and never inline: on a turn of its own, alone. Of two due at the same moment, the one asked first runs first.
   * Less than nothing is nothing. Throws `RangeError` for a non-finite `ms`, and `ClockClosedError` once closed.
   */
  after(ms: number, run: () => void): () => void
  /**
   * Resolves when `ms` have passed, as `after` runs. Rejects with `RangeError` for a non-finite `ms`, with
   * `signal.reason` if `options.signal` aborts, or with `ClockClosedError` if the clock is closed.
   */
  sleep(ms: number, options?: ClockSleepOptions): Promise<void>
}

/** The longest a timer is set for, in milliseconds: a longer wait wakes in hops of at most `MAX_TIMER_MS`. */
export const MAX_TIMER_MS = 0x7fffffff

const assertFinite = (ms: number): void => {
  if (!Number.isFinite(ms)) throw new RangeError(`A clock expects a finite wait in milliseconds, and was given ${String(ms)}`)
}

/** Turns of the event loop, using `setImmediate` where present and a reused `MessageChannel` otherwise. */
const makeTurns = (): { readonly turn: ClockSources['turn']; close(): void } => {
  if (typeof setImmediate === 'function') {
    const handles = new Set<ReturnType<typeof setImmediate>>()
    return {
      turn: (run) => {
        const handle = setImmediate(() => {
          handles.delete(handle)
          run()
        })
        handles.add(handle)
      },
      close: () => {
        for (const handle of handles) clearImmediate(handle)
        handles.clear()
      },
    }
  }
  const asked: Array<() => void> = []
  let channel: InstanceType<typeof MessageChannel> | undefined
  let port1: { onmessage: (() => void) | null; unref?: () => void } | undefined
  return {
    turn: (run) => {
      if (!channel) {
        channel = new MessageChannel()
        // Node's types omit `onmessage` on MessagePort, and both Node and browsers provide it.
        port1 = channel.port1 as unknown as { onmessage: (() => void) | null; unref?: () => void }
        port1.onmessage = () => { asked.shift()!() }
        port1.unref?.()
      }
      asked.push(run)
      channel.port2.postMessage(0)
    },
    close: () => {
      if (!channel) return
      port1!.onmessage = null
      channel.port1.close()
      channel.port2.close()
      channel = undefined
      port1 = undefined
      asked.length = 0
    },
  }
}

/** Package-internal hooks used by `@apackdev/clock/testing`; never re-exported from `@apackdev/clock`. */
export interface ClockInternal {
  /** Exact monotonic deadline of the earliest waiting entry (only called while a timer is armed). */
  readonly nextDue: () => number
  /** Count of due user callbacks dispatched so far (never incremented by internal hops or cancelled/suspended wakes). */
  readonly dispatched: () => number
}

/** Package-internal registry mapping each `ClockController` to its inspection hooks. */
export const clockInternals = new WeakMap<ClockController, ClockInternal>()

/**
 * Host-owned controller for a clock, separate from `Clock` itself (as `AbortController` is separate from `AbortSignal`):
 * hand `controller.clock` to consumers so host lifecycle controls cannot leak by mistake.
 */
export class ClockController {
  /** Frozen consumer `Clock` exposing only `now`, `after`, and `sleep`. */
  readonly clock: Clock
  /** How many entries currently wait to run. */
  readonly waiting: () => number
  /**
   * Suspends counting: nothing runs, no timer stays armed, and what passes until `resume` is not counted against what
   * waits. For whoever receives OS power events (`powerMonitor` `suspend` / `resume`) where `monotonic` ticks through sleep.
   */
  readonly suspend: () => void
  /** Resumes counting from here, shifting what waits by the suspended span. */
  readonly resume: () => void
  /** Closes the clock: calls off everything that waits, disarms any timer, rejects pending sleeps, and refuses later asks. */
  readonly close: () => void

  /** Creates a clock controller on the real sources, or on what is given in place of any of them. */
  constructor(given: Partial<ClockSources> = {}) {
    const ownedTurns = given.turn ? undefined : makeTurns()
    const from: ClockSources = {
      monotonic: given.monotonic ?? (() => performance.now()),
      wall: given.wall ?? (() => Date.now()),
      timer: given.timer ?? ((ms, run) => { const timer = setTimeout(run, ms); return () => { clearTimeout(timer) } }),
      turn: given.turn ?? ownedTurns!.turn,
    }

    /** Policy-neutral indexed min-heap of what waits: earliest due first, then lowest `seq`. */
    const queue = new DeadlineQueue<() => void>()
    /** The one armed timer, tagged by identity so a stale wakeup cannot disarm a newer one. */
    let armed: { readonly token: object; readonly cancel: () => void } | undefined
    /** Whether a turn has already been asked for to run what is due. */
    let turning = false
    /** Whether a due callback is running now: delays re-arming until `finally` so edits inside it arm once. */
    let running = false
    /** Reading of `monotonic` when counting suspended, while suspended. */
    let suspended: number | undefined
    let closed = false
    /** Latest finite reading of `wall` that `now` has said. */
    let said = Number.NEGATIVE_INFINITY
    /** Pending sleeps rejected with `ClockClosedError` if the clock closes first. */
    const sleepers = new Set<() => void>()
    /** Count of due entries actually dispatched to user callbacks. */
    let dispatched = 0

    const disarm = (): void => {
      if (!armed) return
      const { cancel } = armed
      armed = undefined
      cancel()
    }

    /** Sees to what is due first: asks for a turn if it is due now, or arms one hop if it is not. */
    const arm = (): void => {
      if (running || closed || turning || suspended !== undefined) return
      disarm()
      const first = queue.peek()
      if (!first) return
      const left = first.due - from.monotonic()
      if (left <= 0) {
        turning = true
        from.turn(() => { turning = false; next() })
        return
      }
      const token = {}
      const cancel = from.timer(Math.min(Math.ceil(left), MAX_TIMER_MS), () => {
        if (armed?.token !== token) return
        armed = undefined
        next()
      })
      armed = { token, cancel }
    }

    /** Runs what is due first if its moment has arrived, and only it: each entry runs on a turn of its own. */
    const next = (): void => {
      if (closed || suspended !== undefined) return
      const first = queue.popDue(from.monotonic())
      if (!first) { arm(); return }
      dispatched++
      // Whatever it throws is handed on, and what still waits is seen to either way.
      running = true
      try { first.value() } finally { running = false; arm() }
    }

    const now: Clock['now'] = () => {
      const wall = from.wall()
      if (Number.isFinite(wall)) said = Math.max(said, wall)
      return said
    }

    const after: Clock['after'] = (ms, run) => {
      assertFinite(ms)
      if (closed) throw new ClockClosedError()
      const wasHead = queue.peek()
      const entry = queue.push((suspended ?? from.monotonic()) + Math.max(0, ms), run)
      if (queue.peek() !== wasHead) arm()
      return () => {
        const wasHead = queue.peek() === entry
        queue.remove(entry)
        if (wasHead) arm()
      }
    }

    const sleep: Clock['sleep'] = (ms, options) => new Promise((resolve, reject) => {
      assertFinite(ms)
      const signal = options?.signal
      if (signal?.aborted) { reject(signal.reason); return }

      let cancel: () => void
      const cleanup = (): void => {
        sleepers.delete(onClose)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        cleanup()
        cancel()
        reject(signal!.reason)
      }
      const onClose = (): void => {
        cleanup()
        reject(new ClockClosedError())
      }

      cancel = after(ms, () => {
        cleanup()
        resolve()
      })
      sleepers.add(onClose)
      signal?.addEventListener('abort', onAbort)
    })

    const close = (): void => {
      closed = true
      suspended = undefined
      disarm()
      queue.clear()
      ownedTurns?.close()
      for (const onClose of [...sleepers]) onClose()
    }

    this.clock = Object.freeze({ now, after, sleep })
    this.waiting = () => queue.size
    this.suspend = () => {
      if (closed || suspended !== undefined) return
      suspended = from.monotonic()
      disarm()
    }
    this.resume = () => {
      if (suspended === undefined) return
      const span = from.monotonic() - suspended
      suspended = undefined
      queue.shift(span)
      arm()
    }
    this.close = close
    clockInternals.set(this, { nextDue: () => queue.peek()!.due, dispatched: () => dispatched })
  }
}
