import { describe, expect, it, vi } from 'vitest'
import { MAX_TIMER_MS, type Clock } from '../src/index.ts'
import { TestClock } from '../src/testing.ts'

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
    expect(testClock.waiting()).toBe(0)
    testClock.close()
  })

  it('supports advance(0) for immediate turns without moving time, and rejects invalid advance durations', async () => {
    const testClock = new TestClock({ wall: 500 })
    const ran: string[] = []
    testClock.clock.after(0, () => { ran.push(`zero@${testClock.clock.now()}`) })
    testClock.clock.after(10, () => { ran.push(`ten@${testClock.clock.now()}`) })

    await testClock.advance(0)
    expect(ran).toEqual(['zero@500'])
    expect(testClock.clock.now()).toBe(500)
    expect(testClock.waiting()).toBe(1)

    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(testClock.advance(bad)).rejects.toThrow(RangeError)
    }
    await expect(testClock.advance(-5)).rejects.toThrow(/given -5/)
    expect(testClock.clock.now()).toBe(500)

    await testClock.advance(10)
    expect(ran).toEqual(['zero@500', 'ten@510'])
    // Advancing past the last scheduled timer still advances wall time by the remaining tail.
    await testClock.advance(25)
    expect(testClock.clock.now()).toBe(535)
    testClock.close()
  })

  it('steps one event at a time with next() and drains everything with drain()', async () => {
    const testClock = new TestClock()
    const ran: string[] = []

    expect(await testClock.next()).toBe(false)

    // Cancelling the sole timer disarms the driver so next() returns false and time does not jump.
    const cancelSole = testClock.clock.after(50, () => { ran.push('cancelled') })
    cancelSole()
    expect(await testClock.next()).toBe(false)
    expect(testClock.clock.now()).toBe(0)

    testClock.clock.after(30, () => { ran.push(`c@${testClock.clock.now()}`) })
    testClock.clock.after(0, () => { ran.push(`a@${testClock.clock.now()}`) })
    testClock.clock.after(10, () => {
      ran.push(`b@${testClock.clock.now()}`)
      testClock.clock.after(5, () => { ran.push(`b2@${testClock.clock.now()}`) })
    })

    expect(await testClock.next()).toBe(true)
    expect(ran).toEqual(['a@0'])
    expect(await testClock.next()).toBe(true)
    expect(ran).toEqual(['a@0', 'b@10'])

    await testClock.drain()
    expect(ran).toEqual(['a@0', 'b@10', 'b2@15', 'c@30'])
    expect(testClock.waiting()).toBe(0)
    expect(await testClock.next()).toBe(false)
    testClock.close()
  })

  it('crosses multi-hop waits (> MAX_TIMER_MS) cleanly in advance() and drain()', async () => {
    const testClock = new TestClock()
    const ran: number[] = []
    const long = MAX_TIMER_MS * 2 + 50
    testClock.clock.after(long, () => { ran.push(testClock.clock.now()) })

    await testClock.advance(MAX_TIMER_MS)
    expect(ran).toEqual([])
    expect(testClock.waiting()).toBe(1)

    await testClock.drain()
    expect(ran).toEqual([long])
    expect(testClock.waiting()).toBe(0)
    testClock.close()
  })

  it('preserves ClockController wall clamping, suspend/resume, AbortSignal, and close semantics', async () => {
    const testClock = new TestClock({ wall: 10_000 })
    const { clock } = testClock
    expect(clock.now()).toBe(10_000)

    // Backward or non-finite wall jump never moves clock.now() backward or shifts timers.
    testClock.setWall(5_000)
    expect(clock.now()).toBe(10_000)
    testClock.setWall(Number.NaN)
    expect(clock.now()).toBe(10_000)
    testClock.setWall(12_000)
    expect(clock.now()).toBe(12_000)

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

    // maxSteps === 1 is valid (minimum positive safe integer) and terminates cleanly when queue empties (armed === undefined).
    const one = new TestClock({ maxSteps: 1 })
    let ranOne = 0
    one.clock.after(5, () => { ranOne++ })
    await one.advance(10)
    expect(ranOne).toBe(1)
    one.close()

    // Exact boundary: 2 steps allowed when maxSteps === 2, even if a later timer sits past target.
    const exact = new TestClock({ maxSteps: 2 })
    const ran: number[] = []
    exact.clock.after(1, () => { ran.push(1) })
    exact.clock.after(2, () => { ran.push(2) })
    exact.clock.after(50, () => { ran.push(3) })
    await exact.advance(10)
    expect(ran).toEqual([1, 2])
    exact.close()

    // Exact boundary: a 3rd timer sitting at due === target still trips maxSteps === 2.
    const atTarget = new TestClock({ maxSteps: 2 })
    atTarget.clock.after(1, () => {})
    atTarget.clock.after(2, () => {})
    atTarget.clock.after(10, () => {})
    await expect(atTarget.advance(10)).rejects.toThrow(/maxSteps \(2\) during advance\(10\)/)
    atTarget.close()

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

    // A throwing callback rejects advance() without wedging TestClock; remaining timers still run.
    const ran: string[] = []
    testClock.clock.after(10, () => { throw new Error('boom') })
    testClock.clock.after(20, () => { ran.push('after-boom') })
    await expect(testClock.advance(20)).rejects.toThrow('boom')
    await testClock.advance(10)
    expect(ran).toEqual(['after-boom'])
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
})
