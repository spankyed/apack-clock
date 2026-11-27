# @apackdev/clock

**Time as a dependency, not a global.**

JavaScript treats `setTimeout` and `Date.now()` as globals, which makes asynchronous code hard to coordinate, shut
down cleanly, and test deterministically. `@apackdev/clock` gives the host one controllable clock (`ClockController`)
and hands subsystems a four-method `Clock` (`now`, `monotonic`, `after`, `sleep`)—with zero dependencies and the same
shape in production and deterministic tests. The surface is intentionally small; additions require a real caller that
cannot be served without them.

```ts
import { ClockController, type Clock } from '@apackdev/clock'

async function run(clock: Clock) {
  const ran: string[] = []
  clock.after(20, () => { ran.push('second') })
  clock.after(10, () => { ran.push('first') })
  // What `after` returns calls it off.
  clock.after(15, () => { ran.push('never') })()
  await clock.sleep(40)
  console.log(ran.join(', '))
}

const controller = new ClockController()
try {
  await run(controller.clock)
} finally {
  controller.close()
}
```

```text
first, second
```

## Wiring the host

The host constructs one `ClockController`, hands `controller.clock` to subsystems, wires OS sleep notifications if it
receives them, and closes the controller on shutdown. Shut down subsystems before calling `controller.close()`
(calling `close()` or a previously returned cancel function more than once is a no-op). Every controller method is
bound, so it can be passed directly as a listener:

```ts
const controller = new ClockController()
powerMonitor.on('suspend', controller.suspend)
powerMonitor.on('resume', controller.resume)
// Pass `controller.clock` to subsystems; call `controller.close()` on shutdown.
```

## In a test

For manual deterministic stepping (backoff, debounce, heartbeats, TTL, or wall-clock jumps), import `TestClock` from
`@apackdev/clock/testing`. It wraps the real `ClockController` via `ClockSources` rather than reimplementing a second
clock, flushes microtasks after every step, and guards against runaway loops:

```ts
import { TestClock } from '@apackdev/clock/testing'

const testClock = new TestClock({ wall: 1_000 })
const done = run(testClock.clock)
await testClock.advance(40)
await done
testClock.close()
```

