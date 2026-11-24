// A clock a program is handed in place of `setTimeout` and `Date.now()`: something to run after this long, and the
// time it is. One heap of what waits, ordered by when each is due, and at most one armed timer for what is due first.
//
// How long is counted on `monotonic`, so setting the time of day moves nothing that waits. The time it is comes from
// `wall`, and is never earlier than what `now` last said.
//
// What it reads and what wakes it are handed in (`Sources`). A program hands in nothing and gets the real ones; a
// spec hands in its own and chooses when each thing happens.

/** What a clock reads and is woken by. Each is the real one unless given. */
export interface Sources {
  /** Milliseconds on a clock that only goes forward, from any start: `performance.now()`. Must stay finite and never decrease. */
  monotonic(): number
  /** The time of day, in milliseconds since 1970: `Date.now()`. May go back or read non-finite; `now` never follows it back. */
  wall(): number
  /**
   * Calls `run` once, about `ms` from now, unless what it returns is called first: `setTimeout`. Must not invoke `run`
   * inline, and must return a cancel function. May wake early, late, or stale. `ms` is always finite in `(0, LONGEST]`.
   */
  timer(ms: number, run: () => void): () => void
  /** Calls `run` on a later turn of the event loop, in the order asked. Must not invoke `run` inline. */
  turn(run: () => void): void
}

export interface SleepOptions {
  /** Aborts the sleep, calling off what waits and rejecting with `signal.reason`. */
  readonly signal?: AbortSignal
}

/** Thrown by `after`, or rejected from `sleep`, once the clock is closed. */
export class ClockClosedError extends Error {
  constructor() {
    super('The clock is closed; nothing new may be asked of it')
    this.name = 'ClockClosedError'
  }
}

