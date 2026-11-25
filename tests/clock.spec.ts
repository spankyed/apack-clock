import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClockController, ClockClosedError, MAX_TIMER_MS, type Clock } from '../src/index.ts'
import { world } from './support/world.ts'

/** A clock controller in a world, its consumer clock, and what ran, in the order it ran. */
const made = () => {
  const at = world()
  const ran: string[] = []
  const controller = new ClockController(at.sources)
  return { at, ran, controller, clock: controller.clock, note: (what: string) => () => { ran.push(what) } }
}

describe('what runs, and when', () => {
  it('runs what was asked for once that long has passed, and not before', () => {
    const { at, ran, controller, clock, note } = made()
    expect(controller.waiting()).toBe(0)
    clock.after(100, note('a'))
    expect(controller.waiting()).toBe(1)
    expect(at.timers).toEqual([{ at: 100, ms: 100, run: expect.any(Function) }])
    at.wake()
    expect(ran).toEqual(['a'])
    expect(controller.waiting()).toBe(0)
    expect(at.timers).toEqual([])
  })

  it('runs nothing as it is asked: what is due at once has a later turn', () => {
    const { at, ran, controller, clock, note } = made()
    clock.after(0, note('a'))
    expect(ran).toEqual([])
    expect(at.timers).toEqual([])
    expect(controller.waiting()).toBe(1)
    at.settle()
    expect(ran).toEqual(['a'])
    expect(controller.waiting()).toBe(0)
  })

  it('takes negative finite lengths as nothing', () => {
    const { at, ran, clock, note } = made()
    clock.after(-50, note('a'))
    clock.after(-0.5, note('b'))
    at.settle()
    expect(ran).toEqual(['a', 'b'])
  })

  it('runs in the order things are due, whatever order they were asked in', () => {
    const { at, ran, controller, clock, note } = made()
    clock.after(30, note('c'))
    clock.after(10, note('a'))
    clock.after(20, note('b'))
    clock.after(25, note('b2'))
    clock.after(5, note('a0'))
    clock.after(15, note('a2'))
    // One timer, for the first of them.
    expect(at.timers.map((timer) => timer.at)).toEqual([5])
    while (at.timers.length) at.wake()
    expect(ran).toEqual(['a0', 'a', 'a2', 'b', 'b2', 'c'])
    expect(controller.waiting()).toBe(0)
  })

  it('runs the one set first, of two due at the same moment', () => {
    const { at, ran, clock, note } = made()
    clock.after(10, note('first'))
    clock.after(10, note('second'))
    at.mono = 4
    clock.after(6, note('third'))
    clock.after(6, note('fourth'))
    at.wake()
    at.settle()
    expect(ran).toEqual(['first', 'second', 'third', 'fourth'])
  })

  it('gives each thing it runs a turn to itself, however many are due', () => {
    const { at, ran, clock, note } = made()
    for (const name of ['a', 'b', 'c']) clock.after(10, note(name))
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
    const { at, ran, clock, note } = made()
    clock.after(100, note('a'))
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
    const { at, ran, clock, note } = made()
    const offA = clock.after(100, note('a'))
    clock.after(200, note('b'))
    offA()
    expect(at.cancelled).toHaveLength(1)
    // Even if an old timer fires late at t=150, it must not clobber b's timer or run prematurely.
    at.mono = 150
    at.cancelled[0]!()
    expect(ran).toEqual([])
    expect(at.timers.map((timer) => timer.at)).toEqual([200])
    at.wake()
    expect(ran).toEqual(['b'])
  })

  it('runs what is due however late it is woken, and sets its timer for what is not', () => {
    const { at, ran, clock, note } = made()
    clock.after(10, note('a'))
    clock.after(5_000, note('b'))
    at.wake(60_000)
    at.settle()
    expect(ran).toEqual(['a', 'b'])
    clock.after(10, note('c'))
    clock.after(900, note('d'))
    at.wake(100)
    at.settle()
    expect(ran).toEqual(['a', 'b', 'c'])
    expect(at.timers.map((timer) => timer.ms)).toEqual([790])
  })

  it('waits longer than a timer can be set for, a hop at a time', () => {
    const { at, ran, clock, note } = made()
    const long = MAX_TIMER_MS * 2 + 500
    clock.after(long, note('a'))
    at.wake()
    at.wake()
    expect(ran).toEqual([])
    at.wake()
    expect(ran).toEqual(['a'])
    expect(at.set).toEqual([MAX_TIMER_MS, MAX_TIMER_MS, 500])
    expect(at.mono).toBe(long)
  })

  it('throws for what is not a finite length of time, and sets nothing', () => {
    const { at, controller, clock } = made()
    for (const not of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '5' as unknown as number, undefined as unknown as number]) {
      expect(() => clock.after(not, () => {})).toThrow(RangeError)
    }
    expect(() => clock.after(Number.NaN, () => {})).toThrow(/given NaN/)
    // Overflowing `monotonic() + ms` to Infinity is also rejected before touching the heap.
    at.mono = Number.MAX_VALUE
    expect(() => clock.after(Number.MAX_VALUE, () => {})).toThrow(/overflows the monotonic deadline/)
    expect(controller.waiting()).toBe(0)
    expect(at.timers).toEqual([])
    expect(at.turns).toBe(0)
  })

  it('resolves a sleep when that long has passed and removes its abort listener', async () => {
    const { at, ran, controller, clock } = made()
    const abort = new AbortController()
    const remove = vi.spyOn(abort.signal, 'removeEventListener')
    const waiting = clock.sleep(50, { signal: abort.signal }).then(() => { ran.push('woke') })
    await Promise.resolve()
    expect(ran).toEqual([])
    at.wake()
    await waiting
    expect(ran).toEqual(['woke'])
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    // Aborting after resolution does nothing, and closing later does nothing.
    abort.abort(new Error('too late'))
    controller.close()
  })

  it('aborts a sleep via AbortSignal, cancels its timer, and rejects already-aborted or non-finite sleeps', async () => {
    const { at, controller, clock } = made()
    await expect(clock.sleep(Number.NaN)).rejects.toThrow(RangeError)

    const already = new AbortController()
    const reason = new Error('stopped already')
    already.abort(reason)
    await expect(clock.sleep(Number.NaN, { signal: already.signal })).rejects.toThrow(RangeError)
    const addSpy = vi.spyOn(already.signal, 'addEventListener')
    await expect(clock.sleep(50, { signal: already.signal })).rejects.toBe(reason)
    expect(addSpy).not.toHaveBeenCalled()
    expect(controller.waiting()).toBe(0)
    expect(at.timers).toEqual([])

    const live = new AbortController()
    const liveReason = new Error('cancelled mid-sleep')
    const waiting = clock.sleep(50, { signal: live.signal })
    expect(controller.waiting()).toBe(1)
    live.abort(liveReason)
    await expect(waiting).rejects.toBe(liveReason)
    expect(controller.waiting()).toBe(0)
    expect(at.timers).toEqual([])
  })
})