For concurrency interleaving proofs, `Clock` also has the same shape that [`@apackdev/link`](https://github.com/spankyed/apack-link) accepts (`after`) and that
[`@apackdev/orderings`](https://github.com/spankyed/apack-orderings) provides on a schedule (`now`, `monotonic`, `after`, `sleep`),
so code written against `Clock` runs unchanged under deterministic schedules (`await run(schedule.clock)`).

## API

Like `AbortController` and `AbortSignal`, `ClockController` is not a `Clock` — passing `controller` where a `Clock` is
expected is a compile error, so host controls cannot leak to consumers by mistake.

### What code is handed (`Clock`)

| | |
|---|---|
| `clock.after(ms, run)` | Runs `run` once when `ms` have passed, unless what it returns is called first |
| `clock.sleep(ms, options?)` | Resolves when `ms` have passed; accepts `{ signal?: AbortSignal }` |
| `clock.monotonic()` | Monotonic time in milliseconds from an arbitrary origin, never decreasing and excluding suspended spans. Subtract two readings (`clock.monotonic() - start`) to measure elapsed durations on the same timeline as `after` / `sleep` |
| `clock.now()` | The time of day in milliseconds since 1970, never earlier than what this clock last said. Note: `now()` is wall time (`Date.now()`), not monotonic time, so `now() + ms` is **not** when `after(ms)` fires; use `monotonic()` rather than subtracting `now()` readings to measure elapsed durations |

### What the host holds (`ClockController`)

| | |
|---|---|
| `new ClockController(sources?)` | Creates a controller on the real sources, or on custom `ClockSources` |
| `controller.clock` | Frozen `Clock` exposing only `now`, `monotonic`, `after`, and `sleep` |
| `controller.waiting()` | Count of entries currently waiting to run |
| `controller.suspend()` / `resume()` | Suspends and resumes counting; time elapsed while suspended is not counted against what waits |
| `controller.close()` | Calls off everything waiting, clears any timer, rejects pending sleeps, and refuses later asks |

### Testing driver (`@apackdev/clock/testing`)

| | |
|---|---|
| `new TestClock(options?)` | Wraps `ClockController` on virtual `ClockSources` (`{ wall?: number \| Date; maxSteps?: number }`) |
| `testClock.clock` | Frozen `Clock` to pass to code under test |
| `testClock.elapsed()` | Total virtual monotonic time elapsed in milliseconds (starts at `0`, independent of `setWall()`; unlike `clock.monotonic()`, includes time advanced while suspended) |
| `testClock.advance(ms)` | Advances both virtual monotonic and wall time by finite `ms >= 0` event-by-event (including fractional and multi-decade waits), flushing microtasks after each callback |
| `testClock.next()` | Runs the next due callback (advancing virtual monotonic and wall time to its deadline and skipping cancelled turns transparently) and flushes microtasks; returns `false` when idle, suspended, or closed |
| `testClock.drain()` | Runs all runnable callbacks in order (advancing virtual monotonic and wall time across each deadline, bounded by `maxSteps`), flushing microtasks after each |
| `testClock.setWall(wall)` | Jumps virtual wall time (`number` or `Date`, forward, backward, or non-finite) without moving monotonic time |
| `testClock.waiting()` / `suspend()` / `resume()` / `close()` | Host lifecycle controls forwarded to the underlying `ClockController` |

Notes on `TestClock` semantics:
- **Scope of isolation:** `TestClock` controls code wired to `Clock`, not the wider JS environment — unrelated I/O or raw global `setTimeout` callbacks may still run while awaiting the `MessageChannel` microtask barrier.
- **Exact deadlines:** `TestClock` jumps directly to each entry's exact deadline (including fractional waits and multi-decade durations in `O(1)`), whereas real runtimes wake at OS timer resolution (`>= Math.ceil(left)`).
- **Initial wall time:** `new TestClock({ wall })` rejects a non-finite `wall` (such as an invalid `Date`) with `RangeError`. Calling `setWall()` with a non-finite value before the first `clock.now()` causes `now()` to throw `RangeError` until a finite wall time is set.
- **Serial stepping & throws:** `advance`, `next`, and `drain` must be awaited one at a time (concurrent calls reject). If a callback throws, stepping stops at that callback's timestamp and the error rejects the step promise.

### Errors

- **Non-finite `ms` (`NaN`, `±Infinity`) or overflowing deadline (`monotonic + ms` overflows to `Infinity`):** `after` throws `RangeError`; `sleep` rejects with `RangeError`.
- **Initially non-finite `wall()`:** `now()` throws `RangeError` if `wall()` has never returned a finite reading yet. Once a finite reading has been seen, later non-finite or backward readings keep what `now()` last said.
- **Aborted `signal`:** `sleep` cancels its wait and rejects with `signal.reason`. (If an earlier listener on `signal` suppresses the abort event via `stopImmediatePropagation()`, `sleep` rejects with `signal.reason` when it would have resolved instead of resolving.)
- **Closed clock:** `after` throws and `sleep` rejects with `ClockClosedError`. Match it by name
  (`error instanceof Error && error.name === 'ClockClosedError'`) rather than `instanceof`, so cross-realm or duplicate
  package loads still match.

## Source contracts (`ClockSources`)

`new ClockController(sources)` accepts any subset of four sources (`monotonic`, `wall`, `timer`, `turn`). Soundness
relies on these four contracts:

- **`monotonic()`** returns a finite number in milliseconds that never decreases, with a finite difference between any two readings (default: `performance.now()`).
- **`wall()`** returns milliseconds since 1970; it may jump, go back, or read non-finite (`now()` throws `RangeError` until a finite reading has been seen, and never follows it back after; default: `Date.now()`).
- **`timer(ms, run)`** never invokes `run` inline and returns a cancel function; it may wake early, late, or stale. In return, the clock only passes finite `ms` in `(0, MAX_TIMER_MS]` (`0x7fffffff`) and keeps at most one timer set (default: `setTimeout` / `clearTimeout`).
- **`turn(run)`** never invokes `run` inline and runs callbacks in the order asked (default: `setImmediate`, or a reused `MessageChannel` in browsers and Web Workers).

## What holds

- **Nothing runs early (to IEEE-754 double precision).** Duration is measured on `monotonic`, and what is due is checked again on every wake; an early
  timer runs nothing, and sub-millisecond remainders round up so OS jitter never spins at `0 ms`. (Standard float64 addition `monotonic() + ms` applies; positive delays smaller than half a ULP at the current monotonic timestamp round to `0`.)
- **Setting the time of day moves nothing that waits.** `after` and `monotonic()` never read `wall`.
- **`monotonic()` never goes back and excludes suspended spans.** Measuring `clock.monotonic() - start` matches `after()` and `sleep()` across `suspend()`/`resume()` and `close()`.
- **What `now()` says never goes back.** If `wall` moves backward or reads non-finite, `now()` keeps its last reading
  until `wall` passes it.
- **At most one underlying timer**, for what is due first, and none once nothing waits, while suspended, or once closed.
- **Any finite wait works.** Waits longer than `MAX_TIMER_MS` (2 147 483 647 ms, about 24.8 days) wake in steps and
  run when due. Negative finite waits are treated as `0`.
- **Each callback gets a turn of its own**, and nothing runs inline: `after(0, run)` runs on a later turn. Of two due
  at the same moment, the one asked first runs first.
- **Woken late, everything due runs**, in order, one turn each, and what is not yet due keeps waiting.
- **What a callback throws is its own.** The error propagates to whatever woke the clock, and remaining waits still run.
- **Zero runtime dependencies.** Runs in Node, Chromium, Firefox, WebKit, and dedicated Web Workers from one source.

## How it is checked

- **Cross-runtime specs:** unit specs ([tests/clock.spec.ts](tests/clock.spec.ts)), testing driver specs
  ([tests/testing.spec.ts](tests/testing.spec.ts)), and dedicated Web Worker specs
  ([tests/worker.spec.ts](tests/worker.spec.ts)) run in Node on Linux, macOS, and Windows, and in Chromium, Firefox,
  and WebKit.
- **Bounded exhaustive exploration:** [tests/proof.spec.ts](tests/proof.spec.ts) drives `ClockController` directly
  through every reachable state within finite bounds — up to 3 waits across scheduling, cancelling, suspend/resume,
  early/late/stale wakeups, and close, and up to 2 waits across multi-step waits and re-entrant callbacks — checking
  safety at every state and verifying that every non-closed state drains to completion.
- **Randomized traces with checked sources:** [tests/model.spec.ts](tests/model.spec.ts) runs 400 seeded traces while
  [tests/contracts.spec.ts](tests/contracts.spec.ts) checks all four source contracts on every call.
- **Every mutant is caught:** `npm run mutants` mutates `src/` and fails CI if a single mutant survives.

## What it does not do

- **It does not know the machine slept.** A late timer does not distinguish sleep from throttling, so nothing here
  guesses. Where `monotonic` pauses during sleep, sleep is not counted; where `monotonic` ticks through sleep, waits
  fire on wake just as `setTimeout` does, unless the host calls `suspend()` and `resume()`.
- **It runs nothing at a time of day.** `after` is for durations. Calendar deadlines that survive restarts and follow
  wall-clock changes are deferred ([wall-deadlines-and-sleep.md](docs/deferred/wall-deadlines-and-sleep.md)).
- **Hidden browser tabs wake seldom.** Browsers throttle hidden-tab timers (often to once per minute), so waits there
  may run late, and never early.

## Requirements & installing

- **Runtime:** Node `>= 24.12.0`, or any browser / Web Worker with `performance.now`, `MessageChannel`, and `AbortSignal`.
- **Types:** TypeScript `>= 5.7` (tested against `ES2023` consumers with `skipLibCheck: false` and no `ESNext.Disposable`).

This package is not published to npm. Each `master` commit whose CI passed gets a GitHub prerelease, `pkg-<commit>`,
holding the packed tarball and its `SHA256SUMS`:

```json
"@apackdev/clock": "https://github.com/spankyed/apack-clock/releases/download/pkg-<commit>/apackdev-clock-0.1.0.tgz"
```

## License

MIT or Apache-2.0, at your option.
