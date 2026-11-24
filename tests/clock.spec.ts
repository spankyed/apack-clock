import { afterEach, describe, expect, it, vi } from 'vitest'
import { clock, LONGEST } from '../src/index.ts'
import { world } from './support/world.ts'

/** A clock in a world, and what ran, in the order it ran. */
const made = () => {
  const at = world()
  const ran: string[] = []
  const time = clock(at.sources)
  return { at, ran, time, note: (what: string) => () => { ran.push(what) } }
}

describe('what runs, and when', () => {
  it('runs what was asked for once that long has passed, and not before', () => {
    const { at, ran, time, note } = made()
    time.after(100, note('a'))
    expect(at.timers).toEqual([{ at: 100, ms: 100, run: expect.any(Function) }])
    at.wake()
    expect(ran).toEqual(['a'])
    expect(at.timers).toEqual([])
  })

  it('runs nothing as it is asked: what is due at once has a later turn', () => {
    const { at, ran, time, note } = made()
    time.after(0, note('a'))
    expect(ran).toEqual([])
    expect(at.timers).toEqual([])
    at.settle()
    expect(ran).toEqual(['a'])
  })

  it('takes less than nothing as nothing', () => {
    const { at, ran, time, note } = made()
    time.after(-50, note('a'))
    time.after(Number.NEGATIVE_INFINITY, note('b'))
    at.settle()
    expect(ran).toEqual(['a', 'b'])
  })

  it('runs in the order things are due, whatever order they were asked in', () => {
    const { at, ran, time, note } = made()
    time.after(30, note('c'))
    time.after(10, note('a'))
    time.after(20, note('b'))
    // One timer, for the first of them.
    expect(at.timers.map((timer) => timer.at)).toEqual([10])
    at.wake()
    expect(ran).toEqual(['a'])
    expect(at.timers.map((timer) => timer.at)).toEqual([20])
    at.wake()
    at.wake()
    expect(ran).toEqual(['a', 'b', 'c'])
  })

  it('runs the one set first, of two due at the same moment', () => {
    const { at, ran, time, note } = made()
    time.after(10, note('first'))
    time.after(10, note('second'))
    at.mono = 4
    time.after(6, note('third'))
    at.wake()
    at.settle()
    expect(ran).toEqual(['first', 'second', 'third'])
  })

  it('gives each thing it runs a turn to itself, however many are due', () => {
    const { at, ran, time, note } = made()
    for (const name of ['a', 'b', 'c']) time.after(10, note(name))
    at.wake(500)
    expect(ran).toEqual(['a'])
    expect(at.timers).toEqual([])
    expect(at.turn()).toBe(true)
    expect(ran).toEqual(['a', 'b'])
    expect(at.turn()).toBe(true)
    expect(ran).toEqual(['a', 'b', 'c'])
    expect(at.turn()).toBe(false)
  })

  it('runs nothing early when its timer runs before it was set to', () => {
    const { at, ran, time, note } = made()
    time.after(100, note('a'))
    at.wake(-1)
    expect(ran).toEqual([])
    // Set again for what is left.
    expect(at.timers.map((timer) => timer.ms)).toEqual([1])
    at.wake()
    expect(ran).toEqual(['a'])
  })

  it('runs what is due however late it is woken, and sets its timer for what is not', () => {
    const { at, ran, time, note } = made()
    time.after(10, note('a'))
    time.after(5_000, note('b'))
    at.wake(60_000)
    at.settle()
    expect(ran).toEqual(['a', 'b'])
    time.after(10, note('c'))
    time.after(900, note('d'))
    at.wake(100)
    at.settle()
    expect(ran).toEqual(['a', 'b', 'c'])
    expect(at.timers.map((timer) => timer.ms)).toEqual([790])
  })

  it('waits longer than a timer can be set for, a hop at a time', () => {
    const { at, ran, time, note } = made()
    const long = LONGEST * 2 + 500
    time.after(long, note('a'))
    at.wake()
    at.wake()
    expect(ran).toEqual([])
    at.wake()
    expect(ran).toEqual(['a'])
    expect(at.set).toEqual([LONGEST, LONGEST, 500])
    expect(at.mono).toBe(long)
  })

  it('throws for what is not a length of time, and sets nothing', () => {
    const { at, time } = made()
    for (const not of [Number.NaN, Number.POSITIVE_INFINITY, '5' as unknown as number, undefined as unknown as number]) {
      expect(() => time.after(not, () => {})).toThrow(RangeError)
    }
    expect(() => time.after(Number.NaN, () => {})).toThrow(/given NaN/)
    expect(at.timers).toEqual([])
    expect(at.turns).toBe(0)
  })

  it('resolves a sleep when that long has passed', async () => {
    const { at, ran, time } = made()
    void time.sleep(50).then(() => { ran.push('woke') })
    await Promise.resolve()
    expect(ran).toEqual([])
    at.wake()
    await Promise.resolve()
    expect(ran).toEqual(['woke'])
  })
})