describe('calling off', () => {
  it('does not run what was called off, and sets its timer for what is then first', () => {
    const { at, ran, controller, clock, note } = made()
    const off = clock.after(10, note('a'))
    clock.after(20, note('b'))
    off()
    expect(controller.waiting()).toBe(1)
    expect(at.timers.map((timer) => timer.at)).toEqual([20])
    at.wake()
    expect(ran).toEqual(['b'])
  })

  it('leaves the timer as it is when what is called off was not first, and preserves heap order', () => {
    const { at, ran, clock, note } = made()
    // Build a 7-node heap where removing an interior node triggers siftUp (swap with a smaller leaf on another branch).
    clock.after(10, note('10'))
    clock.after(50, note('50'))
    clock.after(20, note('20'))
    const off60 = clock.after(60, note('60'))
    const off70 = clock.after(70, note('70'))
    clock.after(25, note('25'))
    clock.after(22, note('22'))
    // Removing 60 replaces it with 22 (which must siftUp past parent 50); removing 70 replaces it with 25 (siftUp past 50).
    off60()
    off70()
    expect(at.set).toEqual([10])
    while (at.timers.length) at.wake()
    expect(ran).toEqual(['10', '20', '22', '25', '50'])
    expect(at.timers).toEqual([])
  })

  it('sets no timer once nothing waits', () => {
    const { at, controller, clock, note } = made()
    const off = clock.after(10, note('a'))
    off()
    expect(controller.waiting()).toBe(0)
    expect(at.timers).toEqual([])
  })

  it('does nothing called twice, or after what it would call off has run', () => {
    const { at, ran, clock, note } = made()
    const first = clock.after(10, note('a'))
    clock.after(20, note('b'))
    at.wake()
    first()
    first()
    expect(at.timers.map((timer) => timer.at)).toEqual([20])
    expect(at.set).toEqual([10, 10])
    at.wake()
    expect(ran).toEqual(['a', 'b'])
  })

  it('does not run what is called off while it waits for its turn', () => {
    const { at, ran, clock, note } = made()
    const off = clock.after(0, note('a'))
    clock.after(0, note('b'))
    off()
    at.settle()
    expect(ran).toEqual(['b'])
  })
})

