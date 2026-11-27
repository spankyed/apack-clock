// A clock a program is handed in place of `setTimeout`, `Date.now()`, and `performance.now()`: something to run after
// this long, elapsed monotonic time, and the time it is. One heap of what waits, ordered by when each is due, and at
// most one armed timer for what is due first.
//
// Both `after` and `monotonic()` share one active monotonic timeline that excludes suspended spans, so setting the
// time of day moves nothing that waits and `resume()` is O(1). The time it is comes from `wall`, and is never earlier
// than what `now` last said.
//
// What it reads and what wakes it are handed in (`ClockSources`). A program hands in nothing and gets the real ones; a
// spec hands in its own and chooses when each thing happens.

/** What a clock reads and is woken by. Each is the real one unless given. */
export interface ClockSources {
  /** Milliseconds on a clock that only goes forward, from any start: `performance.now()`. Must stay finite with finite differences and never decrease. */
  monotonic(): number
  /** The time of day, in milliseconds since 1970: `Date.now()`. May go back or read non-finite; `now` throws `RangeError` until a finite reading has been seen, and never follows it back after. */
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
   * back or reads non-finite, it keeps what it last said until `wall` passes that. Throws `RangeError` if `wall` has
   * never returned a finite reading yet.
   *
   * Note: `now()` is wall time (`Date.now()`), not monotonic time; `now() + ms` is not when `after(ms)` fires.
   * Use `monotonic()` to measure elapsed durations.
   */
  now(): number
  /**
   * Monotonic time in milliseconds from an arbitrary origin, never decreasing and excluding suspended spans.
   * Subtract two readings (`clock.monotonic() - start`) to measure elapsed duration on the same timeline as `after()`
   * and `sleep()`, unaffected by wall-clock jumps.
   */
  monotonic(): number
  /**
   * Runs `run` once when `ms` have passed on `monotonic()`, unless what it returns is called first. Never before it is
   * due (to IEEE-754 double precision), and never inline: on a turn of its own, alone. Of two due at the same moment,
   * the one asked first runs first. Less than nothing is nothing. Throws `RangeError` for a non-finite `ms` or
   * overflowing deadline, and `ClockClosedError` once closed.
   */
  after(ms: number, run: () => void): () => void
  /**
   * Resolves when `ms` have passed, as `after` runs. Rejects with `RangeError` for a non-finite `ms` or overflowing
   * deadline, with `signal.reason` if `options.signal` aborts, or with `ClockClosedError` if the clock is closed.
   */
  sleep(ms: number, options?: ClockSleepOptions): Promise<void>
}

/** The longest a timer is set for, in milliseconds: a longer wait wakes in hops of at most `MAX_TIMER_MS`. */
export const MAX_TIMER_MS = 0x7fffffff

interface Entry {
  /** Moment on `monotonic()` (active time, excluding suspended spans) when this entry may run. */
  readonly due: number
  /** Tie-breaker among entries due at the same moment: lower was asked first. */
  readonly seq: number
  /** Callback to run when due; cleared on dispatch, cancel, or close so retained cancel handles do not retain it. */
  run: (() => void) | undefined
  /** Slot in the heap of what waits while present. */
  index: number
}

const before = (a: Entry, b: Entry): boolean =>
  // Stryker disable next-line EqualityOperator: every entry has a unique seq, so < and <= are equivalent.
  a.due < b.due || (a.due === b.due && a.seq < b.seq)

const assertFinite = (ms: number): void => {
  if (!Number.isFinite(ms)) throw new RangeError(`A clock expects a finite wait in milliseconds, and was given ${String(ms)}`)
}

const place = (heap: Entry[], index: number, entry: Entry): void => {
  heap[index] = entry
  entry.index = index
}

const siftUp = (heap: Entry[], index: number): void => {
  const entry = heap[index]!
  while (index > 0) {
    const parent = (index - 1) >> 1
    const parentEntry = heap[parent]!
    if (!before(entry, parentEntry)) break
    place(heap, index, parentEntry)
    index = parent
  }
  place(heap, index, entry)
}

const siftDown = (heap: Entry[], index: number): void => {
  const entry = heap[index]!
  const length = heap.length
  const half = length >> 1
  while (index < half) {
    let child = (index << 1) + 1
    let best = heap[child]!
    const right = child + 1
    if (right < length) {
      const rightEntry = heap[right]!
      if (before(rightEntry, best)) {
        child = right
        best = rightEntry
      }
    }
    if (!before(best, entry)) break
    place(heap, index, best)
    index = child
  }
  place(heap, index, entry)
}

