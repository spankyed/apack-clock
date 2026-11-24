// A clock a program is handed in place of `setTimeout` and `Date.now()`: something to run after this long, and the
// time it is. One indexed min-heap of what waits, in the order it is due, and at most one underlying timer for the
// first of it.
//
// How long is counted on a clock that only goes forward (`monotonic`), so setting the time of day moves nothing that
// waits. The time it is comes from the time of day (`wall`), and is never earlier than it was last said to be.
//
// What it reads and what wakes it are handed in (`Sources`). A program hands in nothing and gets the real ones; a
// spec hands in its own and chooses when each thing happens.

/** What a clock reads and is woken by. Each is the real one unless given. */
export interface Sources {
  /** Milliseconds on a clock that only goes forward, from any start: `performance.now()`. */
  monotonic(): number
  /** The time of day, in milliseconds since 1970: `Date.now()`. It may go back, and a clock does not follow it there. */
  wall(): number
  /**
   * Calls `run` once, about `ms` from now, unless what it returns is called first: `setTimeout`. It may be late by
   * any amount, or a little early. `ms` is never more than `LONGEST`.
   */
  timer(ms: number, run: () => void): () => void
  /** Calls `run` on a later turn of the event loop, soon, in the order asked. */
  turn(run: () => void): void
}

export interface Clock extends Disposable {
  /**
   * The time it is, in milliseconds since 1970, and never earlier than this clock last said: where the time of day
   * is set back, it says what it said before until the time of day has passed that.
   */
  now(): number
  /**
   * Runs `run` once, when `ms` have passed on the clock that only goes forward, unless what it returns is called
   * first. Never before then, and never as it is called: on a turn of its own, alone. Of two due at the same
   * moment, the one set first runs first. Less than nothing is nothing. Throws a `RangeError` for what is not a
   * finite length of time.
   */
  after(ms: number, run: () => void): () => void
  /** Resolves when `ms` have passed, as `after` runs. */
  sleep(ms: number): Promise<void>
  /** How many things are currently waiting to run. */
  pending(): number
  /**
   * Stops counting: nothing runs, and what passes until `resume` is not counted against anything that waits. For
   * whoever is told the machine is about to sleep, where the clock that only goes forward goes on through it.
   */
  pause(): void
  /** Counts again from here. */
  resume(): void
  /** Calls off everything waiting, clears the underlying timer, and runs nothing after. */
  close(): void
}

/** The longest a timer is set for, in milliseconds: one set for longer runs at once. What waits longer is woken for in hops. */
export const LONGEST = 0x7fffffff

interface Entry {
  due: number
  readonly seq: number
  readonly run: () => void
  /** Current slot in the binary min-heap, or -1 once popped, called off, or closed. */
  index: number
}

const before = (a: Entry, b: Entry): boolean =>
  // Stryker disable next-line EqualityOperator: every entry has a unique seq, so < and <= are equivalent.
  a.due < b.due || (a.due === b.due && a.seq < b.seq)

/** A later turn of the event loop, where there is `setImmediate` and where there is not. */
const makeTurns = (): { readonly turn: Sources['turn']; close(): void } => {
  if (typeof setImmediate === 'function') {
    return { turn: (run) => { setImmediate(run) }, close: () => {} }
  }
  const asked: Array<() => void> = []
  let channel: InstanceType<typeof MessageChannel> | undefined
  return {
    turn: (run) => {
      if (!channel) {
        channel = new MessageChannel()
        // Node's types leave a port's `onmessage` out, and it is what a window and Node both have.
        const port1 = channel.port1 as unknown as { onmessage: () => void; unref?: () => void }
        port1.onmessage = () => { asked.shift()!() }
        // Stryker disable next-line OptionalChaining: unref exists in Node and not in a browser window.
        port1.unref?.()
      }
      asked.push(run)
      channel.port2.postMessage(0)
    },
    close: () => {
      if (!channel) return
      channel.port1.close()
      channel.port2.close()
      channel = undefined
      asked.length = 0
    },
  }
}

/** Makes a clock: on the real time and timers, or on what it is given in place of each. */
export function clock(given: Partial<Sources> = {}): Clock {
  const ownedTurns = given.turn ? undefined : makeTurns()
  const from: Sources = {
    monotonic: given.monotonic ?? (() => performance.now()),
    wall: given.wall ?? (() => Date.now()),
    timer: given.timer ?? ((ms, run) => { const timer = setTimeout(run, ms); return () => { clearTimeout(timer) } }),
    turn: given.turn ?? ownedTurns!.turn,
  }

  /** Indexed binary min-heap of what waits, earliest due first and FIFO for equal due times. */
  const heap: Entry[] = []
  let nextSeq = 0
  /** Currently armed underlying timer, tagged by identity so a stale wakeup cannot clobber a newer one. */
  let armed: { readonly token: object; readonly cancel: () => void } | undefined
  /** Whether a turn has been asked for, to run what is due. */
  let turning = false
  /** Whether a callback is currently running: defers re-arming until `finally` to avoid mid-callback churn. */
  let running = false
  /** When counting stopped, while it is stopped. */
  let paused: number | undefined
  let closed = false
  let said = Number.NEGATIVE_INFINITY

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

  /** Sees to the first of what waits: a turn for it if it is due, and the timer if it is not. */
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

  /** Runs the first of what waits if it is due, and only it: each thing run has a turn to itself. */
  const next = (): void => {
    if (closed || paused !== undefined) return
    const first = heap[0]
    if (!first || first.due > from.monotonic()) { arm(); return }
    removeAt(0)
    // What it throws is its own, and whoever called this is handed it: what waits is seen to either way.
    running = true
    try { first.run() } finally { running = false; arm() }
  }

  const after: Clock['after'] = (ms, run) => {
    if (!Number.isFinite(ms)) throw new RangeError(`A clock is asked for a finite length of time, and was given ${String(ms)}`)
    if (closed) return () => {}
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

  const close = (): void => {
    closed = true
    paused = undefined
    disarm()
    for (const entry of heap) entry.index = -1
    heap.length = 0
    ownedTurns?.close()
  }

  return {
    now: () => {
      const wall = from.wall()
      if (!Number.isNaN(wall)) said = Math.max(said, wall)
      return said
    },
    after,
    sleep: (ms) => new Promise((resolve) => { after(ms, resolve) }),
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
      arm()
    },
    close,
    [Symbol.dispose]: close,
  }
}