describe('what is asked for as something runs', () => {
  it('takes what is asked for from inside what it runs without mid-callback timer churn', () => {
    const { at, ran, clock, note } = made()
    clock.after(10, () => {
      ran.push('a')
      const offTemp = clock.after(25, note('temp'))
      clock.after(15, note('earlier'))
      offTemp()
      clock.after(50, note('later'))
      // Still inside callback: no new underlying timer has been churned yet.
      expect(at.set).toEqual([10])
      clock.after(0, note('at once'))
    })
    clock.after(30, note('b'))
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
    const { at, ran, clock, note } = made()
    let cancelB = () => {}
    clock.after(10, () => { ran.push('a'); cancelB() })
    cancelB = clock.after(10, note('b'))
    clock.after(10, note('c'))
    at.wake()
    at.settle()
    expect(ran).toEqual(['a', 'c'])
  })

  it('honours suspend called from inside a callback before the next due timer runs', () => {
    const { at, ran, controller, clock, note } = made()
    clock.after(10, () => { ran.push('a'); controller.suspend() })
    clock.after(10, note('b'))
    at.wake()
    expect(ran).toEqual(['a'])
    expect(at.turns).toBe(0)
    expect(at.timers).toEqual([])
    at.mono = 500
    controller.resume()
    at.settle()
    expect(ran).toEqual(['a', 'b'])
  })

  it('honours close called from inside a callback and drops remaining due timers', () => {
    const { at, ran, controller, clock, note } = made()
    clock.after(10, () => { ran.push('a'); controller.close() })
    clock.after(10, note('b'))
    clock.after(20, note('c'))
    at.wake()
    at.settle()
    expect(ran).toEqual(['a'])
    expect(controller.waiting()).toBe(0)
    expect(at.timers).toEqual([])
    expect(at.turns).toBe(0)
  })

  it('goes on to what waits after something it ran threw, and hands on what was thrown', () => {
    const { at, ran, clock, note } = made()
    clock.after(10, () => { throw new Error('broke') })
    clock.after(10, note('b'))
    clock.after(20, note('c'))
    expect(() => { at.wake() }).toThrow('broke')
    at.settle()
    expect(ran).toEqual(['b'])
    at.wake()
    expect(ran).toEqual(['b', 'c'])
  })
})

