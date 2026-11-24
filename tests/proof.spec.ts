// Bounded exhaustive state-space exploration directly over the real `ClockController` implementation.
//
// Unlike the seeded property suite (`model.spec.ts`), which samples long random trajectories, this BFS explores
// EVERY reachable interleaving of scheduling, cancellation, suspend/resume, early/on-time/late timer wakeups, stale
// cancelled wakeups, turns, close, multi-hop delays, and re-entrant callbacks up to a finite bound.
//
// At every reachable state it verifies:
//   - Safety: never early, never twice, never called off, never while suspended or closed, FIFO on ties, <= 1 timer,
//     exact waiting(), and ClockClosedError on after() after close.
//   - Liveness: every reachable non-closed state drains to quiescence in finite steps with every waiting callback
//     executed in exact (due, seq) order.
import { describe, expect, it } from 'vitest'
import { ClockController, ClockClosedError, MAX_TIMER_MS } from '../src/index.ts'
import { world } from './support/world.ts'

type Action =
  | { readonly kind: 'ask'; readonly ms: number; readonly effect?: 'none' | 'ask0' | 'cancelNext' | 'suspend' | 'close' | 'throw' }
  | { readonly kind: 'cancel'; readonly slot: number }
  | { readonly kind: 'suspend' }
  | { readonly kind: 'resume'; readonly span: number }
  | { readonly kind: 'wake'; readonly late: number }
  | { readonly kind: 'stale' }
  | { readonly kind: 'turn' }
  | { readonly kind: 'close' }

interface Thing {
  readonly id: number
  readonly effect: NonNullable<Extract<Action, { kind: 'ask' }>['effect']>
  due: number
  state: 'waits' | 'ran' | 'off'
  off: () => void
}

interface ReplayState {
  readonly key: string
  readonly closed: boolean
  readonly suspended: boolean
  readonly asked: number
  readonly waitingSlots: readonly number[]
  readonly hasTimer: boolean
  readonly hasTurn: boolean
  readonly hasStale: boolean
}

const replay = (actions: readonly Action[]): ReplayState => {
  const at = world()
  const controller = new ClockController(at.sources)
  const { clock } = controller
  const things: Thing[] = []
  let stopped: number | undefined
  let closed = false
  let inTurn = 0

  const holds = (cond: boolean, message: string): void => {
    if (!cond) throw new Error(`${message}\ntrace: ${JSON.stringify(actions)}`)
  }
  const waits = (): Thing[] => things.filter((thing) => thing.state === 'waits')
  const first = (): Thing | undefined => waits().reduce<Thing | undefined>((best, thing) => (!best || thing.due < best.due ? thing : best), undefined)

  const ask = (ms: number, effect: NonNullable<Extract<Action, { kind: 'ask' }>['effect']> = 'none'): void => {
    const thing: Thing = {
      id: things.length,
      effect,
      due: (stopped ?? at.mono) + Math.max(0, ms),
      state: 'waits',
      off: () => {},
    }
    things.push(thing)
    thing.off = clock.after(ms, () => {
      holds(!closed, `${thing.id} ran after close`)
      holds(stopped === undefined, `${thing.id} ran while suspended`)
      holds(thing.state === 'waits', `${thing.id} ran when ${thing.state}`)
      holds(at.mono >= thing.due, `${thing.id} ran early at ${at.mono} < ${thing.due}`)
      holds(first() === thing, `${thing.id} ran ahead of ${first()?.id}`)
      holds(++inTurn === 1, `${thing.id} shared a turn`)
      thing.state = 'ran'
      if (effect === 'ask0') {
        ask(0, 'none')
      } else if (effect === 'cancelNext') {
        const next = first()
        if (next) { next.off(); next.state = 'off' }
      } else if (effect === 'suspend') {
        controller.suspend()
        stopped = at.mono
      } else if (effect === 'close') {
        controller.close()
        closed = true
        stopped = undefined
        for (const w of waits()) w.state = 'off'
      } else if (effect === 'throw') {
        throw new Error('reentrant-boom')
      }
    })
  }

  const checkInvariants = (): void => {
    const live = waits()
    holds(controller.waiting() === live.length, `waiting() ${controller.waiting()} !== ${live.length}`)
    holds(at.timers.length <= 1, `timers.length = ${at.timers.length}`)
    const next = first()
    if (closed) {
      holds(live.length === 0, 'closed clock has live items')
      holds(at.timers.length === 0, 'closed clock has an active timer')
    } else if (stopped !== undefined) {
      holds(at.timers.length === 0, 'suspended clock has an active timer')
    } else if (at.turns === 0) {
      holds(!next || next.due > at.mono, `due item ${next?.id} left waiting with no turn`)
      holds(at.timers.length === (next ? 1 : 0), `timer count ${at.timers.length} disagrees with waits ${live.length}`)
    } else {
      holds(at.timers.length === 0, 'timer armed while turn is pending')
    }
  }

  const step = (go: () => void): void => {
    inTurn = 0
    try {
      go()
    } catch (error) {
      if (!(error instanceof Error && error.message === 'reentrant-boom')) throw error
    }
    checkInvariants()
  }

  for (const action of actions) {
    if (action.kind === 'ask') {
      step(() => { ask(action.ms, action.effect) })
    } else if (action.kind === 'cancel') {
      const target = things[action.slot]!
      step(() => { target.off(); if (target.state === 'waits') target.state = 'off' })
    } else if (action.kind === 'suspend') {
      step(() => { controller.suspend(); stopped = at.mono })
    } else if (action.kind === 'resume') {
      step(() => {
        at.mono += action.span
        const span = at.mono - stopped!
        for (const w of waits()) w.due += span
        stopped = undefined
        controller.resume()
      })
    } else if (action.kind === 'wake') {
      step(() => { at.wake(action.late) })
    } else if (action.kind === 'stale') {
      step(() => { at.cancelled[at.cancelled.length - 1]!() })
    } else if (action.kind === 'turn') {
      step(() => { at.turn() })
    } else {
      step(() => {
        controller.close()
        closed = true
        stopped = undefined
        for (const w of waits()) w.state = 'off'
      })
      let threwClosed = false
      try { clock.after(0, () => {}) } catch (error) { threwClosed = error instanceof ClockClosedError }
      holds(threwClosed, 'after() on closed clock must throw ClockClosedError')
      step(() => { at.settle() })
    }
  }

  // Build canonical relative-time abstract state snapshot BEFORE running the liveness drain.
  const waiting = waits()
  const base = stopped ?? at.mono
  const rel = waiting.map((thing) => `${Math.round((thing.due - base) * 100) / 100}:${thing.effect}`).join(',')
  const snapshot: ReplayState = {
    key: [
      closed ? 'C' : stopped !== undefined ? 'S' : 'R',
      `n=${things.length}`,
      `w=[${rel}]`,
      `t=${at.timers[0]?.ms ?? -1}`,
      `u=${at.turns}`,
      `s=${at.cancelled.length > 0 ? 1 : 0}`,
    ].join('|'),
    closed,
    suspended: stopped !== undefined,
    asked: things.length,
    waitingSlots: waiting.map((thing) => thing.id),
    hasTimer: at.timers.length === 1,
    hasTurn: at.turns > 0,
    hasStale: at.cancelled.length > 0,
  }

  // Liveness proof from this reachable state: draining must execute every waiting item in finite steps.
  if (!closed) {
    let hops = 0
    for (;;) {
      if (stopped !== undefined) {
        step(() => {
          const span = at.mono - stopped!
          for (const w of waits()) w.due += span
          stopped = undefined
          controller.resume()
        })
      }
      while (at.turns > 0 && !closed && stopped === undefined) {
        hops++
        holds(hops < 200, 'liveness failed: non-terminating turn loop')
        step(() => { at.turn() })
      }
      if (closed) break
      if (stopped !== undefined) continue
      if (at.timers.length === 0) break
      hops++
      holds(hops < 200, 'liveness failed: non-terminating timer loop')
      step(() => { at.wake(0) })
    }
    holds(waits().length === 0, `liveness failed: ${waits().length} waiting items never ran`)
    holds(controller.waiting() === 0, `liveness failed: waiting()=${controller.waiting()} after drain`)
  }

  return snapshot
}

