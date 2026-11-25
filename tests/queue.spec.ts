import { describe, expect, it } from 'vitest'
import { DeadlineQueue, type QueueEntry } from '../src/queue.ts'

/** Deterministic PRNG (Mulberry32) so randomized model traces are reproducible. */
const prng = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

const drain = <T>(queue: DeadlineQueue<T>): T[] => {
  const out: T[] = []
  let entry = queue.pop()
  while (entry) {
    out.push(entry.value)
    entry = queue.pop()
  }
  return out
}

describe('DeadlineQueue', () => {
  it('starts empty and returns undefined from peek and pop', () => {
    const queue = new DeadlineQueue<string>()
    expect(queue.size).toBe(0)
    expect(queue.peek()).toBeUndefined()
    expect(queue.pop()).toBeUndefined()
  })

  it('orders entries by due, then priority, then insertion seq', () => {
    const queue = new DeadlineQueue<string>()
    const e1 = queue.push(20, 'late')
    const e2 = queue.push(10, 'timeout-1')
    const e3 = queue.push(10, 'timeout-2', 0)
    const e4 = queue.push(10, 'raf-1', 1)
    const e5 = queue.push(10, 'immediate-1', -1)
    const e6 = queue.push(10, 'immediate-2', -1)
    const e7 = queue.push(-5, 'negative-due', 5)

    expect(e1.due).toBe(20)
    expect(e1.priority).toBe(0)
    expect(e2.priority).toBe(0)
    expect(e5.priority).toBe(-1)
    expect(e1.seq).toBeLessThan(e2.seq)
    expect(e5.seq).toBeLessThan(e6.seq)
    expect(queue.size).toBe(7)
    expect(queue.peek()).toBe(e7)

    expect(drain(queue)).toEqual([
      'negative-due',
      'immediate-1',
      'immediate-2',
      'timeout-1',
      'timeout-2',
      'raf-1',
      'late',
    ])
    expect(queue.size).toBe(0)
    expect(queue.peek()).toBeUndefined()
    // Ensure all local references were checked
    expect([e3.value, e4.value]).toEqual(['timeout-2', 'raf-1'])
  })

  it('removes head, middle (both sift-up and sift-down), and last entries cleanly', () => {
    const queue = new DeadlineQueue<string>()
    const head = queue.push(1, 'head')
    const midLeft = queue.push(10, 'mid-left')
    const midRight = queue.push(20, 'mid-right')
    const deep1 = queue.push(30, 'deep-1')
    const deep2 = queue.push(40, 'deep-2')
    const deep3 = queue.push(25, 'deep-3')
    const deep4 = queue.push(22, 'deep-4')

    // Remove an entry in the deeper half so replacement must sift UP.
    expect(queue.remove(deep2)).toBe(true)
    expect(queue.remove(deep2)).toBe(false)
    // Remove an internal node whose replacement must sift DOWN.
    expect(queue.remove(midLeft)).toBe(true)
    // Remove head.
    expect(queue.remove(head)).toBe(true)
    expect(queue.remove(head)).toBe(false)
    // Remove current last element.
    expect(queue.remove(deep1)).toBe(true)

    expect(queue.size).toBe(3)
    expect(queue.peek()).toBe(midRight)
    expect(drain(queue)).toEqual(['mid-right', 'deep-4', 'deep-3'])
    // Already-popped entry returns false.
    expect(queue.remove(deep3)).toBe(false)
    expect(queue.remove(deep4)).toBe(false)
  })

  it('handles sift-up when removing a non-root node whose replacement belongs above its parent', () => {
    const queue = new DeadlineQueue<string>()
    // Build a heap where right subtree has smaller values than a deep left-subtree slot:
    // index 0: 1, index 1: 50, index 2: 2, index 3: 60, index 4: 70, index 5: 3, index 6: 4
    // Removing index 4 (70) moves last (4) into index 4; parent is index 1 (50), so 4 MUST sift UP above 50.
    queue.push(1, '1')
    queue.push(50, '50')
    queue.push(2, '2')
    queue.push(60, '60')
    const seventy = queue.push(70, '70')
    queue.push(3, '3')
    queue.push(4, '4')

    expect(queue.remove(seventy)).toBe(true)
    expect(drain(queue)).toEqual(['1', '2', '3', '4', '50', '60'])
  })

  it('ignores foreign entries from another queue, forged/nullish handles, and stale handles after clear(), and hides internal slot', () => {
    const a = new DeadlineQueue<string>()
    const b = new DeadlineQueue<string>()
    const inA = a.push(10, 'a0')
    const inB = b.push(10, 'b0')

    // Internal heap slot must not leak to Object.keys or JSON.stringify.
    expect(Object.keys(inA)).toEqual(['due', 'priority', 'seq', 'value'])
    expect(JSON.parse(JSON.stringify(inA))).toEqual({ due: 10, priority: 0, seq: 0, value: 'a0' })

    // has() accurately reflects membership in O(1).
    expect(a.has(inA)).toBe(true)
    expect(b.has(inA)).toBe(false)
    expect(a.has(null as unknown as QueueEntry<string>)).toBe(false)
    expect(a.has(undefined as unknown as QueueEntry<string>)).toBe(false)

    // Nullish handles return false from remove() and reschedule() without throwing.
    expect(a.remove(null as unknown as QueueEntry<string>)).toBe(false)
    expect(a.remove(undefined as unknown as QueueEntry<string>)).toBe(false)
    expect(a.reschedule(null as unknown as QueueEntry<string>, 5)).toBe(false)
    expect(a.reschedule(undefined as unknown as QueueEntry<string>, 5)).toBe(false)

    // Cross-queue removal must be a no-op and must not disturb b's entry at index 0.
    expect(b.remove(inA)).toBe(false)
    expect(b.size).toBe(1)
    expect(b.peek()).toBe(inB)

    // Forged plain object matching QueueEntry shape must return false.
    const forged: QueueEntry<string> = { due: 10, priority: 0, seq: 0, value: 'forged' }
    expect(a.has(forged)).toBe(false)
    expect(a.remove(forged)).toBe(false)
    expect(a.reschedule(forged, 5)).toBe(false)
    expect(a.size).toBe(1)

    // Clear and refill past the old index: stale handle from before clear() must not remove the new entry.
    const old0 = a.push(20, 'old1')
    a.clear()
    expect(a.size).toBe(0)
    expect(a.peek()).toBeUndefined()
    expect(a.has(inA)).toBe(false)
    const fresh0 = a.push(5, 'fresh0')
    const fresh1 = a.push(15, 'fresh1')
    expect(a.remove(inA)).toBe(false)
    expect(a.remove(old0)).toBe(false)
    expect(a.size).toBe(2)
    expect(drain(a)).toEqual([fresh0.value, fresh1.value])
  })

  it('pops entries conditionally with popDue(at)', () => {
    const queue = new DeadlineQueue<string>()
    expect(queue.popDue(100)).toBeUndefined()

    queue.push(10, 'ten')
    queue.push(20, 'twenty')
    queue.push(20, 'twenty-2')

    expect(queue.popDue(9)).toBeUndefined()
    expect(queue.size).toBe(3)
    expect(queue.popDue(10)?.value).toBe('ten')
    expect(queue.popDue(19)).toBeUndefined()
    expect(queue.popDue(25)?.value).toBe('twenty')
    expect(queue.popDue(20)?.value).toBe('twenty-2')
    expect(queue.popDue(100)).toBeUndefined()
  })

  it('reschedules entries in place (sift up, sift down, priority change, FIFO seq refresh)', () => {
    const queue = new DeadlineQueue<string>()
    const a = queue.push(10, 'a')
    const b = queue.push(20, 'b')
    const c = queue.push(30, 'c')

    // Push head later (sift down) to equal deadline with b: refreshed seq puts a AFTER b.
    expect(queue.reschedule(a, 20)).toBe(true)
    expect(a.due).toBe(20)
    expect(a.priority).toBe(0)
    expect(a.seq).toBeGreaterThan(b.seq)
    expect(queue.peek()).toBe(b)

    // Pull tail earlier (sift up) with higher priority (-1) at due=20: c jumps ahead of both b and a.
    expect(queue.reschedule(c, 20, -1)).toBe(true)
    expect(c.due).toBe(20)
    expect(c.priority).toBe(-1)
    expect(queue.peek()).toBe(c)

    // Same handle still works for has() and remove().
    expect(queue.has(a)).toBe(true)
    expect(queue.has(c)).toBe(true)
    expect(drain(queue)).toEqual(['c', 'b', 'a'])

    // Stale handles return false after pop.
    expect(queue.reschedule(a, 1)).toBe(false)
    expect(queue.has(a)).toBe(false)
  })

  it('shifts deadlines by positive, negative, and zero deltas and re-heapifies on IEEE-754 tie collapse', () => {
    const queue = new DeadlineQueue<string>()
    // Construct a 7-entry heap where earlier seqs have slightly larger due times so they sit deeper in the heap.
    // Adding 2^53 collapses all distinct small due times to the exact same IEEE-754 float, requiring bottom-up
    // Floyd heapify across BOTH internal nodes (index 2, index 1) and the root (index 0) to restore (priority, seq).
    const big = 2 ** 53
    queue.push(0.7, 'seq0-p0', 0)
    queue.push(0.6, 'seq1-p0', 0)
    queue.push(0.5, 'seq2-p0', 0)
    queue.push(0.4, 'seq3-p0', 0)
    queue.push(0.3, 'seq4-p-1', -1)
    queue.push(0.2, 'seq5-p1', 1)
    queue.push(0.1, 'seq6-p-1', -1)

    // Before shift, strictly ordered by due.
    expect(queue.peek()?.value).toBe('seq6-p-1')

    queue.shift(0)
    expect(queue.peek()?.due).toBe(0.1)

    queue.shift(big)
    // Every entry collapsed to `big`, so priority (-1 < 0 < 1) and then seq must govern the full drain.
    expect(queue.peek()?.due).toBe(big)
    expect(drain(queue)).toEqual([
      'seq4-p-1',
      'seq6-p-1',
      'seq0-p0',
      'seq1-p0',
      'seq2-p0',
      'seq3-p0',
      'seq5-p1',
    ])

    // Negative shift moves deadlines earlier cleanly.
    const e = queue.push(100, 'shifted')
    queue.shift(-40)
    expect(e.due).toBe(60)
    expect(queue.pop()?.value).toBe('shifted')
  })

  it('rejects non-finite inputs and overflowing shifts atomically without mutating the queue', () => {
    const queue = new DeadlineQueue<string>()
    const kept = queue.push(10, 'kept')

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '10' as unknown as number]) {
      expect(() => queue.push(bad, 'nope')).toThrow(RangeError)
      expect(() => queue.push(10, 'nope', bad)).toThrow(RangeError)
      expect(() => queue.popDue(bad)).toThrow(RangeError)
      expect(() => queue.reschedule(kept, bad)).toThrow(RangeError)
      expect(() => queue.reschedule(kept, 10, bad)).toThrow(RangeError)
      expect(() => queue.shift(bad)).toThrow(RangeError)
    }
    expect(() => queue.push(Number.NaN, 'nope')).toThrow(/finite due.*NaN/)
    expect(() => queue.push(10, 'nope', Number.POSITIVE_INFINITY)).toThrow(/finite priority.*Infinity/)
    expect(() => queue.popDue(Number.NaN)).toThrow(/finite at.*NaN/)
    expect(() => queue.reschedule(kept, Number.NaN)).toThrow(/finite due.*NaN/)
    expect(() => queue.reschedule(kept, 10, Number.POSITIVE_INFINITY)).toThrow(/finite priority.*Infinity/)
    expect(() => queue.shift(Number.NEGATIVE_INFINITY)).toThrow(/finite delta.*-Infinity/)

    // Atomic overflow check: if ANY entry would overflow to ±Infinity, shift() throws and mutates NOTHING.
    const huge = queue.push(Number.MAX_VALUE, 'huge')
    expect(() => queue.shift(Number.MAX_VALUE)).toThrow(/overflow/)
    expect(kept.due).toBe(10)
    expect(huge.due).toBe(Number.MAX_VALUE)
    expect(queue.size).toBe(2)
    expect(queue.peek()).toBe(kept)
  })

  it('matches a sorted-array reference model across 200 randomized traces', () => {
    const compare = (a: QueueEntry<number>, b: QueueEntry<number>): number =>
      a.due !== b.due ? a.due - b.due : a.priority !== b.priority ? a.priority - b.priority : a.seq - b.seq

    for (let seed = 1; seed <= 200; seed++) {
      const rand = prng(seed)
      const queue = new DeadlineQueue<number>()
      const other = new DeadlineQueue<number>()
      const foreign = other.push(0, -1)
      const model: Array<QueueEntry<number>> = []
      const seen: Array<QueueEntry<number>> = []
      let id = 0

      for (let step = 0; step < 80; step++) {
        const roll = rand()
        if (roll < 0.35) {
          const due = Math.floor(rand() * 12) - 2
          const priority = Math.floor(rand() * 5) - 2
          const entry = queue.push(due, id++, priority)
          model.push(entry)
          seen.push(entry)
        } else if (roll < 0.50) {
          model.sort(compare)
          const expected = model.shift()
          expect(queue.pop()).toBe(expected)
        } else if (roll < 0.62) {
          const at = Math.floor(rand() * 14) - 2
          model.sort(compare)
          const expected = model[0] && model[0].due <= at ? model.shift() : undefined
          expect(queue.popDue(at)).toBe(expected)
        } else if (roll < 0.76 && seen.length > 0) {
          const target = rand() < 0.1 ? foreign : seen[Math.floor(rand() * seen.length)]!
          const idx = model.indexOf(target)
          const expected = idx >= 0
          expect(queue.has(target)).toBe(expected)
          if (expected) model.splice(idx, 1)
          expect(queue.remove(target)).toBe(expected)
        } else if (roll < 0.88 && seen.length > 0) {
          const target = rand() < 0.1 ? foreign : seen[Math.floor(rand() * seen.length)]!
          const due = Math.floor(rand() * 12) - 2
          const priority = rand() < 0.5 ? Math.floor(rand() * 5) - 2 : undefined
          const expected = model.includes(target)
          expect(queue.reschedule(target, due, priority)).toBe(expected)
        } else if (roll < 0.96) {
          const delta = rand() < 0.2 ? 2 ** 53 : Math.floor(rand() * 20) - 10
          queue.shift(delta)
          model.sort(compare)
        } else {
          queue.clear()
          model.length = 0
        }

        model.sort(compare)
        expect(queue.size).toBe(model.length)
        expect(queue.peek()).toBe(model[0])
      }

      model.sort(compare)
      expect(drain(queue)).toEqual(model.map((entry) => entry.value))
    }
  })

  it('supports a policy-independent virtual scheduler (immediates, timers, intervals, rAF, backward wall time)', () => {
    // Demonstrates how a Sinon-style fake-timer driver builds on DeadlineQueue without sharing ClockController's
    // policies: multi-lane priority ordering, synchronous tick()/next(), and backward setSystemTime().
    const IMMEDIATE = -1
    const TIMER = 0
    const RAF = 1

    const queue = new DeadlineQueue<() => void>()
    let virtualNow = 0
    let wallTime = 20_000

    const setImmediateFake = (fn: () => void) => queue.push(virtualNow, fn, IMMEDIATE)
    const setTimeoutFake = (fn: () => void, ms: number) => queue.push(virtualNow + Math.max(0, ms), fn, TIMER)
    const setIntervalFake = (fn: () => void, ms: number): (() => void) => {
      let stopped = false
      const step = Math.max(1, ms)
      let current: QueueEntry<() => void>
      const fire = () => {
        if (stopped) return
        current = queue.push(virtualNow + step, fire, TIMER)
        fn()
      }
      current = queue.push(virtualNow + step, fire, TIMER)
      return () => {
        stopped = true
        queue.remove(current)
      }
    }
    const requestAnimationFrameFake = (fn: (ts: number) => void) => {
      const nextFrame = Math.floor(virtualNow / 16) * 16 + 16
      return queue.push(nextFrame, () => fn(virtualNow), RAF)
    }
    const tick = (ms: number): void => {
      const target = virtualNow + ms
      let head = queue.popDue(target)
      while (head) {
        const elapsed = head.due - virtualNow
        virtualNow = head.due
        wallTime += elapsed
        head.value()
        head = queue.popDue(target)
      }
      wallTime += target - virtualNow
      virtualNow = target
    }
    const next = (): void => {
      const head = queue.pop()
      if (!head) return
      wallTime += head.due - virtualNow
      virtualNow = head.due
      head.value()
    }
    const setSystemTime = (ms: number): void => { wallTime = ms }

    const log: string[] = []
    // Scheduled at the same due (0): immediate (-1) must run before timeout (0) even though registered later.
    setTimeoutFake(() => { log.push(`timeout@0:${wallTime}`) }, 0)
    setImmediateFake(() => { log.push(`immediate@0:${wallTime}`) })
    // At due=16: timeout (0) must run before rAF (1) even though rAF was registered first.
    requestAnimationFrameFake((ts) => { log.push(`raf@${ts}`) })
    setTimeoutFake(() => { log.push('timeout@16') }, 16)
    const stopInterval = setIntervalFake(() => { log.push(`interval@${virtualNow}`) }, 10)
    const cancelled = setTimeoutFake(() => { log.push('never') }, 5)
    queue.remove(cancelled)

    // Wall clock can jump backward freely without disturbing scheduled deadlines.
    setSystemTime(10_000)
    expect(wallTime).toBe(10_000)

    tick(16)
    expect(log).toEqual([
      'immediate@0:10000',
      'timeout@0:10000',
      'interval@10',
      'timeout@16',
      'raf@16',
    ])
    expect(wallTime).toBe(10_016)

    // `next()` advances synchronously to the next interval tick at t=20.
    next()
    expect(log.at(-1)).toBe('interval@20')
    expect(virtualNow).toBe(20)
    stopInterval()
    expect(queue.size).toBe(0)
  })
})