describe('the time it is', () => {
  it('says the time of day', () => {
    const { at, clock } = made()
    expect(clock.now()).toBe(1_000_000)
    at.wall += 250
    expect(clock.now()).toBe(1_000_250)
  })

  it('never says a time earlier than it said, where the time of day is set back, and ignores non-finite values', () => {
    const { at, clock } = made()
    at.wall = 5_000
    expect(clock.now()).toBe(5_000)
    at.wall = 3_000
    expect(clock.now()).toBe(5_000)
    at.wall = Number.NaN
    expect(clock.now()).toBe(5_000)
    at.wall = Number.POSITIVE_INFINITY
    expect(clock.now()).toBe(5_000)
    at.wall = 5_001
    expect(clock.now()).toBe(5_001)
  })

  it('moves nothing that waits when the time of day is set', () => {
    const { at, ran, clock, note } = made()
    clock.after(100, note('a'))
    at.wall += 3_600_000
    clock.now()
    expect(at.timers.map((timer) => timer.at)).toEqual([100])
    at.wall -= 7_200_000
    at.wake()
    expect(ran).toEqual(['a'])
  })

  it('exposes monotonic() independent of wall jumps, excluding suspended spans without float dips, and continuous across close()', () => {
    const { at, controller, clock } = made()
    expect(clock.monotonic()).toBe(0)
    at.mono = 25
    at.wall += 3_600_000
    expect(clock.monotonic()).toBe(25)
    at.wall -= 7_200_000
    expect(clock.monotonic()).toBe(25)

    // Schedule across two suspend/resume cycles: elapsed monotonic() matches the 100 ms wait exactly.
    const start = clock.monotonic()
    let firedAt = -1
    clock.after(100, () => { firedAt = clock.monotonic() })

    at.mono = 65 // +40 active
    expect(clock.monotonic()).toBe(65)
    controller.suspend()
    at.mono = 10_065 // +10_000 suspended (excluded)
    expect(clock.monotonic()).toBe(65)
    controller.resume()
    expect(clock.monotonic()).toBe(65)

    at.mono = 10_095 // +30 active (total 95)
    expect(clock.monotonic()).toBe(95)
    controller.suspend()
    at.mono = 60_095 // +50_000 suspended (excluded)
    expect(clock.monotonic()).toBe(95)
    controller.resume()
    expect(clock.monotonic()).toBe(95)

    // Remaining 30 ms of the 100 ms wait fires at active monotonic 125 (start + 100).
    at.wake()
    expect(firedAt).toBe(start + 100)
    expect(clock.monotonic()).toBe(125)

    // Floating-point continuity across a large suspend span: 0.3 must not dip to 0.29999999999999716 on resume.
    const fractional = made()
    fractional.at.mono = 0.3
    expect(fractional.clock.monotonic()).toBe(0.3)
    fractional.controller.suspend()
    fractional.at.mono = 100.3
    expect(fractional.clock.monotonic()).toBe(0.3)
    fractional.controller.resume()
    expect(fractional.clock.monotonic()).toBe(0.3)
    fractional.at.mono = 100.8
    expect(fractional.clock.monotonic()).toBe(0.8)
    fractional.controller.close()
    // Closing while NOT suspended preserves monotonic() cleanly.
    expect(fractional.clock.monotonic()).toBe(0.8)
    fractional.at.mono = 101.8
    expect(fractional.clock.monotonic()).toBe(1.8)

    // Closing while suspended folds the suspended span cleanly with no jump and keeps advancing afterward.
    const closedSuspended = made()
    closedSuspended.at.mono = 15
    closedSuspended.controller.suspend()
    closedSuspended.at.mono = 5_015
    expect(closedSuspended.clock.monotonic()).toBe(15)
    closedSuspended.controller.close()
    expect(closedSuspended.clock.monotonic()).toBe(15)
    closedSuspended.at.mono = 5_040
    expect(closedSuspended.clock.monotonic()).toBe(40)
  })
})