/** What a consumer is handed: read what is said and wait, with no authority to pause or close the clock. */
export interface Clock {
  /**
   * The time it is, in milliseconds since 1970, and never earlier than what this clock last said: where the time of
   * day is set back or reads non-finite, it keeps what it last said until `wall` passes that.
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
  sleep(ms: number, options?: SleepOptions): Promise<void>
}

/** What whoever owns the clock holds: a `Clock`, plus `view`, `pending`, `pause`, `resume`, and `close`. */
export interface ManagedClock extends Clock {
  /** Returns a frozen `Clock` exposing only `now`, `after`, and `sleep`. */
  view(): Clock
  /** How many entries currently wait to run. */
  pending(): number
  /**
   * Pauses counting: nothing runs, no timer stays armed, and what passes until `resume` is not counted against what
   * waits. For whoever is told the machine is about to sleep, where `monotonic` goes on through it.
   */
  pause(): void
  /** Resumes counting from here, shifting what waits by the paused span. */
  resume(): void
  /** Closes the clock: calls off everything that waits, disarms any timer, rejects pending sleeps, and refuses later asks. */
  close(): void
}

/** The longest a timer is set for, in milliseconds: a longer wait wakes in hops of at most `LONGEST`. */
export const LONGEST = 0x7fffffff

interface Entry {
  /** Moment on `monotonic` when this entry may run. */
  due: number
  /** Tie-breaker among entries due at the same moment: lower was asked first. */
  readonly seq: number
  readonly run: () => void
  /** Slot in the heap of what waits, or -1 once popped, called off, or closed. */
  index: number
}

const before = (a: Entry, b: Entry): boolean =>
  // Stryker disable next-line EqualityOperator: every entry has a unique seq, so < and <= are equivalent.
  a.due < b.due || (a.due === b.due && a.seq < b.seq)

/** Turns of the event loop, using `setImmediate` where present and a reused `MessageChannel` otherwise. */
const makeTurns = (): { readonly turn: Sources['turn']; close(): void } => {
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

/** Makes a clock on the real sources, or on what is given in place of any of them. */
export function clock(given: Partial<Sources> = {}): ManagedClock {
  const ownedTurns = given.turn ? undefined : makeTurns()
  const from: Sources = {
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
  /** Reading of `monotonic` when counting paused, while paused. */
  let paused: number | undefined
  let closed = false
  /** Latest finite reading of `wall` that `now` has said. */
  let said = Number.NEGATIVE_INFINITY
  /** Pending sleeps rejected with `ClockClosedError` if the clock closes first. */
  const sleepers = new Set<() => void>()

  const place = (index: number, entry: Entry): void => {
    heap[index] = entry
    entry.index = index
  }

  const siftUp = (index: number): void => {
    const entry = heap[index]!
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (!before(entry, heap[parent]!)) break
      place(index, heap[parent]!)
      index = parent
    }
    place(index, entry)
  }

  const siftDown = (index: number): void => {
    const entry = heap[index]!
    const length = heap.length
    while (true) {
      const left = index * 2 + 1
      if (left >= length) break
      const right = left + 1
      const smallest = right < length && before(heap[right]!, heap[left]!) ? right : left
      if (!before(heap[smallest]!, entry)) break
      place(index, heap[smallest]!)
      index = smallest
    }
    place(index, entry)
  }

  const push = (entry: Entry): void => {
    heap.push(entry)
    siftUp(entry.index)
  }

  const removeAt = (index: number): Entry => {
    const removed = heap[index]!
    const last = heap.pop()!
    removed.index = -1
    if (index < heap.length) {
      place(index, last)
      if (index > 0 && before(last, heap[(index - 1) >> 1]!)) siftUp(index)
      else siftDown(index)
    }
    return removed
  }

  const disarm = (): void => {
    if (!armed) return
    const { cancel } = armed
    armed = undefined
    cancel()
  }

  /** Sees to what is due first: asks for a turn if it is due now, or arms one hop if it is not. */
  const arm = (): void => {
    if (running || closed || turning || paused !== undefined) return
    disarm()
    const first = heap[0]
    if (!first) return
    const left = first.due - from.monotonic()
    if (left <= 0) {
      turning = true
      from.turn(() => { turning = false; next() })
      return
    }
    const token = {}
    const cancel = from.timer(Math.min(Math.ceil(left), LONGEST), () => {
      if (armed?.token !== token) return
      armed = undefined
      next()
    })
    armed = { token, cancel }
  }

  /** Runs what is due first if its moment has arrived, and only it: each entry runs on a turn of its own. */
  const next = (): void => {
    if (closed || paused !== undefined) return
    const first = heap[0]
    if (!first || first.due > from.monotonic()) { arm(); return }
    removeAt(0)
    // Whatever it throws is handed on, and what still waits is seen to either way.
    running = true
    try { first.run() } finally { running = false; arm() }
  }

  const assertFinite = (ms: number): void => {
    if (!Number.isFinite(ms)) throw new RangeError(`A clock expects a finite wait in milliseconds, and was given ${String(ms)}`)
  }

  const now: Clock['now'] = () => {
    const wall = from.wall()
    if (Number.isFinite(wall)) said = Math.max(said, wall)
    return said
  }

  const after: Clock['after'] = (ms, run) => {
    assertFinite(ms)
    if (closed) throw new ClockClosedError()
    const entry: Entry = { due: (paused ?? from.monotonic()) + Math.max(0, ms), seq: nextSeq++, run, index: heap.length }
    const wasHead = heap[0]
    push(entry)
    if (heap[0] !== wasHead) arm()
    return () => {
      if (entry.index < 0) return
      const wasHead = entry.index === 0
      removeAt(entry.index)
      if (wasHead) arm()
    }
  }

  const sleep: Clock['sleep'] = (ms, options) => new Promise((resolve, reject) => {
    assertFinite(ms)
    const signal = options?.signal
    if (signal?.aborted) { reject(signal.reason); return }
    const cancel = after(ms, () => {
      cleanup()
      resolve()
    })

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

    sleepers.add(onClose)
    signal?.addEventListener('abort', onAbort)
  })

  const capability: Clock = Object.freeze({ now, after, sleep })

  const close = (): void => {
    closed = true
    paused = undefined
    disarm()
    for (const entry of heap) entry.index = -1
    heap.length = 0
    ownedTurns?.close()
    for (const onClose of [...sleepers]) onClose()
  }

  return {
    now,
    after,
    sleep,
    view: () => capability,
    pending: () => heap.length,
    pause: () => {
      if (closed || paused !== undefined) return
      paused = from.monotonic()
      disarm()
    },
    resume: () => {
      if (paused === undefined) return
      const span = from.monotonic() - paused
      paused = undefined
      for (const entry of heap) entry.due += span
      // Adding `span` can round two distinct `due` times to the same float, reversing their `seq` tie-break order.
      for (let index = (heap.length >> 1) - 1; index >= 0; index--) siftDown(index)
      arm()
    },
    close,
  }
}
