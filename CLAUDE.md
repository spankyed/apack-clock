# apack-clock

A clock a program is handed in place of `setTimeout` and `Date.now()`. `README.md` holds the public contract; this
file holds internal design details, vocabulary, and contributor rules.

## Layout

- `src/queue.ts` is the policy-neutral scheduling kernel (`@apackdev/clock/queue`): `DeadlineQueue<T>` (an indexed
  binary min-heap / Future Event List ordered by `(due, priority, seq)` with `O(log n)`
  `push`/`pop`/`popDue`/`remove`/`reschedule`, `O(1)` `peek`/`has`/`size`/`clear`, private-symbol slot hiding, and
  atomic `O(n)` IEEE-754-safe `shift`) and `QueueEntry<T>`.
- `src/clock.ts` implements `ClockController` (`clock`, `waiting()`, `suspend()`, `resume()`, `close()`) on top of
  `DeadlineQueue`, plus the one armed timer for what is due first and the real sources it reads unless given others.
  `src/index.ts` re-exports only the public `@apackdev/clock` contract.
- `src/testing.ts` is the deterministic testing driver (`@apackdev/clock/testing`): `TestClock`, wrapping
  `ClockController` via `ClockSources` (plus package-internal `clockInternals` for exact sub-ms deadlines and
  hop-transparent `next()` / `maxSteps`) with O(1) driver state, async microtask-flushing `advance()`/`next()`/`drain()`,
  `elapsed()`, `setWall()`, and `maxSteps` runaway protection.
- `tests/clock.spec.ts` holds each guarantee in the README as a case. `tests/queue.spec.ts` covers `DeadlineQueue`
  invariants, a 200-seed sorted-array reference model, and a virtual multi-lane scheduler demo. `tests/testing.spec.ts` covers `TestClock`
  stepping, sub-ms accuracy, hop-transparent `next()`, microtask flushing, lifecycle forwarding, `maxSteps`,
  re-entrancy guards, `MessageChannel` ref/unref/close, and 40 randomized traces. `tests/proof.spec.ts` explores every reachable
  state of `ClockController` within finite bounds (up to 3 waits for core scheduling/suspend/resume/wake/cancel/close,
  up to 2 waits for multi-hop and re-entrant callbacks) for both safety and liveness. `tests/model.spec.ts` runs 400
  seeded random traces. `tests/contracts.spec.ts` and `tests/support/checked-sources.ts` enforce all four source
  contracts on every call. `tests/worker.spec.ts` and `tests/support/clock-worker.ts` verify dedicated Web Workers
  across Chromium, Firefox, and WebKit. `tests/support/world.ts` supplies controlled sources wrapped in `checkedSources`.
- `docs/deferred/` is what is left out on purpose and why.
- `scripts/` is what CI and a release run: build determinism and size/cost checks (`package-check.mjs`), consumer
  runtime + TS 5.7 ES2023 typecheck smoke (`package-smoke.mjs`), `publint` + `attw` (`package-lint.mjs`), and the
  check that no workflow publishes to npm (`workflows-check.mjs`).

## Internals to preserve

- **Indexed binary min-heap (`O(log n)` remove-on-cancel):** each entry tracks its current `index` so cancelling
  removes it directly without leaving tombstones or walking the queue.
- **No mid-callback timer churn (`running` guard):** while a due callback executes, `arm()` defers until `finally` so
  multiple `after()` / cancel edits inside one callback settle into at most one underlying timer call.
- **Stale wakeup guard (`armed.token`):** every armed underlying timer carries a fresh object token so a cancelled
  timer firing late cannot disarm or leak a newer timer.
- **IEEE-754 `resume()` heap safety:** after shifting every waiting entry's `due` by the suspended `span`, bottom-up
  Floyd heapify restores heap order in `O(n)` in case floating-point addition collapsed two distinct `due` values to
  equal and flipped their `seq` tie-break order.

## Glossary (one voice)

Use these eight words consistently across `src/`, comments, specs, and docs:

| Word | Meaning |
|---|---|
| `due` | The moment on `monotonic` when an entry may run |
| `waits` | An entry still in the queue, not yet run or called off (`waiting()` counts them) |
| `armed` | The single underlying timer currently set for what is due first |
| `turn` | One turn of the event loop, in which at most one due entry runs |
| `hop` | One underlying timer leg of at most `MAX_TIMER_MS` ms for a wait longer than a timer accepts |
| `suspended` | Counting stopped (`suspend()` until `resume()`): nothing runs, and elapsed monotonic time is not counted |
| `closed` | Permanently shut down (`close()`): everything waiting is called off, pending sleeps reject, and later asks fail |
| `said` | The latest finite time of day `now()` has returned, never going back |

## Rules

- **Nothing runs early**, whatever a timer does. What is due is decided by reading `monotonic`, never by a timer
  having woken. Sub-millisecond remainders round up (`Math.ceil`) so OS jitter never spins at `0 ms`.
- **Nothing is guessed from a late timer.** It does not say whether the machine slept. Whoever is told says so through
  `suspend()` and `resume()`.
- **How long is `monotonic`; the time it is, `wall`.** The two are never mixed: no reading of `monotonic` is handed
  out, and nothing that waits is moved by `wall`.
- **Everything it reads or is woken by is a `ClockSources` member**, so specs choose it. Nothing in `src/` reaches for
  a timer or the time except as the default of one.
- **No dependencies at run time.** It runs in Node, browsers, and Web Workers from one source, with
  `erasableSyntaxOnly: true` and Node `>=24.12.0`.
- **Every mutant is caught.** A line whose change no spec notices is a line nothing holds: add the case, or where the
  change is mathematically equivalent, explain why on that line.

## Commands

```bash
npm run typecheck
npm run typecheck:floor
npm test
npm run test:browser
npm run mutants
npm run build
npm run package:check
npm run package:lint
npm run package:smoke
npm run workflows:check
```
