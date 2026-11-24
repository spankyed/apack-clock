import { describe, expect, it } from 'vitest'
import { clock, LONGEST, type Sources } from '../src/index.ts'
import { checkedSources, SourceContractError } from './support/checked-sources.ts'

const validSources = (): Sources => ({
  monotonic: () => 10,
  wall: () => 1_000,
  timer: () => () => {},
  turn: () => {},
})

describe('source contracts (assume–guarantee monitor)', () => {
  it('fails loudly when monotonic() returns a non-finite value or goes backward', () => {
    let reading = 10
    const checked = checkedSources({ ...validSources(), monotonic: () => reading })
    expect(checked.monotonic()).toBe(10)
    reading = 12
    expect(checked.monotonic()).toBe(12)
    reading = 11
    expect(() => checked.monotonic()).toThrow(SourceContractError)
    reading = Number.NaN
    expect(() => checked.monotonic()).toThrow(SourceContractError)
    reading = Number.POSITIVE_INFINITY
    expect(() => checked.monotonic()).toThrow(SourceContractError)
  })

  it('fails loudly when timer() invokes its callback inline or does not return a cancel function', () => {
    const inlineTimer = checkedSources({
      ...validSources(),
      timer: (_ms, run) => { run(); return () => {} },
    })
    expect(() => inlineTimer.timer(10, () => {})).toThrow(SourceContractError)

    const badCancel = checkedSources({
      ...validSources(),
      timer: () => undefined as unknown as () => void,
    })
    expect(() => badCancel.timer(10, () => {})).toThrow(SourceContractError)
  })

  it('fails loudly when turn() invokes its callback inline', () => {
    const inlineTurn = checkedSources({
      ...validSources(),
      turn: (run) => { run() },
    })
    expect(() => inlineTurn.turn(() => {})).toThrow(SourceContractError)
  })

  it('fails loudly when a caller asks timer() for an invalid delay or arms two timers at once', () => {
    const checked = checkedSources(validSources())
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, LONGEST + 1]) {
      expect(() => checked.timer(bad, () => {})).toThrow(SourceContractError)
    }
    const cancel = checked.timer(10, () => {})
    expect(() => checked.timer(20, () => {})).toThrow(SourceContractError)
    cancel()
    // After cancelling the active timer, arming a new one is allowed again.
    const cancel2 = checked.timer(20, () => {})
    cancel2()
  })

  it('holds on the real runtime sources under normal operation', async () => {
    const real = checkedSources({
      monotonic: () => performance.now(),
      wall: () => Date.now(),
      timer: (ms, run) => { const id = setTimeout(run, ms); return () => { clearTimeout(id) } },
      turn: (run) => { setTimeout(run, 0) },
    })
    const time = clock(real)
    try {
      const ran: string[] = []
      time.after(0, () => { ran.push('zero') })
      time.after(10, () => { ran.push('ten') })
      await time.sleep(30)
      expect(ran).toEqual(['zero', 'ten'])
    } finally {
      time.close()
    }
  })
})