describe('calling off', () => {
  it('does not run what was called off, and sets its timer for what is then first', () => {
    const { at, ran, time, note } = made()
    const off = time.after(10, note('a'))
    time.after(20, note('b'))
    off()
    expect(at.timers.map((timer) => timer.at)).toEqual([20])
    at.wake()
    expect(ran).toEqual(['b'])
  })

  it('leaves the timer as it is when what is called off was not first', () => {
    const { at, ran, time, note } = made()
    time.after(10, note('a'))
    const off = time.after(20, note('b'))
    off()
    expect(at.set).toEqual([10])
    at.wake()
    expect(ran).toEqual(['a'])
    expect(at.timers).toEqual([])
  })

  it('sets no timer once nothing waits', () => {
    const { at, time, note } = made()
    const off = time.after(10, note('a'))
    off()
    expect(at.timers).toEqual([])
  })

  it('does nothing called twice, or after what it would call off has run', () => {
    const { at, ran, time, note } = made()
    const first = time.after(10, note('a'))
    time.after(20, note('b'))
    at.wake()
    first()
    first()
    expect(at.timers.map((timer) => timer.at)).toEqual([20])
    expect(at.set).toEqual([10, 10])
    at.wake()
    expect(ran).toEqual(['a', 'b'])
  })

  it('does not run what is called off while it waits for its turn', () => {
    const { at, ran, time, note } = made()
    const off = time.after(0, note('a'))
    time.after(0, note('b'))
    off()
    at.settle()
    expect(ran).toEqual(['b'])
  })
})

describe('what is asked for as something runs', () => {
  it('takes what is asked for from inside what it runs, in its place among what waits', () => {
    const { at, ran, time, note } = made()
    time.after(10, () => {
      ran.push('a')
      time.after(0, note('at once'))
      time.after(50, note('later'))
    })
    time.after(30, note('b'))
    at.wake()
    expect(ran).toEqual(['a'])
    at.settle()
    expect(ran).toEqual(['a', 'at once'])
    at.wake()
    at.wake()
    expect(ran).toEqual(['a', 'at once', 'b', 'later'])
    expect(at.timers).toEqual([])
  })

  it('goes on to what waits after something it ran threw, and hands on what was thrown', () => {
    const { at, ran, time, note } = made()
    time.after(10, () => { throw new Error('broke') })
    time.after(10, note('b'))
    time.after(20, note('c'))
    expect(() => { at.wake() }).toThrow('broke')
    at.settle()
    expect(ran).toEqual(['b'])
    at.wake()
    expect(ran).toEqual(['b', 'c'])
  })
})

describe('the time it is', () => {
  it('says the time of day', () => {
    const { at, time } = made()
    expect(time.now()).toBe(1_000_000)
    at.wall += 250
    expect(time.now()).toBe(1_000_250)
  })

  it('never says a time earlier than it said, where the time of day is set back', () => {
    const { at, time } = made()
    at.wall = 5_000
    expect(time.now()).toBe(5_000)
    at.wall = 3_000
    expect(time.now()).toBe(5_000)
    at.wall = 5_001
    expect(time.now()).toBe(5_001)
  })

  it('moves nothing that waits when the time of day is set', () => {
    const { at, ran, time, note } = made()
    time.after(100, note('a'))
    at.wall += 3_600_000
    time.now()
    expect(at.timers.map((timer) => timer.at)).toEqual([100])
    at.wall -= 7_200_000
    at.wake()
    expect(ran).toEqual(['a'])
  })
})

