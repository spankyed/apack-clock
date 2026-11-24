// A clock a program is handed in place of `setTimeout` and `Date.now()`: something to run after this long, and the
// time it is. One queue of what waits, in the order it is due, and one timer for the first of it.
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

export interface Clock {
  /**
   * The time it is, in milliseconds since 1970, and never earlier than this clock last said: where the time of day
   * is set back, it says what it said before until the time of day has passed that.
   */
  now(): number
  /**
   * Runs `run` once, when `ms` have passed on the clock that only goes forward, unless what it returns is called
   * first. Never before then, and never as it is called: on a turn of its own, alone. Of two due at the same
   * moment, the one set first runs first. Less than nothing is nothing. Throws a `RangeError` for what is not a
   * length of time.
   */
  after(ms: number, run: () => void): () => void
  /** Resolves when `ms` have passed, as `after` runs. */
  sleep(ms: number): Promise<void>
  /**
   * Stops counting: nothing runs, and what passes until `resume` is not counted against anything that waits. For
   * whoever is told the machine is about to sleep, where the clock that only goes forward goes on through it.
   */
  pause(): void
  /** Counts again from here. */
  resume(): void
}

/** The longest a timer is set for, in milliseconds: one set for longer runs at once. What waits longer is woken for in hops. */
export const LONGEST = 0x7fffffff

type Entry = { due: number; readonly run: () => void }

/** A later turn of the event loop, where there is `setImmediate` and where there is not. */
const turns = (): Sources['turn'] => {
  if (typeof setImmediate === 'function') return (run) => { setImmediate(run) }
  const asked: Array<() => void> = []
  const channel = new MessageChannel()
  // Node's types leave a port's `onmessage` out, and it is what a window and Node both have.
  ;(channel.port1 as unknown as { onmessage: () => void }).onmessage = () => { asked.shift()!() }
  return (run) => { asked.push(run); channel.port2.postMessage(0) }
}

/** Makes a clock: on the real time and timers, or on what it is given in place of each. */
export function clock(given: Partial<Sources> = {}): Clock {
  const from: Sources = {
    monotonic: given.monotonic ?? (() => performance.now()),
    wall: given.wall ?? (() => Date.now()),
    timer: given.timer ?? ((ms, run) => { const timer = setTimeout(run, ms); return () => { clearTimeout(timer) } }),
    turn: given.turn ?? turns(),
  }
  /** What waits, in the order it is due, and of two due together the one set first. */
  const waiting: Entry[] = []
  /** What calls off the one timer, while it is set. */
  let off: (() => void) | undefined
  /** Whether a turn has been asked for, to run what is due. */
  let turning = false
  /** When counting stopped, while it is stopped. */
  let paused: number | undefined
  let said = Number.NEGATIVE_INFINITY

  /** Sees to the first of what waits: a turn for it if it is due, and the timer if it is not. */
  const arm = (): void => {
    off?.()
    off = undefined
    const first = waiting[0]
    if (!first || turning || paused !== undefined) return
    const left = first.due - from.monotonic()
    if (left <= 0) {
      turning = true
      from.turn(() => { turning = false; next() })
      return
    }
    off = from.timer(Math.min(left, LONGEST), () => { off = undefined; next() })
  }
  /** Runs the first of what waits if it is due, and only it: each thing run has a turn to itself. */
  const next = (): void => {
    if (paused !== undefined) return
    const first = waiting[0]
    if (!first || first.due > from.monotonic()) { arm(); return }
    waiting.shift()
    // What it throws is its own, and whoever called this is handed it: what waits is seen to either way.
    try { first.run() } finally { arm() }
  }

  const after: Clock['after'] = (ms, run) => {
    if (typeof ms !== 'number' || Number.isNaN(ms) || ms === Number.POSITIVE_INFINITY) throw new RangeError(`A clock is asked for a length of time, and was given ${String(ms)}`)
    const entry: Entry = { due: (paused ?? from.monotonic()) + Math.max(0, ms), run }
    let at = waiting.length
    while (at > 0 && waiting[at - 1]!.due > entry.due) at--
    waiting.splice(at, 0, entry)
    if (at === 0) arm()
    return () => {
      const index = waiting.indexOf(entry)
      if (index < 0) return
      waiting.splice(index, 1)
      if (index === 0) arm()
    }
  }

  return {
    now: () => (said = Math.max(said, from.wall())),
    after,
    sleep: (ms) => new Promise((resolve) => { after(ms, resolve) }),
    pause: () => {
      if (paused !== undefined) return
      paused = from.monotonic()
      off?.()
      off = undefined
    },
    resume: () => {
      if (paused === undefined) return
      const span = from.monotonic() - paused
      paused = undefined
      for (const entry of waiting) entry.due += span
      arm()
    },
  }
}
