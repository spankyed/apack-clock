// Policy-neutral deadline queue (Future Event List): an indexed binary min-heap ordered by `(due, priority, seq)`,
// with O(log n) push, pop, popDue, remove, and in-place reschedule, O(1) peek, has, size, and clear, and atomic
// O(n) shift with IEEE-754-safe re-heapification.
//
// Knows nothing about clocks, wall time, timers, turns, suspension, or shutdown: real-time schedulers, virtual
// clocks, and discrete-event simulations can all build on it without sharing execution policy.

/** One entry waiting in a `DeadlineQueue`. */
export interface QueueEntry<T> {
  /** Numeric deadline when this entry is due (updated in place by `shift` and `reschedule`). */
  readonly due: number
  /** Tie-breaker at equal `due`: lower runs first (default `0`; updated in place by `reschedule`). */
  readonly priority: number
  /** Insertion-order tie-breaker at equal `due` and `priority`: lower runs first (refreshed by `reschedule`). */
  readonly seq: number
  /** Payload carried by this entry. */
  readonly value: T
}

const SLOT: unique symbol = Symbol('DeadlineQueue.slot')

interface Node<T> {
  due: number
  priority: number
  seq: number
  readonly value: T
  /** Slot in its queue's heap while present; hidden behind a private symbol so it never leaks to Object.keys/JSON. */
  [SLOT]: number
}

const before = <T>(a: Node<T>, b: Node<T>): boolean =>
  a.due < b.due || (a.due === b.due && (a.priority < b.priority || (a.priority === b.priority &&
    // Stryker disable next-line EqualityOperator: every entry has a unique seq, so < and <= are equivalent.
    a.seq < b.seq)))

const assertFinite = (name: string, value: number): void => {
  if (!Number.isFinite(value)) throw new RangeError(`DeadlineQueue expects a finite ${name}, and was given ${String(value)}`)
}

/**
 * Policy-neutral indexed binary min-heap ordered by `(due, priority, seq)`.
 *
 * - `push`, `pop`, `popDue`, `remove`, `reschedule`: `O(log n)`
 * - `peek`, `has`, `size`, `clear`: `O(1)`
 * - `shift`: atomic `O(n)` bottom-up Floyd heapify (preserves tie-break order even under IEEE-754 rounding)
 */
export class DeadlineQueue<T> {
  readonly #heap: Array<Node<T>> = []
  #nextSeq = 0

  /** Number of entries currently waiting in this queue. */
  get size(): number {
    return this.#heap.length
  }

  /** Earliest entry without removing it, or `undefined` when empty. */
  peek(): QueueEntry<T> | undefined {
    return this.#heap[0]
  }

  /** Whether `entry` is currently waiting in this queue (`O(1)`). Safe on stale, foreign, or nullish handles. */
  has(entry: QueueEntry<T>): boolean {
    return this.#locate(entry) !== undefined
  }

  /**
   * Inserts `value` at `due` (with optional `priority`, default `0`; lower runs first at equal `due`).
   * Remaining ties break by insertion order (`seq`). Throws `RangeError` for non-finite `due` or `priority`.
   */
  push(due: number, value: T, priority = 0): QueueEntry<T> {
    assertFinite('due', due)
    assertFinite('priority', priority)
    const heap = this.#heap
    const node: Node<T> = { due, priority, seq: this.#nextSeq++, value, [SLOT]: heap.length }
    heap.push(node)
    this.#siftUp(node[SLOT])
    return node
  }

  /** Removes and returns the earliest entry, or `undefined` when empty. */
  pop(): QueueEntry<T> | undefined {
    const head = this.#heap[0]
    this.#removeAt(0)
    return head
  }

  /**
   * Removes and returns the earliest entry if its `due <= at`, or `undefined` if empty or not yet due.
   * Throws `RangeError` for non-finite `at`.
   */
  popDue(at: number): QueueEntry<T> | undefined {
    assertFinite('at', at)
    const head = this.#heap[0]
    if (!head || head.due > at) return undefined
    this.#removeAt(0)
    return head
  }

  /**
   * Removes `entry` from this queue in `O(log n)`. Returns `true` if it was present and removed, or `false` if it
   * was already popped, removed, cleared, nullish, or belongs to another queue.
   */
  remove(entry: QueueEntry<T>): boolean {
    const node = this.#locate(entry)
    if (!node) return false
    this.#removeAt(node[SLOT])
    return true
  }

  /**
   * Updates `entry`'s `due` (and optional `priority`, keeping its current priority if omitted) in place in `O(log n)`,
   * refreshing its tie-break `seq` so it orders after entries already waiting at the new `(due, priority)`.
   * Returns `true` if updated, or `false` if `entry` is not currently in this queue.
   * Throws `RangeError` for non-finite `due` or `priority` without mutating the queue.
   */
  reschedule(entry: QueueEntry<T>, due: number, priority?: number): boolean {
    assertFinite('due', due)
    if (priority !== undefined) assertFinite('priority', priority)
    const node = this.#locate(entry)
    if (!node) return false
    node.due = due
    if (priority !== undefined) node.priority = priority
    node.seq = this.#nextSeq++
    this.#sift(node[SLOT])
    return true
  }

  /**
   * Shifts every waiting entry's `due` by finite `delta` and restores heap order in `O(n)`.
   * Throws `RangeError` without mutating any entry if `delta` is non-finite or any shifted deadline would overflow.
   */
  shift(delta: number): void {
    assertFinite('delta', delta)
    const heap = this.#heap
    for (const node of heap) {
      if (!Number.isFinite(node.due + delta)) {
        throw new RangeError(`DeadlineQueue.shift(${String(delta)}) would overflow an entry deadline to a non-finite value`)
      }
    }
    for (const node of heap) node.due += delta
    // Adding `delta` can round two distinct `due` values to the same float, reversing their `(priority, seq)` tie-break order.
    for (let index = (heap.length >> 1) - 1; index >= 0; index--) this.#siftDown(index)
  }

  /** Removes all entries in `O(1)`. Handles returned before `clear()` remain inert even after refilling. */
  clear(): void {
    this.#heap.length = 0
  }

  #locate(entry: QueueEntry<T>): Node<T> | undefined {
    if (!entry) return undefined
    const node = entry as Node<T>
    return this.#heap[node[SLOT]] === node ? node : undefined
  }

  #place(index: number, node: Node<T>): void {
    this.#heap[index] = node
    node[SLOT] = index
  }

  #sift(index: number): void {
    const heap = this.#heap
    if (index > 0 && before(heap[index]!, heap[(index - 1) >> 1]!)) this.#siftUp(index)
    else this.#siftDown(index)
  }

  #siftUp(index: number): void {
    const heap = this.#heap
    const node = heap[index]!
    while (index > 0) {
      const parent = (index - 1) >> 1
      const parentNode = heap[parent]!
      if (!before(node, parentNode)) break
      this.#place(index, parentNode)
      index = parent
    }
    this.#place(index, node)
  }

  #siftDown(index: number): void {
    const heap = this.#heap
    const node = heap[index]!
    const length = heap.length
    const half = length >> 1
    while (index < half) {
      let child = (index << 1) + 1
      let best = heap[child]!
      const right = child + 1
      if (right < length) {
        const rightNode = heap[right]!
        if (before(rightNode, best)) {
          child = right
          best = rightNode
        }
      }
      if (!before(best, node)) break
      this.#place(index, best)
      index = child
    }
    this.#place(index, node)
  }

  #removeAt(index: number): void {
    const heap = this.#heap
    const last = heap.pop()!
    if (index < heap.length) {
      this.#place(index, last)
      this.#sift(index)
    }
  }
}