const removeAt = (heap: Entry[], index: number): void => {
  // Stryker disable next-line all: GC release.
  heap[index]!.run = undefined
  const last = heap.pop()!
  if (index < heap.length) {
    place(heap, index, last)
    if (index > 0 && before(last, heap[(index - 1) >> 1]!)) siftUp(heap, index)
    else siftDown(heap, index)
  }
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
  /** Exact active monotonic deadline of the earliest waiting entry (only called while a timer is armed). */
  readonly nextDue: () => number
  /** Active monotonic time accumulated up to the most recent resume. */
  readonly activeBase: () => number
  /** Raw `from.monotonic()` reading at the most recent resume. */
  readonly resumeAnchor: () => number
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
  /** Frozen consumer `Clock` exposing only `now`, `monotonic`, `after`, and `sleep`. */
  readonly clock: Clock
  /** How many entries currently wait to run. */
  readonly waiting: () => number
  /**
   * Suspends counting: nothing runs, no timer stays armed, and what passes until `resume` is not counted against what
   * waits. For whoever receives OS power events (`powerMonitor` `suspend` / `resume`) where `monotonic` ticks through sleep.
   */
  readonly suspend: () => void
  /** Resumes counting from here; time spent suspended is excluded from what waits and from `monotonic()`. */
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

    /** Indexed min-heap of what waits: earliest due first, then lowest `seq`. */
    const heap: Entry[] = []
    let nextSeq = 0
    /** The one armed timer, tagged by identity so a stale wakeup cannot disarm a newer one. */
    let armed: { readonly token: object; readonly cancel: () => void } | undefined
    /** Whether a turn has already been asked for to run what is due. */
    let turning = false
    /** Whether a due callback is running now: delays re-arming until `finally` so edits inside it arm once. */
    let running = false
    /** Reading of `monotonic` when counting suspended, while suspended. */
    let suspended: number | undefined
    // Two anchors instead of one `suspendedTotal` offset: `raw - offset` can round below the prior reading after a large suspend.
    let activeBase = 0
    let resumeAnchor = 0
    let closed = false
    /** Latest finite reading of `wall` that `now` has said, if any has been seen yet. */
    let said: number | undefined
    /** Pending sleeps rejected with `ClockClosedError` if the clock closes first. */
    const sleepers = new Set<() => void>()
    /** Count of due entries actually dispatched to user callbacks. */
    let dispatched = 0

    const push = (due: number, run: () => void): Entry => {
      const entry: Entry = { due, seq: nextSeq++, run, index: heap.length }
      heap.push(entry)
      siftUp(heap, entry.index)
      return entry
    }

    const disarm = (): void => {
      if (!armed) return
      const { cancel } = armed
      armed = undefined
      cancel()
    }

    const monotonic: Clock['monotonic'] = () => activeBase + ((suspended ?? from.monotonic()) - resumeAnchor)

    const finishSuspend = (since: number, at: number): void => {
      activeBase += since - resumeAnchor
      resumeAnchor = at
      suspended = undefined
    }

    /** Sees to what is due first: asks for a turn if it is due now, or arms one hop if it is not. */
    const arm = (): void => {
      if (running || closed || turning || suspended !== undefined) return
      disarm()
      const first = heap[0]
      if (!first) return
      const left = first.due - monotonic()
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
      const first = heap[0]
      if (!first || first.due > monotonic()) { arm(); return }
      const run = first.run!
      removeAt(heap, 0)
      dispatched++
      // Whatever it throws is handed on, and what still waits is seen to either way.
      running = true
      try { run() } finally { running = false; arm() }
    }

    const now: Clock['now'] = () => {
      const wall = from.wall()
      if (Number.isFinite(wall)) said = said === undefined ? wall : Math.max(said, wall)
      if (said === undefined) throw new RangeError(`A clock expects a finite wall time, and was given ${String(wall)}`)
      return said
    }

    const after: Clock['after'] = (ms, run) => {
      assertFinite(ms)
      if (closed) throw new ClockClosedError()
      const due = monotonic() + Math.max(0, ms)
      if (!Number.isFinite(due)) {
        throw new RangeError(`A clock wait of ${String(ms)} ms overflows the monotonic deadline`)
      }
      const wasHead = heap[0]
      const entry = push(due, run)
      if (heap[0] !== wasHead) arm()
      return () => {
        if (heap[entry.index] !== entry) return
        const wasHead = entry.index === 0
        removeAt(heap, entry.index)
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
        if (signal?.aborted) { reject(signal.reason); return }
        resolve()
      })
      sleepers.add(onClose)
      signal?.addEventListener('abort', onAbort)
    })

    const close = (): void => {
      if (suspended !== undefined) finishSuspend(suspended, from.monotonic())
      closed = true
      disarm()
      // Stryker disable next-line all: GC release.
      for (const entry of heap) entry.run = undefined
      heap.length = 0
      ownedTurns?.close()
      for (const onClose of [...sleepers]) onClose()
    }

    this.clock = Object.freeze({ now, monotonic, after, sleep })
    this.waiting = () => heap.length
    this.suspend = () => {
      if (closed || suspended !== undefined) return
      suspended = from.monotonic()
      disarm()
    }
    this.resume = () => {
      if (suspended === undefined) return
      finishSuspend(suspended, from.monotonic())
      arm()
    }
    this.close = close
    clockInternals.set(this, {
      nextDue: () => heap[0]!.due,
      activeBase: () => activeBase,
      resumeAnchor: () => resumeAnchor,
      dispatched: () => dispatched,
    })
  }
}