describe('suspending the count', () => {
  it('runs nothing while suspended, and counts nothing that passed until it resumes', () => {
    const { at, ran, controller, clock, note } = made()
    clock.after(100, note('a'))
    at.mono = 40
    controller.suspend()
    expect(at.timers).toEqual([])
    at.mono = 3_600_040
    controller.resume()
    // Sixty are left of its hundred.
    expect(at.timers.map((timer) => timer.ms)).toEqual([60])
    at.wake()
    expect(ran).toEqual(['a'])
  })

  it('counts what is asked for while suspended from when it resumes', () => {
    const { at, ran, controller, clock, note } = made()
    controller.suspend()
    at.mono = 500
    clock.after(100, note('a'))
    expect(at.timers).toEqual([])
    at.mono = 9_000
    controller.resume()
    expect(at.timers.map((timer) => timer.at)).toEqual([9_100])
    at.wake()
    expect(ran).toEqual(['a'])
  })

  it('does not run what was waiting for its turn when it suspended, until it resumes', () => {
    const { at, ran, controller, clock, note } = made()
    clock.after(0, note('a'))
    controller.suspend()
    at.settle()
    expect(ran).toEqual([])
    controller.resume()
    at.settle()
    expect(ran).toEqual(['a'])
  })

  it('does nothing suspended twice or resumed twice', () => {
    const { at, ran, controller, clock, note } = made()
    clock.after(100, note('a'))
    controller.resume()
    expect(at.set).toEqual([100])
    at.mono = 10
    controller.suspend()
    at.mono = 20
    controller.suspend()
    at.mono = 50
    controller.resume()
    controller.resume()
    // Forty passed while it was suspended, counted from the first suspend.
    expect(at.timers.map((timer) => timer.at)).toEqual([140])
    at.wake()
    expect(ran).toEqual(['a'])
  })

  it('preserves heap order when resuming collapses sub-ULP deadlines to equal floats', () => {
    const { at, ran, controller, clock, note } = made()
    // Builds a 5-node heap with e0 (seq 0) at index 3 under e1 (index 1) and e4 (index 0).
    clock.after(2e-10, note('e0'))
    clock.after(1e-10, note('e1'))
    clock.after(3e-10, note('e2'))
    clock.after(1.5e-10, note('e3'))
    clock.after(0, note('e4'))
    controller.suspend()
    at.mono = 1e7
    controller.resume()
    // All five deadlines collapse to 1e7; Floyd heapify restores exact FIFO order by seq.
    at.settle()
    expect(ran).toEqual(['e0', 'e1', 'e2', 'e3', 'e4'])
    expect(controller.waiting()).toBe(0)
  })
})

