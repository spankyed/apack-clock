import type { ClockSources } from '../../src/index.ts'
import { checkedSources } from './checked-sources.ts'

/** What a clock is given in a spec: time that moves only when told to, and timers and turns that run only when told to. */
export interface World {
  readonly sources: ClockSources
  /** The clock that only goes forward. */
  mono: number
  /** The time of day. */
  wall: number
  /** The timers set and not yet run or called off, with when each is set to run and for how long it was set. */
  readonly timers: ReadonlyArray<{ readonly at: number; readonly ms: number; readonly run: () => void }>
  /** Callbacks of timers that were already cancelled, so specs can simulate a spurious stale wakeup. */
  readonly cancelled: ReadonlyArray<() => void>
  /** How long every timer ever set was set for. */
  readonly set: readonly number[]
  /** How many turns are asked for and not yet run. */
  readonly turns: number
  /** Runs the one timer, `late` after it was set to run (or before, where `late` is less than nothing). */
  wake(late?: number): void
  /** Runs the turn asked for first, as a turn of its own. Returns whether there was one. */
  turn(): boolean
  /** Runs every turn asked for, each as its own, until none is. */
  settle(): void
}

export function world(): World {
  const timers: Array<{ at: number; ms: number; run: () => void }> = []
  const cancelled: Array<() => void> = []
  const turns: Array<() => void> = []
  const set: number[] = []
  const it: World = {
    mono: 0,
    wall: 1_000_000,
    timers,
    cancelled,
    set,
    get turns() { return turns.length },
    sources: checkedSources({
      monotonic: () => it.mono,
      wall: () => it.wall,
      timer: (ms, run) => {
        const timer = { at: it.mono + ms, ms, run }
        timers.push(timer)
        set.push(ms)
        return () => {
          const index = timers.indexOf(timer)
          if (index >= 0) {
            timers.splice(index, 1)
            cancelled.push(run)
          }
        }
      },
      turn: (run) => { turns.push(run) },
    }),
    wake: (late = 0) => {
      if (timers.length !== 1) throw new Error(`There is one timer to run, and ${timers.length} are set`)
      const timer = timers.shift()!
      it.mono = Math.max(it.mono, timer.at + late)
      timer.run()
    },
    turn: () => {
      const run = turns.shift()
      if (!run) return false
      run()
      return true
    },
    settle: () => { while (it.turn()) { /* each a turn of its own */ } },
  }
  return it
}