const explore = (
  nextActions: (state: ReplayState) => Action[],
): { readonly states: number; readonly transitions: number } => {
  const start = replay([])
  const seen = new Set<string>([start.key])
  const queue: Array<{ readonly actions: readonly Action[]; readonly state: ReplayState }> = [{ actions: [], state: start }]
  let transitions = 0

  while (queue.length > 0) {
    const current = queue.shift()!
    for (const action of nextActions(current.state)) {
      transitions++
      const nextTrace = [...current.actions, action]
      const nextState = replay(nextTrace)
      if (!seen.has(nextState.key)) {
        seen.add(nextState.key)
        queue.push({ actions: nextTrace, state: nextState })
      }
    }
  }
  return { states: seen.size, transitions }
}

describe('exhaustive bounded state-space proof', () => {
  it('reaches fixpoint verifying safety and liveness across every reachable state (up to 3 items, suspend/resume, early/late/stale wakeups, cancel, close)', () => {
    const result = explore((state) => {
      if (state.closed) return []
      const actions: Action[] = []
      if (state.asked < 3) {
        actions.push({ kind: 'ask', ms: 0 }, { kind: 'ask', ms: 1 }, { kind: 'ask', ms: 2 })
      }
      for (const slot of state.waitingSlots) actions.push({ kind: 'cancel', slot })
      if (!state.suspended) {
        actions.push({ kind: 'suspend' })
      } else {
        actions.push({ kind: 'resume', span: 0 }, { kind: 'resume', span: 1 })
      }
      if (state.hasTimer) {
        actions.push({ kind: 'wake', late: -0.5 }, { kind: 'wake', late: 0 }, { kind: 'wake', late: 1 })
      }
      if (state.hasStale) actions.push({ kind: 'stale' })
      if (state.hasTurn) actions.push({ kind: 'turn' })
      actions.push({ kind: 'close' })
      return actions
    })
    expect(result.states).toBeGreaterThan(500)
    expect(result.transitions).toBeGreaterThan(4_000)
  })

  it('reaches fixpoint verifying safety and liveness across every reachable multi-hop and re-entrant callback interleaving', () => {
    const result = explore((state) => {
      if (state.closed) return []
      const actions: Action[] = []
      if (state.asked < 2) {
        actions.push(
          { kind: 'ask', ms: MAX_TIMER_MS + 1, effect: 'none' },
          { kind: 'ask', ms: 0, effect: 'ask0' },
          { kind: 'ask', ms: 1, effect: 'cancelNext' },
          { kind: 'ask', ms: 1, effect: 'suspend' },
          { kind: 'ask', ms: 1, effect: 'close' },
          { kind: 'ask', ms: 1, effect: 'throw' },
        )
      }
      for (const slot of state.waitingSlots) actions.push({ kind: 'cancel', slot })
      if (!state.suspended) actions.push({ kind: 'suspend' })
      else actions.push({ kind: 'resume', span: 1 })
      if (state.hasTimer) actions.push({ kind: 'wake', late: -0.5 }, { kind: 'wake', late: 0 })
      if (state.hasTurn) actions.push({ kind: 'turn' })
      return actions
    })
    expect(result.states).toBeGreaterThan(200)
    expect(result.transitions).toBeGreaterThan(1_000)
  })
})
