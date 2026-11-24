import { LONGEST, type Sources } from '../../src/index.ts'

/** Thrown when either a `Sources` implementation or a clock breaks one of the four source contracts. */
export class SourceContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceContractError'
  }
}

/**
 * Assume–guarantee monitor around a `Sources` object.
 *
 * Assumes of the handed-in sources:
 * - `monotonic()` returns a finite number that never decreases.
 * - `timer(ms, run)` returns a cancel function and never invokes `run` synchronously inline.
 * - `turn(run)` never invokes `run` synchronously inline.
 * - `wall()` may jump, regress, or be non-finite (no monotonicity assumed).
 *
 * Guarantees of the clock calling into sources:
 * - `timer(ms, run)` is called only with finite `ms` in `(0, LONGEST]`.
 * - At most one uncancelled, unfired underlying timer is active at any time.
 */
export function checkedSources(sources: Sources): Sources {
  let lastMonotonic = Number.NEGATIVE_INFINITY
  let activeTimers = 0

  return {
    monotonic: () => {
      const value = sources.monotonic()
      if (!Number.isFinite(value)) {
        throw new SourceContractError(`monotonic() must return a finite number, got ${String(value)}`)
      }
      if (value < lastMonotonic) {
        throw new SourceContractError(`monotonic() went backward from ${lastMonotonic} to ${value}`)
      }
      lastMonotonic = value
      return value
    },
    wall: () => sources.wall(),
    timer: (ms, run) => {
      if (!Number.isFinite(ms) || ms <= 0 || ms > LONGEST) {
        throw new SourceContractError(`timer(ms, run) requires finite ms in (0, ${LONGEST}], got ${String(ms)}`)
      }
      if (activeTimers !== 0) {
        throw new SourceContractError(`timer(ms, run) was armed while ${activeTimers} timer(s) were already active`)
      }
      let live = true
      let inline = true
      activeTimers++
      const cancel = sources.timer(ms, () => {
        if (inline) {
          throw new SourceContractError('timer(ms, run) invoked its callback synchronously inline')
        }
        if (live) {
          live = false
          activeTimers--
        }
        run()
      })
      inline = false
      if (typeof cancel !== 'function') {
        throw new SourceContractError(`timer(ms, run) must return a cancel function, got ${typeof cancel}`)
      }
      return () => {
        if (live) {
          live = false
          activeTimers--
        }
        cancel()
      }
    },
    turn: (run) => {
      let inline = true
      sources.turn(() => {
        if (inline) {
          throw new SourceContractError('turn(run) invoked its callback synchronously inline')
        }
        run()
      })
      inline = false
    },
  }
}