describe('closing and controller separation', () => {
  it('clears pending work and timers on close, throws ClockClosedError from after(), ignores suspend/resume/turns, and is idempotent', () => {
    const { at, ran, controller, clock, note } = made()
    const offA = clock.after(10, note('a'))
    clock.after(0, note('zero'))
    controller.suspend()
    controller.close()
    controller.close()
    expect(controller.waiting()).toBe(0)
    expect(at.timers).toEqual([])
    // Calling an old cancel handle or suspending/resuming after close are no-ops; scheduling throws ClockClosedError.
    offA()
    expect(() => clock.after(5, note('late'))).toThrow(ClockClosedError)
    expect(controller.waiting()).toBe(0)
    expect(at.timers).toEqual([])
    controller.suspend()
    controller.resume()
    at.settle()
    expect(ran).toEqual([])
    expect(controller.waiting()).toBe(0)
    expect(at.timers).toEqual([])
  })

  it('rejects pending and later sleeps with ClockClosedError on close and removes their abort listeners', async () => {
    const { at, controller, clock } = made()
    const abort = new AbortController()
    const remove = vi.spyOn(abort.signal, 'removeEventListener')
    const waiting = clock.sleep(100, { signal: abort.signal })
    controller.close()
    await expect(waiting).rejects.toSatisfy((error: unknown) =>
      error instanceof ClockClosedError && error.name === 'ClockClosedError' && error.message === 'The clock is closed; nothing new may be asked of it',
    )
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    await expect(clock.sleep(10)).rejects.toBeInstanceOf(ClockClosedError)
    expect(at.timers).toEqual([])
  })

  it('separates ClockController from Clock both at compile time and at runtime', async () => {
    const { at, ran, controller, note } = made()
    const host: ClockController = controller
    const consumer: Clock = host.clock
    // Controller methods are bound so they can be passed directly as event listeners (e.g. powerMonitor.on).
    const { suspend, resume, close, waiting } = host
    expect(waiting()).toBe(0)
    suspend()
    resume()
    expect(Object.isFrozen(consumer)).toBe(true)
    expect(Object.keys(consumer).sort()).toEqual(['after', 'monotonic', 'now', 'sleep'])
    expect('close' in consumer).toBe(false)
    expect('suspend' in consumer).toBe(false)
    expect('resume' in consumer).toBe(false)
    expect('waiting' in consumer).toBe(false)
    expect('clock' in consumer).toBe(false)
    // A minimal consumer Clock fake requires no lifecycle methods.
    const fake: Clock = {
      now: () => 0,
      monotonic: () => 0,
      after: () => () => {},
      sleep: async () => {},
    }
    expect(fake.now()).toBe(0)
    expect(fake.monotonic()).toBe(0)
    // A ClockController cannot be passed where a Clock is expected.
    // @ts-expect-error ClockController is not a Clock; pass controller.clock instead.
    const leaked: Clock = host
    void leaked
    // @ts-expect-error Consumer Clock does not expose host lifecycle controls.
    void consumer.close
    // @ts-expect-error Consumer Clock does not expose host lifecycle controls.
    void consumer.suspend
    // @ts-expect-error Consumer Clock does not expose host lifecycle controls.
    void consumer.resume
    // @ts-expect-error Consumer Clock does not expose host inspection controls.
    void consumer.waiting
    expect(consumer.now()).toBe(1_000_000)
    consumer.after(10, note('via-clock'))
    const nap = consumer.sleep(20)
    at.wake()
    expect(ran).toEqual(['via-clock'])
    at.wake()
    await nap
    close()
    expect(() => consumer.after(1, note('after-close'))).toThrow(ClockClosedError)
    await expect(consumer.sleep(1)).rejects.toBeInstanceOf(ClockClosedError)
  })
})

