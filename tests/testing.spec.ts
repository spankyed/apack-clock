import { describe, expect, it, vi } from 'vitest'
import { MAX_TIMER_MS, type Clock } from '../src/index.ts'
import { TestClock } from '../src/testing.ts'

/** Deterministic Mulberry32 PRNG for seeded randomized traces. */
const prng = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

describe('TestClock (@apackdev/clock/testing)', () => {
  it('advances event-by-event across chained async sleeps and deep microtask chains', async () => {
    const testClock = new TestClock({ wall: 1_000 })
    const clock: Clock = testClock.clock
    const log: string[] = []

    const task = (async () => {
      // Deep microtask chain before the first sleep must settle before advance() checks timers.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      log.push(`start@${clock.now()}`)
      await clock.sleep(10)
      log.push(`mid@${clock.now()}`)
      await Promise.resolve().then(() => Promise.resolve())
      await clock.sleep(15)
      log.push(`end@${clock.now()}`)
    })()

    await testClock.advance(25)
    await task
    expect(log).toEqual(['start@1000', 'mid@1010', 'end@1025'])
    expect(testClock.elapsed()).toBe(25)
    expect(testClock.waiting()).toBe(0)
    testClock.close()
  })

  it('fires sub-millisecond waits at their exact deadlines in both advance() and next()', async () => {
    const testClock = new TestClock({ wall: 100 })
    const log: Array<{ readonly name: string; readonly elapsed: number; readonly wall: number }> = []

    testClock.clock.after(0.1, () => {
      log.push({ name: 'a', elapsed: testClock.elapsed(), wall: testClock.clock.now() })
    })
    testClock.clock.after(0.2, () => {
      log.push({ name: 'b', elapsed: testClock.elapsed(), wall: testClock.clock.now() })
    })

    // Advancing 0.05 ms must NOT fire the 0.1 ms wait.
    await testClock.advance(0.05)
    expect(log).toEqual([])
    expect(testClock.elapsed()).toBeCloseTo(0.05, 10)

    // Advancing another 0.45 ms (to 0.5 ms total) fires BOTH at their exact 0.1 and 0.2 timestamps.
    await testClock.advance(0.45)
    expect(log).toHaveLength(2)
    expect(log[0]!.name).toBe('a')
    expect(log[0]!.elapsed).toBeCloseTo(0.1, 10)
    expect(log[0]!.wall).toBeCloseTo(100.1, 10)
    expect(log[1]!.name).toBe('b')
    expect(log[1]!.elapsed).toBeCloseTo(0.2, 10)
    expect(log[1]!.wall).toBeCloseTo(100.2, 10)
    expect(testClock.elapsed()).toBeCloseTo(0.5, 10)

    // next() also jumps to the exact sub-ms deadline instead of Math.ceil(1 ms).
    let nextAt = -1
    testClock.clock.after(0.25, () => { nextAt = testClock.elapsed() })
    expect(await testClock.next()).toBe(true)
    expect(nextAt).toBeCloseTo(0.75, 10)
    expect(testClock.elapsed()).toBeCloseTo(0.75, 10)
    testClock.close()
  })

  it('supports advance(0) for immediate turns without moving time, and rejects invalid or overflowing durations', async () => {
    const testClock = new TestClock({ wall: 500 })
    const ran: string[] = []
    testClock.clock.after(0, () => { ran.push(`zero@${testClock.clock.now()}`) })
    testClock.clock.after(10, () => { ran.push(`ten@${testClock.clock.now()}`) })

    await testClock.advance(0)
    expect(ran).toEqual(['zero@500'])
    expect(testClock.clock.now()).toBe(500)
    expect(testClock.elapsed()).toBe(0)
    expect(testClock.waiting()).toBe(1)

    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(testClock.advance(bad)).rejects.toThrow(RangeError)
    }
    await expect(testClock.advance(-5)).rejects.toThrow(/given -5/)
    expect(testClock.clock.now()).toBe(500)

    await testClock.advance(10)
    expect(ran).toEqual(['zero@500', 'ten@510'])
    // Advancing past the last scheduled timer still advances wall and monotonic time by the remaining tail.
    await testClock.advance(25)
    expect(testClock.clock.now()).toBe(535)
    expect(testClock.elapsed()).toBe(35)

    // Overflowing mono + ms to Infinity rejects with RangeError without corrupting elapsed().
    const huge = new TestClock()
    await huge.advance(Number.MAX_VALUE)
    expect(huge.elapsed()).toBe(Number.MAX_VALUE)
    await expect(huge.advance(Number.MAX_VALUE)).rejects.toThrow(/overflow/)
    expect(huge.elapsed()).toBe(Number.MAX_VALUE)
    huge.close()
    testClock.close()
  })

  it('steps one real callback at a time with next() (skipping cancelled turns/timers) and drains with drain()', async () => {
    const testClock = new TestClock()
    const ran: string[] = []

    expect(await testClock.next()).toBe(false)

    // Cancelling the sole delayed timer disarms the driver so next() returns false and time does not jump.
    const cancelSole = testClock.clock.after(50, () => { ran.push('cancelled') })
    cancelSole()
    expect(await testClock.next()).toBe(false)
    expect(testClock.elapsed()).toBe(0)

    // Cancelling the sole 0-ms turn must also cause next() to return false (draining the stale turn invisibly).
    const cancelZero = testClock.clock.after(0, () => { ran.push('cancelled-zero') })
    cancelZero()
    expect(await testClock.next()).toBe(false)
    expect(ran).toEqual([])

    // Cancelling a 0-ms turn when a later timer waits causes next() to skip the stale turn and run the real timer.
    const cancelZero2 = testClock.clock.after(0, () => { ran.push('cancelled-zero-2') })
    testClock.clock.after(12, () => { ran.push(`after-stale@${testClock.elapsed()}`) })
    cancelZero2()
    expect(await testClock.next()).toBe(true)
    expect(ran).toEqual(['after-stale@12'])

    ran.length = 0
    testClock.clock.after(30, () => { ran.push(`c@${testClock.elapsed()}`) })
    testClock.clock.after(0, () => { ran.push(`a@${testClock.elapsed()}`) })
    testClock.clock.after(10, () => {
      ran.push(`b@${testClock.elapsed()}`)
      testClock.clock.after(5, () => { ran.push(`b2@${testClock.elapsed()}`) })
    })

    expect(await testClock.next()).toBe(true)
    expect(ran).toEqual(['a@12'])
    expect(await testClock.next()).toBe(true)
    expect(ran).toEqual(['a@12', 'b@22'])

    await testClock.drain()
    expect(ran).toEqual(['a@12', 'b@22', 'b2@27', 'c@42'])
    expect(testClock.waiting()).toBe(0)
    expect(await testClock.next()).toBe(false)
    testClock.close()
  })

  it('crosses multi-hop waits (> MAX_TIMER_MS) transparently in next(), advance(), and drain() without counting hops against maxSteps', async () => {
    const long = MAX_TIMER_MS * 2 + 50

    // One next() call crosses all internal MAX_TIMER_MS hops and runs the actual callback.
    const byNext = new TestClock({ maxSteps: 1 })
    const nextRan: number[] = []
    byNext.clock.after(long, () => { nextRan.push(byNext.elapsed()) })
    expect(await byNext.next()).toBe(true)
    expect(nextRan).toEqual([long])
    expect(byNext.waiting()).toBe(0)
    expect(await byNext.next()).toBe(false)
    byNext.close()

    // advance() across intermediate hops does not fire early, and drain() with maxSteps: 1 finishes the 1 callback.
    const byAdvance = new TestClock({ maxSteps: 1 })
    const advRan: number[] = []
    byAdvance.clock.after(long, () => { advRan.push(byAdvance.elapsed()) })
    await byAdvance.advance(MAX_TIMER_MS)
    expect(advRan).toEqual([])
    expect(byAdvance.elapsed()).toBe(MAX_TIMER_MS)
    expect(byAdvance.waiting()).toBe(1)
    await byAdvance.drain()
    expect(advRan).toEqual([long])
    expect(byAdvance.waiting()).toBe(0)
    byAdvance.close()

    // Extreme magnitudes where `mono + MAX_TIMER_MS === mono` (ULP > MAX_TIMER_MS) jump directly in O(1) without stalling.
    const extreme = new TestClock({ maxSteps: 1 })
    await extreme.advance(1e26)
    let extremeAt = 0
    extreme.clock.after(1e26, () => { extremeAt = extreme.elapsed() })
    expect(await extreme.next()).toBe(true)
    expect(extremeAt).toBe(2e26)
    expect(extreme.waiting()).toBe(0)
    extreme.close()

    // Overflowing `mono + ms` fails fast at after()/sleep() time so no non-finite deadline ever enters the heap.
    const overflowed = new TestClock()
    await overflowed.advance(Number.MAX_VALUE)
    expect(() => overflowed.clock.after(Number.MAX_VALUE, () => {})).toThrow(RangeError)
    await expect(overflowed.clock.sleep(Number.MAX_VALUE)).rejects.toThrow(RangeError)
    expect(overflowed.waiting()).toBe(0)
    overflowed.close()

    // Shifting an existing MAX_VALUE wait across a MAX_VALUE suspend span clamps to finite MAX_VALUE and still fires.
    const clampedResume = new TestClock()
    let resumedAt = 0
    clampedResume.clock.after(Number.MAX_VALUE, () => { resumedAt = clampedResume.elapsed() })
    clampedResume.suspend()
    await clampedResume.advance(Number.MAX_VALUE)
    clampedResume.resume()
    expect(await clampedResume.next()).toBe(true)
    expect(resumedAt).toBe(Number.MAX_VALUE)
    expect(clampedResume.waiting()).toBe(0)
    clampedResume.close()
  })

  it('preserves ClockController wall clamping, elapsed() isolation, suspend/resume, AbortSignal, and close semantics', async () => {
    const testClock = new TestClock({ wall: 10_000 })
    const { clock } = testClock
    expect(clock.now()).toBe(10_000)
    expect(testClock.elapsed()).toBe(0)

    // Backward or non-finite wall jump never moves clock.now() backward or affects elapsed().
    testClock.setWall(5_000)
    expect(clock.now()).toBe(10_000)
    testClock.setWall(Number.NaN)
    expect(clock.now()).toBe(10_000)
    await testClock.advance(25)
    expect(testClock.elapsed()).toBe(25)
    expect(clock.now()).toBe(10_000)
    testClock.setWall(12_000)
    expect(clock.now()).toBe(12_000)

    // Date values work in both constructor wall option and setWall() (including backward and invalid Date).
    const start = new Date('2026-01-01T00:00:00.000Z')
    const dated = new TestClock({ wall: start })
    expect(dated.clock.now()).toBe(start.getTime())
    dated.setWall(new Date('2025-12-31T23:59:00.000Z'))
    expect(dated.clock.now()).toBe(start.getTime())
    dated.setWall(new Date(Number.NaN))
    expect(dated.clock.now()).toBe(start.getTime())
    const later = new Date('2026-01-01T01:00:00.000Z')
    dated.setWall(later)
    expect(dated.clock.now()).toBe(later.getTime())
    dated.close()

    // Suspend when no turn is pending, then resume cleanly.
    testClock.suspend()
    expect(await testClock.next()).toBe(false)
    testClock.resume()

    // Suspend while a 0-ms turn is queued: nothing runs while suspended, next() returns false, resume() fires it.
    const ran: string[] = []
    clock.after(0, () => { ran.push('zero') })
    clock.after(20, () => { ran.push('twenty') })
    testClock.suspend()
    expect(await testClock.next()).toBe(false)
    await testClock.advance(100)
    expect(ran).toEqual([])
    expect(testClock.elapsed()).toBe(125)
    testClock.resume()
    await testClock.advance(0)
    expect(ran).toEqual(['zero'])
    await testClock.advance(20)
    expect(ran).toEqual(['zero', 'twenty'])

    // AbortSignal cancels sleep cleanly.
    const abort = new AbortController()
    const reason = new Error('aborted')
    const sleeping = clock.sleep(50, { signal: abort.signal })
    clock.after(10, () => { abort.abort(reason) })
    await Promise.all([
      expect(sleeping).rejects.toBe(reason),
      testClock.advance(10),
    ])
    expect(testClock.waiting()).toBe(0)

    // Closing from inside a callback rejects pending sleeps cleanly and releases channel in finally.
    let closeError: unknown
    const doomed = clock.sleep(50).catch((error) => { closeError = error })
    clock.after(5, () => { testClock.close() })
    await testClock.advance(10)
    await doomed
    expect(closeError).toBeInstanceOf(Error)
    expect((closeError as Error).name).toBe('ClockClosedError')
    expect(await testClock.next()).toBe(false)
  })

  it('guards against runaway loops with maxSteps in both advance() and drain() and validates maxSteps', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new TestClock({ maxSteps: bad })).toThrow(RangeError)
    }
    expect(() => new TestClock({ maxSteps: 0 })).toThrow(/given 0/)

    // A cancelled 0-ms turn before a real timer does not count against maxSteps: 1.
    const staleBeforeReal = new TestClock({ maxSteps: 1 })
    let ranReal = 0
    const cancelStale = staleBeforeReal.clock.after(0, () => { ranReal++ })
    staleBeforeReal.clock.after(5, () => { ranReal++ })
    cancelStale()
    await staleBeforeReal.advance(10)
    expect(ranReal).toBe(1)
    staleBeforeReal.close()

    // maxSteps === 1 succeeds when a microtask cancels the queued second 0-ms turn (leaving a stale pendingTurn with waiting() === 0).
    const staleAfterOne = new TestClock({ maxSteps: 1 })
    let ranOne = 0
    let cancelSecond = () => {}
    staleAfterOne.clock.after(0, () => {
      ranOne++
      void Promise.resolve().then(() => { cancelSecond() })
    })
    cancelSecond = staleAfterOne.clock.after(0, () => { ranOne++ })
    await staleAfterOne.advance(0)
    expect(ranOne).toBe(1)
    expect(staleAfterOne.waiting()).toBe(0)
    staleAfterOne.close()

    // Exact boundary: 2 steps allowed when maxSteps === 2, even if a later timer sits past target.
    const exact = new TestClock({ maxSteps: 2 })
    const ran: number[] = []
    exact.clock.after(1, () => { ran.push(1) })
    exact.clock.after(2, () => { ran.push(2) })
    exact.clock.after(50, () => { ran.push(3) })
    await exact.advance(10)
    expect(ran).toEqual([1, 2])
    exact.close()

    // Exact boundary: a 3rd timer sitting at due === target (and sub-ms due <= target) trips maxSteps === 2.
    const atTarget = new TestClock({ maxSteps: 2 })
    atTarget.clock.after(1, () => {})
    atTarget.clock.after(2, () => {})
    atTarget.clock.after(10, () => {})
    await expect(atTarget.advance(10)).rejects.toThrow(/maxSteps \(2\) during advance\(10\)/)
    atTarget.close()

    const subMsAtTarget = new TestClock({ maxSteps: 2 })
    subMsAtTarget.clock.after(0.1, () => {})
    subMsAtTarget.clock.after(0.2, () => {})
    subMsAtTarget.clock.after(0.3, () => {})
    await expect(subMsAtTarget.advance(0.5)).rejects.toThrow(/maxSteps \(2\) during advance\(0.5\)/)
    subMsAtTarget.close()

    // Exceeding maxSteps in advance() throws before the (maxSteps + 1)th step (both turn and timer cases).
    const loopTurn = new TestClock({ maxSteps: 3 })
    let turnCount = 0
    const repeatTurn = () => { turnCount++; loopTurn.clock.after(0, repeatTurn) }
    loopTurn.clock.after(0, repeatTurn)
    await expect(loopTurn.advance(0)).rejects.toThrow(/maxSteps \(3\) during advance\(0\)/)
    expect(turnCount).toBe(3)
    loopTurn.close()

    const loopTimer = new TestClock({ maxSteps: 2 })
    let timerCount = 0
    const repeatTimer = () => { timerCount++; loopTimer.clock.after(1, repeatTimer) }
    loopTimer.clock.after(1, repeatTimer)
    await expect(loopTimer.advance(10)).rejects.toThrow(/maxSteps \(2\) during advance\(10\)/)
    expect(timerCount).toBe(2)
    loopTimer.close()

    // Exceeding maxSteps in drain() throws cleanly for both turns and timers.
    const drainExact = new TestClock({ maxSteps: 2 })
    let drained = 0
    drainExact.clock.after(1, () => { drained++ })
    drainExact.clock.after(2, () => { drained++ })
    await drainExact.drain()
    expect(drained).toBe(2)
    drainExact.close()

    const drainLoop = new TestClock({ maxSteps: 2 })
    let drainTurnCount = 0
    const repeatDrainTurn = () => { drainTurnCount++; drainLoop.clock.after(0, repeatDrainTurn) }
    drainLoop.clock.after(0, repeatDrainTurn)
    await expect(drainLoop.drain()).rejects.toThrow(/maxSteps \(2\) during drain\(\)/)
    expect(drainTurnCount).toBe(2)
    drainLoop.close()

    const drainTimerLoop = new TestClock({ maxSteps: 2 })
    let drainTimerCount = 0
    const repeatDrainTimer = () => { drainTimerCount++; drainTimerLoop.clock.after(5, repeatDrainTimer) }
    drainTimerLoop.clock.after(5, repeatDrainTimer)
    await expect(drainTimerLoop.drain()).rejects.toThrow(/maxSteps \(2\) during drain\(\)/)
    expect(drainTimerCount).toBe(2)
    drainTimerLoop.close()
  })

  it('rejects concurrent/re-entrant stepping and recovers after a throwing callback', async () => {
    const testClock = new TestClock()
    let reentrantError: unknown
    testClock.clock.after(5, () => {
      void testClock.advance(5).catch((error) => { reentrantError = error })
    })
    await testClock.advance(5)
    expect(reentrantError).toBeInstanceOf(Error)
    expect((reentrantError as Error).message).toMatch(/already stepping/)

    // A throwing callback rejects advance() at that callback's timestamp without wedging TestClock; remaining timers still run.
    const ran: string[] = []
    testClock.clock.after(10, () => { throw new Error('boom') })
    testClock.clock.after(20, () => { ran.push(`after-boom@${testClock.elapsed()}`) })
    await expect(testClock.advance(20)).rejects.toThrow('boom')
    expect(testClock.elapsed()).toBe(15)
    await testClock.advance(10)
    expect(ran).toEqual(['after-boom@25'])
    testClock.close()
  })

  it('refs and unrefs its MessageChannel around flushes and closes both ports on close()', async () => {
    const RealMessageChannel = globalThis.MessageChannel
    let refs = 0
    let unrefs = 0
    let closed1 = 0
    let closed2 = 0
    let created = 0
    const FakeChannel = class {
      port1: { onmessage: (() => void) | null; ref(): void; unref(): void; close(): void }
      port2: { postMessage(value: unknown): void; close(): void }
      constructor() {
        created++
        const inner = new RealMessageChannel()
        const innerPort1 = inner.port1 as unknown as { onmessage: (() => void) | null; unref?: () => void; close(): void }
        innerPort1.unref?.()
        this.port1 = {
          get onmessage() { return innerPort1.onmessage },
          set onmessage(fn) { innerPort1.onmessage = fn },
          ref() { refs++ },
          unref() { unrefs++ },
          close() { closed1++; innerPort1.close() },
        }
        this.port2 = {
          postMessage(value: unknown) { inner.port2.postMessage(value) },
          close() { closed2++; inner.port2.close() },
        }
      }
    }
    vi.stubGlobal('MessageChannel', FakeChannel)
    try {
      const testClock = new TestClock()
      // Closing before any flush allocates no channel.
      testClock.close()
      expect(created).toBe(0)

      const active = new TestClock()
      await active.advance(0)
      await active.advance(0)
      expect(created).toBe(1)
      expect(refs).toBe(2)
      expect(unrefs).toBe(2)
      active.close()
      expect(closed1).toBe(1)
      expect(closed2).toBe(1)
      // Second close is a no-op.
      active.close()
      expect(closed1).toBe(1)
      expect(closed2).toBe(1)

      // Closing from inside an advance() callback defers channel closure until the post-close flush completes
      // (so no second channel is allocated) and closes both ports in finally.
      const midClose = new TestClock()
      midClose.clock.after(5, () => { midClose.close() })
      await midClose.advance(5)
      expect(created).toBe(2)
      expect(closed1).toBe(2)
      expect(closed2).toBe(2)

      // Browser-like MessagePort without ref/unref works without throwing.
      const BrowserLikeChannel = class {
        port1: { onmessage: (() => void) | null; close(): void }
        port2: { postMessage(value: unknown): void; close(): void }
        constructor() {
          const inner = new RealMessageChannel()
          const innerPort1 = inner.port1 as unknown as { onmessage: (() => void) | null; unref?: () => void; close(): void }
          innerPort1.unref?.()
          this.port1 = {
            get onmessage() { return innerPort1.onmessage },
            set onmessage(fn) { innerPort1.onmessage = fn },
            close() { innerPort1.close() },
          }
          this.port2 = {
            postMessage(value: unknown) { inner.port2.postMessage(value) },
            close() { inner.port2.close() },
          }
        }
      }
      vi.stubGlobal('MessageChannel', BrowserLikeChannel)
      const browserClock = new TestClock()
      await browserClock.advance(0)
      browserClock.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('preserves ordering, exact non-early firing, wall monotonicity, and waiting() across 40 randomized traces', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = prng(seed)
      const testClock = new TestClock({ wall: 10_000 })
      const { clock } = testClock
      let lastWall = clock.now()
      let lastElapsed = 0
      let suspended = false
      let suspendedAt = 0
      const live: Array<{ id: number; due: number; cancel: () => void; ran: boolean }> = []
      let nextId = 0

      for (let step = 0; step < 30; step++) {
        const roll = rand()
        if (roll < 0.40) {
          const delay = rand() < 0.25 ? Math.floor(rand() * 4) * 0.25 : Math.floor(rand() * 20)
          const id = nextId++
          const entry = {
            id,
            due: (suspended ? suspendedAt : testClock.elapsed()) + delay,
            cancel: () => {},
            ran: false,
          }
          entry.cancel = clock.after(delay, () => {
            expect(entry.ran).toBe(false)
            expect(suspended).toBe(false)
            expect(testClock.elapsed()).toBeGreaterThanOrEqual(entry.due)
            entry.ran = true
            const idx = live.indexOf(entry)
            expect(idx).toBeGreaterThanOrEqual(0)
            live.splice(idx, 1)
          })
          live.push(entry)
        } else if (roll < 0.55 && live.length > 0) {
          const idx = Math.floor(rand() * live.length)
          const [removed] = live.splice(idx, 1)
          removed!.cancel()
        } else if (roll < 0.75) {
          const delta = rand() < 0.3 ? Math.floor(rand() * 4) * 0.25 : Math.floor(rand() * 15)
          await testClock.advance(delta)
        } else if (roll < 0.85) {
          await testClock.next()
        } else if (roll < 0.93) {
          if (!suspended) {
            suspended = true
            suspendedAt = testClock.elapsed()
            testClock.suspend()
          } else {
            const span = testClock.elapsed() - suspendedAt
            suspended = false
            for (const item of live) item.due += span
            testClock.resume()
          }
        } else {
          testClock.setWall(clock.now() + (Math.floor(rand() * 200) - 100))
        }

        const nowWall = clock.now()
        const nowElapsed = testClock.elapsed()
        expect(nowWall).toBeGreaterThanOrEqual(lastWall)
        expect(nowElapsed).toBeGreaterThanOrEqual(lastElapsed)
        lastWall = nowWall
        lastElapsed = nowElapsed
        expect(testClock.waiting()).toBe(live.length)
      }

      if (suspended) {
        const span = testClock.elapsed() - suspendedAt
        suspended = false
        for (const item of live) item.due += span
        testClock.resume()
      }
      await testClock.drain()
      expect(live).toHaveLength(0)
      expect(testClock.waiting()).toBe(0)
      testClock.close()
    }
  })
})
