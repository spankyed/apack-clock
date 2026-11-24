// A clock held to what a clock is with nothing about how: a list of things, each with the moment it is due. Runs
// drawn from a seed ask for things, call them off (including re-entrantly), stop and start the count, throw from
// callbacks, set the time of day, wake the clock on time, late, very late and early (including sub-ms jitter),
// fire stale cancelled timers, and close the clock — checking every invariant after every step.
import { describe, expect, it } from 'vitest'
import { clock, ClockClosedError, LONGEST } from '../src/index.ts'
import { world } from './support/world.ts'

/** Numbers drawn from a seed: the same seed, the same draws. */
const seeded = (seed: number) => {
  let state = seed >>> 0
  const next = (): number => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  return { int: (below: number): number => Math.floor(next() * below), pick: <T>(from: readonly T[]): T => from[Math.floor(next() * from.length)]! }
}

type Thing = { readonly id: number; due: number; state: 'waits' | 'ran' | 'off'; off(): void }

/** One run: `steps` things done, drawn from `seed`, and then everything left let run. Throws for the first thing that does not hold. */
const run = (seed: number, steps: number): { ran: number; hops: number } => {
  const random = seeded(seed)
  const at = world()
  const time = clock(at.sources)
  const things: Thing[] = []
  const did: string[] = []
  let stopped: number | undefined
  /** What ran in the turn under way. */
  let inTurn = 0
  let lastSaid = Number.NEGATIVE_INFINITY
  let highest = Number.NEGATIVE_INFINITY
  const holds = (held: boolean, what: string): void => { if (!held) throw new Error(`${what}\nseed ${seed}, after:\n  ${did.slice(-12).join('\n  ')}`) }
  const waits = (): Thing[] => things.filter((thing) => thing.state === 'waits')
  /** The one that is to run next: the earliest due, and of those the one asked for first. */
  const first = (): Thing | undefined => waits().reduce<Thing | undefined>((best, thing) => (!best || thing.due < best.due ? thing : best), undefined)

  const ask = (ms: number): void => {
    const thing: Thing = {
      id: things.length,
      due: (stopped ?? at.mono) + Math.max(0, ms),
      state: 'waits',
      off: time.after(ms, () => {
        holds(thing.state === 'waits', `${thing.id} ran, and it had ${thing.state === 'ran' ? 'run already' : 'been called off'}`)
        holds(stopped === undefined, `${thing.id} ran while the count was stopped`)
        holds(at.mono >= thing.due, `${thing.id} ran at ${at.mono}, before it was due at ${thing.due}`)
        holds(first() === thing, `${thing.id} ran ahead of ${first()?.id}, which was due first`)
        holds(++inTurn === 1, `${thing.id} ran in a turn something else had run in`)
        thing.state = 'ran'
        // Re-entrant asks, cancels, pauses, and throws from inside a callback.
        const action = random.int(10)
        if (action < 2) {
          ask(random.pick([0, 0, 3, 40]))
        } else if (action === 2) {
          const other = random.pick(waits().length ? waits() : [undefined])
          if (other) { other.off(); other.state = 'off' }
        } else if (action === 3) {
          time.pause()
          stopped = at.mono
        } else if (action === 4) {
          throw new Error(`boom-${thing.id}`)
        }
      }),
    }
    things.push(thing)
  }
  /** A turn of the spec's own: what it does is not what a clock ran. */
  const turn = (what: string, go: () => void): void => {
    did.push(`${what} (at ${at.mono}${stopped === undefined ? '' : ', stopped'})`)
    inTurn = 0
    try { go() } catch (error) {
      if (!(error instanceof Error && error.message.startsWith('boom-'))) throw error
    }
  }
  const check = (): void => {
    const live = waits()
    holds(time.pending() === live.length, `pending() is ${time.pending()}, expected ${live.length}`)
    holds(at.timers.length <= 1, `${at.timers.length} timers are set`)
    for (const ms of at.set) holds(ms > 0 && ms <= LONGEST, `a timer was set for ${ms}`)
    const next = first()
    if (stopped !== undefined) {
      holds(at.timers.length === 0, 'a timer is set while the count is stopped')
    } else if (at.turns === 0) {
      // At rest: nothing due is left waiting, and the timer is for the first of what is not, or as far as one goes.
      holds(!next || next.due > at.mono, `${next?.id} was due at ${next?.due} and is left waiting at ${at.mono}`)
      holds(at.timers.length === (next ? 1 : 0), `${at.timers.length} timers are set with ${live.length} things waiting`)
      const timer = at.timers[0]
      if (timer && next) {
        const expectedDelay = Math.min(Math.ceil(next.due - at.mono), LONGEST)
        holds(timer.at >= next.due || (timer.ms === LONGEST && timer.at < next.due), `the timer is for ${timer.at}, and ${next.id} is due at ${next.due}`)
        holds(timer.at <= Math.max(next.due, at.mono + expectedDelay) + 1, `the timer overshot ${next.due} at ${timer.at}`)
      }
    } else {
      holds(at.timers.length === 0, 'a timer is set while something due waits for its turn')
    }
    const said = time.now()
    highest = Math.max(highest, at.wall)
    holds(said >= lastSaid, `the time went back from ${lastSaid} to ${said}`)
    holds(said === highest, `the time is said to be ${said}, and the latest the time of day has been is ${highest}`)
    lastSaid = said
  }

  for (let step = 0; step < steps; step++) {
    const what = random.int(13)
    if (what < 4) {
      const ms = random.pick([0, 0, 0.4, 1, 5, 5, 20, 100, 1_000, -3, LONGEST + 7, LONGEST * 3])
      turn(`asked for ${ms}`, () => { ask(ms) })
    } else if (what < 6) {
      const thing = random.pick(things.length ? things : [undefined])
      if (thing) turn(`called off ${thing.id}`, () => { thing.off(); if (thing.state === 'waits') thing.state = 'off' })
    } else if (what < 9) {
      if (at.timers.length === 1) {
        const late = random.pick([0, 0, 0, 0.3, 1, 7, 60_000, LONGEST, -0.4, -1, -4])
        turn(`woke ${late} late`, () => { at.wake(late) })
      }
    } else if (what < 10) {
      turn('a turn', () => { at.turn() })
    } else if (what < 11) {
      turn('the time of day was set', () => { at.wall += random.pick([1, 500, -500, -86_400_000, 3_600_000]) })
    } else if (what < 12) {
      if (at.cancelled.length > 0) {
        const stale = random.pick(at.cancelled)
        turn('spurious stale wakeup', () => { stale() })
      }
    } else if (stopped === undefined) {
      turn('stopped', () => { time.pause(); stopped = at.mono })
    } else {
      turn('went on', () => {
        at.mono += random.pick([0, 1, 30_000, 3_600_000])
        const span = at.mono - stopped!
        for (const thing of waits()) thing.due += span
        stopped = undefined
        time.resume()
      })
    }
    check()
    // Mostly, everything due is let run before the next thing is done; sometimes it is left waiting for its turn.
    if (random.int(3)) while (at.turns) { turn('a turn', () => { at.turn() }); check() }
  }

  // Every 10th run closes mid-flight and verifies nothing fires and after() throws ClockClosedError; the rest drain to completion.
  if (seed % 10 === 0) {
    turn('closed', () => { time.close() })
    holds(time.pending() === 0, `pending() after close is ${time.pending()}`)
    holds(at.timers.length === 0, `timers after close: ${at.timers.length}`)
    let threwClosed = false
    try { time.after(1, () => {}) } catch (error) { threwClosed = error instanceof ClockClosedError }
    holds(threwClosed, 'after() on a closed clock did not throw ClockClosedError')
    const ranBefore = things.filter((thing) => thing.state === 'ran').length
    at.settle()
    holds(things.filter((thing) => thing.state === 'ran').length === ranBefore, 'something ran after close')
    return { ran: ranBefore, hops: 0 }
  }

  // Everything left runs, in the end, however far off it is.
  let hops = 0
  for (;;) {
    if (stopped !== undefined) {
      turn('went on', () => { const span = at.mono - stopped!; for (const thing of waits()) thing.due += span; stopped = undefined; time.resume() })
      check()
    }
    while (at.turns) { turn('a turn', () => { at.turn() }); check() }
    if (stopped !== undefined) continue
    if (!at.timers.length) break
    hops++
    holds(hops < 10_000, 'still waking after 10 000 timers')
    turn('woke on time', () => { at.wake() })
    check()
  }
  holds(waits().length === 0, `${waits().map((thing) => thing.id).join(', ')} never ran`)
  holds(time.pending() === 0, `pending() at end is ${time.pending()}`)
  return { ran: things.filter((thing) => thing.state === 'ran').length, hops }
}

describe('a clock, under runs drawn from a seed', () => {
  it('runs nothing early, twice, out of turn, called off, while stopped, or after close, runs everything in the end, and keeps one timer for what is first', () => {
    let ran = 0
    for (let seed = 1; seed <= 400; seed++) ran += run(seed, 80).ran
    // The runs do something: thousands of things ran across them.
    expect(ran).toBeGreaterThan(4_000)
  })
})