describe('on the real time and timers', () => {
  it('runs what is due, in order, each in a turn of its own, and not what was called off', async () => {
    const controller = new ClockController()
    const { clock } = controller
    try {
      const ran: string[] = []
      let turnsOver = 0
      clock.after(0, () => { ran.push('at once'); void Promise.resolve().then(() => { turnsOver++ }) })
      clock.after(0, () => { ran.push(`after ${turnsOver}`) })
      clock.after(50, () => { ran.push('second') })
      clock.after(10, () => { ran.push('first') })
      clock.after(30, () => { ran.push('never') })()
      const before = clock.now()
      const beforeMono = clock.monotonic()
      await clock.sleep(80)
      expect(ran).toEqual(['at once', 'after 1', 'first', 'second'])
      expect(clock.now()).toBeGreaterThanOrEqual(before)
      expect(clock.monotonic() - beforeMono).toBeGreaterThanOrEqual(80)
      expect(Math.abs(clock.now() - Date.now())).toBeLessThan(5_000)
    } finally {
      controller.close()
    }
  })

  it('leaves no timer set once what it was for is called off or the clock is closed', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const controller = new ClockController()
    const off = controller.clock.after(60_000, () => {})
    expect(vi.getTimerCount()).toBe(1)
    off()
    expect(vi.getTimerCount()).toBe(0)
    controller.clock.after(60_000, () => {})
    expect(vi.getTimerCount()).toBe(1)
    controller.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.skipIf(typeof setImmediate !== 'function')('takes its turns from setImmediate where there is one, and cancels pending immediates on close()', async () => {
    const realSet = setImmediate
    const realClear = clearImmediate
    let asked = 0
    let cleared = 0
    vi.stubGlobal('setImmediate', (run: () => void) => { asked++; return realSet(run) })
    vi.stubGlobal('clearImmediate', (handle: ReturnType<typeof setImmediate>) => { cleared++; return realClear(handle) })
    const controller = new ClockController()
    try {
      await controller.clock.sleep(0)
      expect(asked).toBe(1)
      expect(cleared).toBe(0)
      // A pending immediate queued when close() runs is cleared immediately.
      controller.clock.after(0, () => {})
      controller.close()
      expect(cleared).toBe(1)
      // Closing again does not double-clear.
      controller.close()
      expect(cleared).toBe(1)
    } finally {
      controller.close()
    }
  })

  it.skipIf(typeof setImmediate === 'function')('runs unstubbed in a real browser window via MessageChannel, performance.now(), setTimeout, and AbortSignal', async () => {
    expect(typeof setImmediate).toBe('undefined')
    const controller = new ClockController()
    const { clock } = controller
    try {
      const ran: string[] = []
      let microtasks = 0
      clock.after(0, () => { ran.push('zero-1'); void Promise.resolve().then(() => { microtasks++ }) })
      clock.after(0, () => { ran.push(`zero-2 after ${microtasks}`) })
      clock.after(15, () => { ran.push('delayed') })
      const abort = new AbortController()
      const aborted = clock.sleep(5_000, { signal: abort.signal })
      abort.abort(new Error('browser-abort'))
      await expect(aborted).rejects.toThrow('browser-abort')
      await clock.sleep(35)
      expect(ran).toEqual(['zero-1', 'zero-2 after 1', 'delayed'])
      expect(controller.waiting()).toBe(0)
    } finally {
      controller.close()
    }
  })

  it('takes its turns from a message channel where there is no setImmediate, unrefs if available, reuses it, and closes it on close()', async () => {
    vi.stubGlobal('setImmediate', undefined)
    const RealMessageChannel = MessageChannel
    let created = 0
    let port1Closed = 0
    let port2Closed = 0
    let unrefCalled = 0
    let includeUnref = true
    let lastPort1: { onmessage: unknown } | undefined
    vi.stubGlobal('MessageChannel', class {
      port1: { onmessage: (() => void) | null; close: () => void; unref?: () => void }
      port2: InstanceType<typeof RealMessageChannel>['port2']
      constructor() {
        created++
        const real = new RealMessageChannel()
        const realPort1 = real.port1 as unknown as { onmessage: (() => void) | null; close: () => void; unref?: () => void }
        const close1 = real.port1.close.bind(real.port1)
        const close2 = real.port2.close.bind(real.port2)
        real.port2.close = () => { port2Closed++; close2() }
        const wrapped: { onmessage: (() => void) | null; close: () => void; unref?: () => void } = {
          get onmessage() { return realPort1.onmessage },
          set onmessage(fn) { realPort1.onmessage = fn },
          close: () => { port1Closed++; close1() },
        }
        if (includeUnref) wrapped.unref = () => { unrefCalled++; realPort1.unref?.() }
        this.port1 = wrapped
        this.port2 = real.port2
        lastPort1 = wrapped
      }
    })
    const controller = new ClockController()
    const ran: string[] = []
    let turnsOver = 0
    controller.clock.after(0, () => { ran.push('a'); void Promise.resolve().then(() => { turnsOver++ }) })
    controller.clock.after(0, () => { ran.push(`b after ${turnsOver}`) })
    controller.clock.after(0, () => { ran.push('c') })
    await controller.clock.sleep(20)
    expect(ran).toEqual(['a', 'b after 1', 'c'])
    expect(created).toBe(1)
    expect(unrefCalled).toBe(1)
    controller.close()
    expect(lastPort1?.onmessage).toBeNull()
    expect(port1Closed).toBe(1)
    expect(port2Closed).toBe(1)
    // Closing twice does not double-close ports; closing an unused clock creates no channel.
    controller.close()
    expect(port1Closed).toBe(1)
    const unused = new ClockController()
    unused.close()
    expect(created).toBe(1)
    // Browser MessagePort lacks unref(): the channel still works cleanly without it.
    includeUnref = false
    const browserLike = new ClockController()
    await browserLike.clock.sleep(0)
    browserLike.close()
    expect(created).toBe(2)
    expect(unrefCalled).toBe(1)
  })
})

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