describe('stopping the count', () => {
  it('runs nothing while stopped, and counts nothing that passed until it goes on', () => {
    const { at, ran, time, note } = made()
    time.after(100, note('a'))
    at.mono = 40
    time.pause()
    expect(at.timers).toEqual([])
    at.mono = 3_600_040
    time.resume()
    // Sixty are left of its hundred.
    expect(at.timers.map((timer) => timer.ms)).toEqual([60])
    at.wake()
    expect(ran).toEqual(['a'])
  })

  it('counts what is asked for while stopped from when it goes on', () => {
    const { at, ran, time, note } = made()
    time.pause()
    at.mono = 500
    time.after(100, note('a'))
    expect(at.timers).toEqual([])
    at.mono = 9_000
    time.resume()
    expect(at.timers.map((timer) => timer.at)).toEqual([9_100])
    at.wake()
    expect(ran).toEqual(['a'])
  })

  it('does not run what was waiting for its turn when it stopped, until it goes on', () => {
    const { at, ran, time, note } = made()
    time.after(0, note('a'))
    time.pause()
    at.settle()
    expect(ran).toEqual([])
    time.resume()
    at.settle()
    expect(ran).toEqual(['a'])
  })

  it('does nothing stopped twice or gone on with twice', () => {
    const { at, ran, time, note } = made()
    time.after(100, note('a'))
    time.resume()
    expect(at.set).toEqual([100])
    at.mono = 10
    time.pause()
    at.mono = 20
    time.pause()
    at.mono = 50
    time.resume()
    time.resume()
    // Forty passed while it was stopped, counted from the first stop.
    expect(at.timers.map((timer) => timer.at)).toEqual([140])
    at.wake()
    expect(ran).toEqual(['a'])
  })
})

describe('on the real time and timers', () => {
  it('runs what is due, in order, each in a turn of its own, and not what was called off', async () => {
    const time = clock()
    const ran: string[] = []
    let turnsOver = 0
    time.after(15, () => { ran.push('second') })
    time.after(5, () => { ran.push('first') })
    time.after(0, () => { ran.push('at once'); void Promise.resolve().then(() => { turnsOver++ }) })
    time.after(0, () => { ran.push(`after ${turnsOver}`) })
    time.after(10, () => { ran.push('never') })()
    const before = time.now()
    await time.sleep(40)
    expect(ran).toEqual(['at once', 'after 1', 'first', 'second'])
    expect(time.now()).toBeGreaterThanOrEqual(before)
    expect(Math.abs(time.now() - Date.now())).toBeLessThan(5_000)
  })

  it('leaves no timer set once what it was for is called off', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const time = clock()
    const off = time.after(60_000, () => {})
    expect(vi.getTimerCount()).toBe(1)
    off()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes its turns from setImmediate where there is one', async () => {
    const real = setImmediate
    let asked = 0
    vi.stubGlobal('setImmediate', (run: () => void) => { asked++; return real(run) })
    const time = clock()
    await time.sleep(0)
    expect(asked).toBe(1)
  })

  it('takes its turns from a message channel where there is no setImmediate, as in a window, in the order asked', async () => {
    vi.stubGlobal('setImmediate', undefined)
    const time = clock()
    const ran: string[] = []
    let turnsOver = 0
    time.after(0, () => { ran.push('a'); void Promise.resolve().then(() => { turnsOver++ }) })
    time.after(0, () => { ran.push(`b after ${turnsOver}`) })
    time.after(0, () => { ran.push('c') })
    await time.sleep(20)
    expect(ran).toEqual(['a', 'b after 1', 'c'])
  })
})

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
