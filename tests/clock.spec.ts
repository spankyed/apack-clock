import { afterEach, describe, expect, it, vi } from 'vitest'
import { clock, ClockClosedError, LONGEST, type Clock, type ManagedClock } from '../src/index.ts'
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
    expect(time.pending()).toBe(0)
    time.after(100, note('a'))
    expect(time.pending()).toBe(1)
    expect(at.timers).toEqual([{ at: 100, ms: 100, run: expect.any(Function) }])
    at.wake()
    expect(ran).toEqual(['a'])
    expect(time.pending()).toBe(0)
    expect(at.timers).toEqual([])
  })

  it('runs nothing as it is asked: what is due at once has a later turn', () => {
    const { at, ran, time, note } = made()
    time.after(0, note('a'))
    expect(ran).toEqual([])
    expect(at.timers).toEqual([])
    expect(time.pending()).toBe(1)
    at.settle()
    expect(ran).toEqual(['a'])
    expect(time.pending()).toBe(0)
  })

  it('takes negative finite lengths as nothing', () => {
    const { at, ran, time, note } = made()
    time.after(-50, note('a'))
    time.after(-0.5, note('b'))
    at.settle()
    expect(ran).toEqual(['a', 'b'])
  })

  it('runs in the order things are due, whatever order they were asked in', () => {
    const { at, ran, time, note } = made()
    time.after(30, note('c'))
    time.after(10, note('a'))
    time.after(20, note('b'))
    time.after(25, note('b2'))
    time.after(5, note('a0'))
    time.after(15, note('a2'))
    // One timer, for the first of them.
    expect(at.timers.map((timer) => timer.at)).toEqual([5])
    while (at.timers.length) at.wake()
    expect(ran).toEqual(['a0', 'a', 'a2', 'b', 'b2', 'c'])
    expect(time.pending()).toBe(0)
  })

  it('runs the one set first, of two due at the same moment', () => {
    const { at, ran, time, note } = made()
    time.after(10, note('first'))
    time.after(10, note('second'))
    at.mono = 4
    time.after(6, note('third'))
    time.after(6, note('fourth'))
    at.wake()
    at.settle()
    expect(ran).toEqual(['first', 'second', 'third', 'fourth'])
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

  it('runs nothing early when its timer runs before it was set to, rounding sub-ms remainders up', () => {
    const { at, ran, time, note } = made()
    time.after(100, note('a'))
    at.wake(-1)
    expect(ran).toEqual([])
    expect(at.timers.map((timer) => timer.ms)).toEqual([1])
    at.wake(-0.8)
    expect(ran).toEqual([])
    // 0.8ms remaining rounds up to 1ms rather than passing a sub-ms delay that truncates to 0.
    expect(at.timers.map((timer) => timer.ms)).toEqual([1])
    at.wake()
    expect(ran).toEqual(['a'])
  })

  it('ignores a spurious wakeup from a timer that was already called off', () => {
    const { at, ran, time, note } = made()
    const offA = time.after(100, note('a'))
    time.after(200, note('b'))
    offA()
    expect(at.cancelled).toHaveLength(1)
    // Even if an old timer fires late at t=200, it must not clobber b's timer or run prematurely.
    at.mono = 150
    at.cancelled[0]!()
    expect(ran).toEqual([])
    expect(at.timers.map((timer) => timer.at)).toEqual([200])
    at.wake()
    expect(ran).toEqual(['b'])
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

  it('throws for what is not a finite length of time, and sets nothing', () => {
    const { at, time } = made()
    for (const not of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '5' as unknown as number, undefined as unknown as number]) {
      expect(() => time.after(not, () => {})).toThrow(RangeError)
    }
    expect(() => time.after(Number.NaN, () => {})).toThrow(/given NaN/)
    expect(time.pending()).toBe(0)
    expect(at.timers).toEqual([])
    expect(at.turns).toBe(0)
  })

  it('resolves a sleep when that long has passed and removes its abort listener', async () => {
    const { at, ran, time } = made()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const waiting = time.sleep(50, { signal: controller.signal }).then(() => { ran.push('woke') })
    await Promise.resolve()
    expect(ran).toEqual([])
    at.wake()
    await waiting
    expect(ran).toEqual(['woke'])
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    // Aborting after resolution does nothing, and closing later does nothing.
    controller.abort(new Error('too late'))
    time.close()
  })

  it('aborts a sleep via AbortSignal, cancels its timer, and rejects already-aborted or non-finite sleeps', async () => {
    const { at, time } = made()
    await expect(time.sleep(Number.NaN)).rejects.toThrow(RangeError)

    const already = new AbortController()
    const reason = new Error('stopped already')
    already.abort(reason)
    const addSpy = vi.spyOn(already.signal, 'addEventListener')
    await expect(time.sleep(50, { signal: already.signal })).rejects.toBe(reason)
    expect(addSpy).not.toHaveBeenCalled()
    expect(time.pending()).toBe(0)
    expect(at.timers).toEqual([])

    const live = new AbortController()
    const liveReason = new Error('cancelled mid-sleep')
    const waiting = time.sleep(50, { signal: live.signal })
    expect(time.pending()).toBe(1)
    live.abort(liveReason)
    await expect(waiting).rejects.toBe(liveReason)
    expect(time.pending()).toBe(0)
    expect(at.timers).toEqual([])
  })
})

describe('calling off', () => {
  it('does not run what was called off, and sets its timer for what is then first', () => {
    const { at, ran, time, note } = made()
    const off = time.after(10, note('a'))
    time.after(20, note('b'))
    off()
    expect(time.pending()).toBe(1)
    expect(at.timers.map((timer) => timer.at)).toEqual([20])
    at.wake()
    expect(ran).toEqual(['b'])
  })

  it('leaves the timer as it is when what is called off was not first, and preserves heap order', () => {
    const { at, ran, time, note } = made()
    // Build a 7-node heap where removing an interior node triggers siftUp (swap with a smaller leaf on another branch).
    time.after(10, note('10'))
    time.after(50, note('50'))
    time.after(20, note('20'))
    const off60 = time.after(60, note('60'))
    const off70 = time.after(70, note('70'))
    time.after(25, note('25'))
    time.after(22, note('22'))
    // Removing 60 replaces it with 22 (which must siftUp past parent 50); removing 70 replaces it with 25 (siftUp past 50).
    off60()
    off70()
    expect(at.set).toEqual([10])
    while (at.timers.length) at.wake()
    expect(ran).toEqual(['10', '20', '22', '25', '50'])
    expect(at.timers).toEqual([])
  })

  it('sets no timer once nothing waits', () => {
    const { at, time, note } = made()
    const off = time.after(10, note('a'))
    off()
    expect(time.pending()).toBe(0)
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
  it('takes what is asked for from inside what it runs without mid-callback timer churn', () => {
    const { at, ran, time, note } = made()
    time.after(10, () => {
      ran.push('a')
      const offTemp = time.after(25, note('temp'))
      time.after(15, note('earlier'))
      offTemp()
      time.after(50, note('later'))
      // Still inside callback: no new underlying timer has been churned yet.
      expect(at.set).toEqual([10])
      time.after(0, note('at once'))
    })
    time.after(30, note('b'))
    at.wake()
    expect(ran).toEqual(['a'])
    // Only the initial 10ms timer was set; `at once` is handled via turn without arming a timer mid-callback.
    expect(at.set).toEqual([10])
    at.settle()
    expect(ran).toEqual(['a', 'at once'])
    while (at.timers.length) at.wake()
    expect(ran).toEqual(['a', 'at once', 'earlier', 'b', 'later'])
    expect(at.timers).toEqual([])
  })

  it('drops a later due timer cancelled from inside an earlier callback', () => {
    const { at, ran, time, note } = made()
    let cancelB = () => {}
    time.after(10, () => { ran.push('a'); cancelB() })
    cancelB = time.after(10, note('b'))
    time.after(10, note('c'))
    at.wake()
    at.settle()
    expect(ran).toEqual(['a', 'c'])
  })

  it('honours pause called from inside a callback before the next due timer runs', () => {
    const { at, ran, time, note } = made()
    time.after(10, () => { ran.push('a'); time.pause() })
    time.after(10, note('b'))
    at.wake()
    expect(ran).toEqual(['a'])
    expect(at.turns).toBe(0)
    expect(at.timers).toEqual([])
    at.mono = 500
    time.resume()
    at.settle()
    expect(ran).toEqual(['a', 'b'])
  })

  it('honours close called from inside a callback and drops remaining due timers', () => {
    const { at, ran, time, note } = made()
    time.after(10, () => { ran.push('a'); time.close() })
    time.after(10, note('b'))
    time.after(20, note('c'))
    at.wake()
    at.settle()
    expect(ran).toEqual(['a'])
    expect(time.pending()).toBe(0)
    expect(at.timers).toEqual([])
    expect(at.turns).toBe(0)
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

  it('never says a time earlier than it said, where the time of day is set back, and ignores non-finite values', () => {
    const { at, time } = made()
    at.wall = 5_000
    expect(time.now()).toBe(5_000)
    at.wall = 3_000
    expect(time.now()).toBe(5_000)
    at.wall = Number.NaN
    expect(time.now()).toBe(5_000)
    at.wall = Number.POSITIVE_INFINITY
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

describe('closing and disposal', () => {
  it('clears pending work and timers on close, ignores later asks/pause/resume/turns, and is idempotent', () => {
    const { at, ran, time, note } = made()
    const offA = time.after(10, note('a'))
    time.after(0, note('zero'))
    time.pause()
    time.close()
    time.close()
    expect(time.pending()).toBe(0)
    expect(at.timers).toEqual([])
    // Calling an old cancel handle, asking for more work, or pausing/resuming after close are all no-ops.
    offA()
    const offLate = time.after(5, note('late'))
    expect(time.pending()).toBe(0)
    expect(at.timers).toEqual([])
    offLate()
    time.pause()
    time.resume()
    at.settle()
    expect(ran).toEqual([])
    expect(time.pending()).toBe(0)
    expect(at.timers).toEqual([])
  })

  it('rejects pending and later sleeps with ClockClosedError on close and removes their abort listeners', async () => {
    const { at, time } = made()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const waiting = time.sleep(100, { signal: controller.signal })
    time.close()
    await expect(waiting).rejects.toSatisfy((error: unknown) =>
      error instanceof ClockClosedError && error.name === 'ClockClosedError' && error.message === 'The clock is closed',
    )
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    await expect(time.sleep(10)).rejects.toBeInstanceOf(ClockClosedError)
    expect(at.timers).toEqual([])
  })

  it('separates consumer Clock capability from ManagedClock lifecycle', () => {
    const managed: ManagedClock = clock(world().sources)
    const consumer: Clock = managed
    // A minimal consumer Clock fake requires no Disposable or lifecycle methods.
    const fake: Clock = {
      now: () => 0,
      after: () => () => {},
      sleep: async () => {},
    }
    expect(fake.now()).toBe(0)
    expect(typeof consumer.now).toBe('function')
    expect(typeof consumer.after).toBe('function')
    expect(typeof consumer.sleep).toBe('function')
    // @ts-expect-error Consumer Clock does not expose host lifecycle controls.
    void consumer.close
    // @ts-expect-error Consumer Clock does not expose host lifecycle controls.
    void consumer.pause
    // @ts-expect-error Consumer Clock does not expose host lifecycle controls.
    void consumer.resume
    // @ts-expect-error Consumer Clock does not expose host inspection controls.
    void consumer.pending
    // @ts-expect-error Consumer Clock does not extend Disposable.
    void consumer[Symbol.dispose]
    managed.close()
  })

  it('disposes via Symbol.dispose (`using`)', () => {
    const at = world()
    const ran: string[] = []
    {
      using time = clock(at.sources)
      time.after(50, () => { ran.push('never') })
      expect(at.timers).toHaveLength(1)
    }
    expect(at.timers).toEqual([])
    expect(ran).toEqual([])
  })
})

describe('on the real time and timers', () => {
  it('runs what is due, in order, each in a turn of its own, and not what was called off', async () => {
    using time = clock()
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

  it('leaves no timer set once what it was for is called off or the clock is closed', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const time = clock()
    const off = time.after(60_000, () => {})
    expect(vi.getTimerCount()).toBe(1)
    off()
    expect(vi.getTimerCount()).toBe(0)
    time.after(60_000, () => {})
    expect(vi.getTimerCount()).toBe(1)
    time.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.skipIf(typeof setImmediate !== 'function')('takes its turns from setImmediate where there is one, and cancels pending immediates on close()', async () => {
    const realSet = setImmediate
    const realClear = clearImmediate
    let asked = 0
    let cleared = 0
    vi.stubGlobal('setImmediate', (run: () => void) => { asked++; return realSet(run) })
    vi.stubGlobal('clearImmediate', (handle: ReturnType<typeof setImmediate>) => { cleared++; return realClear(handle) })
    using time = clock()
    await time.sleep(0)
    expect(asked).toBe(1)
    expect(cleared).toBe(0)
    // A pending immediate queued when close() runs is cleared immediately.
    time.after(0, () => {})
    time.close()
    expect(cleared).toBe(1)
    // Closing again does not double-clear.
    time.close()
    expect(cleared).toBe(1)
  })

  it.skipIf(typeof setImmediate === 'function')('runs unstubbed in a real browser window via MessageChannel, performance.now(), setTimeout, and AbortSignal', async () => {
    expect(typeof setImmediate).toBe('undefined')
    using time = clock()
    const ran: string[] = []
    let microtasks = 0
    time.after(0, () => { ran.push('zero-1'); void Promise.resolve().then(() => { microtasks++ }) })
    time.after(0, () => { ran.push(`zero-2 after ${microtasks}`) })
    time.after(15, () => { ran.push('delayed') })
    const controller = new AbortController()
    const aborted = time.sleep(5_000, { signal: controller.signal })
    controller.abort(new Error('browser-abort'))
    await expect(aborted).rejects.toThrow('browser-abort')
    await time.sleep(35)
    expect(ran).toEqual(['zero-1', 'zero-2 after 1', 'delayed'])
    expect(time.pending()).toBe(0)
  })

  it('takes its turns from a message channel where there is no setImmediate, reuses it, and closes it on close()', async () => {
    vi.stubGlobal('setImmediate', undefined)
    const RealMessageChannel = MessageChannel
    let created = 0
    let port1Closed = 0
    let port2Closed = 0
    let lastPort1: { onmessage: unknown } | undefined
    vi.stubGlobal('MessageChannel', class {
      port1: InstanceType<typeof RealMessageChannel>['port1']
      port2: InstanceType<typeof RealMessageChannel>['port2']
      constructor() {
        created++
        const real = new RealMessageChannel()
        const close1 = real.port1.close.bind(real.port1)
        const close2 = real.port2.close.bind(real.port2)
        real.port1.close = () => { port1Closed++; close1() }
        real.port2.close = () => { port2Closed++; close2() }
        this.port1 = real.port1
        this.port2 = real.port2
        lastPort1 = real.port1 as unknown as { onmessage: unknown }
      }
    })
    const time = clock()
    const ran: string[] = []
    let turnsOver = 0
    time.after(0, () => { ran.push('a'); void Promise.resolve().then(() => { turnsOver++ }) })
    time.after(0, () => { ran.push(`b after ${turnsOver}`) })
    time.after(0, () => { ran.push('c') })
    await time.sleep(20)
    expect(ran).toEqual(['a', 'b after 1', 'c'])
    expect(created).toBe(1)
    time.close()
    expect(lastPort1?.onmessage).toBeNull()
    expect(port1Closed).toBe(1)
    expect(port2Closed).toBe(1)
    // Closing twice does not double-close ports; closing an unused clock creates no channel.
    time.close()
    expect(port1Closed).toBe(1)
    const unused = clock()
    unused.close()
    expect(created).toBe(1)
  })
})

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
