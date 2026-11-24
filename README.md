# @apackdev/clock

A clock a program is handed in place of `setTimeout` and `Date.now()`: something to run after this long, and the
time it is.

```ts
import { clock } from '@apackdev/clock'

const time = clock()
try {
  const ran: string[] = []
  time.after(20, () => { ran.push('second') })
  time.after(10, () => { ran.push('first') })
  // What `after` returns calls it off.
  time.after(15, () => { ran.push('never') })()
  await time.sleep(40)

  console.log(ran.join(', '))
} finally {
  time.close()
}
```

```text
first, second
```

## What a clock is

Consumers take a `Clock` (read what is said and wait, with no authority to pause or close the clock); whoever owns
the clock holds the `ManagedClock` returned by `clock()` and can hand out a frozen `Clock` with `view()`.

| | |
|---|---|
| `after(ms, run)` | Runs `run` once when `ms` have passed, unless what it returns is called first; throws `RangeError` for non-finite `ms` and `ClockClosedError` once closed |
| `sleep(ms, { signal })` | Resolves when `ms` have passed; rejects with `RangeError` for non-finite `ms`, `signal.reason` on abort, or `ClockClosedError` when closed |
| `now()` | The time it is, in milliseconds since 1970, never earlier than what this clock last said |
| `view()` | *(ManagedClock)* Returns a frozen `Clock` exposing only `now`, `after`, and `sleep` |
| `pending()` | *(ManagedClock)* How many entries currently wait to run |
| `pause()` / `resume()` | *(ManagedClock)* Pauses and resumes counting: what passes while paused is counted against nothing that waits |
| `close()` | *(ManagedClock)* Calls off everything that waits, disarms any timer, rejects pending sleeps with `ClockClosedError`, and refuses later asks |

`clock()` reads the real sources. `clock({ monotonic, wall, timer, turn })` takes any of the four from whoever makes
it (`Sources`), which is how its own specs choose when each thing happens.

It has the shape apack-link takes a clock in (`after`), and that the schedule of
[`@apackdev/orderings`](https://github.com/spankyed/apack-orderings) offers a scenario (`now`, `after`, `sleep`), so
code written against one runs on the other: a program is handed this, and a spec the schedule's.

## Glossary

| Word | Meaning |
|---|---|
| `due` | The moment on `monotonic` when an entry may run |
| `waits` | An entry still in the queue, not yet run or called off (`pending()` counts them) |
| `armed` | The single underlying timer currently set for what is due first |
| `turn` | One turn of the event loop, in which at most one due entry runs |
| `hop` | One underlying timer leg of at most `LONGEST` ms for a wait longer than a timer accepts |
| `paused` | Counting stopped (`pause()` until `resume()`): nothing runs, and elapsed monotonic time is not counted |
| `closed` | Permanently shut down (`close()`): everything waiting is called off, pending sleeps reject, and later asks fail |
| `said` | The latest finite time of day `now()` has returned, never going back |

## Source contracts

Soundness holds under four stated assumptions on `Sources`, enforced in tests by `checkedSources`:

- **`monotonic()`** returns a finite number in milliseconds that never decreases.
- **`wall()`** returns milliseconds since 1970; it may jump, go back, or read non-finite (`now()` never follows it back).
- **`timer(ms, run)`** never calls `run` inline and returns a cancel function; it may wake early, late, or stale. In return, the clock only ever asks it for a finite `ms` in `(0, LONGEST]`, and keeps at most one timer armed.
- **`turn(run)`** never calls `run` inline and delivers turns in the order asked.

## What holds

- **Nothing runs early.** How long is counted on `monotonic`, and what is due is checked again on every wake: an early
  timer runs nothing, and sub-millisecond remainders round up so OS jitter never spins at `0 ms`.
- **Setting the time of day moves nothing that waits.** `after` does not read `wall`.
- **What `now()` says never goes back.** Where `wall` goes back or reads non-finite, `now()` keeps what it last said
  until `wall` passes that.
- **One heap and at most one armed timer**, for what is due first, and none once nothing waits, while paused, or once
  closed. Calling off is $O(\log n)$ with no dead entries left behind.
- **No mid-callback timer churn, and stale wakeups are ignored.** What a callback asks for or calls off is armed once
  it returns; a cancelled underlying timer firing late cannot disarm a newer one.
- **Any finite wait.** A timer set for more than 2 147 483 647 ms (`LONGEST`, about 24.8 days) runs at once; a longer
  wait wakes in hops and runs when it is due. Non-finite waits (`NaN`, `±Infinity`) throw `RangeError`.
- **Each entry runs on a turn of its own**, and nothing runs inline: `after(0, run)` runs on a later turn. Of two due
  at the same moment, the one asked first runs first.
- **Woken late, everything due runs**, in order, a turn each, and one timer is armed for what is not due yet.
- **What a callback throws is its own.** Whatever woke the clock is handed it, and what still waits is seen to either way.
- **No dependencies**, and it runs in Node, Chromium, Firefox, WebKit, and Web Workers from one source.

Each of these is verified at four levels:
1. Unit specs ([tests/clock.spec.ts](tests/clock.spec.ts)) and dedicated Web Worker specs ([tests/worker.spec.ts](tests/worker.spec.ts)) across Node (Linux, macOS, Windows) and Chromium, Firefox, and WebKit.
2. Bounded exhaustive fixpoint BFS ([tests/proof.spec.ts](tests/proof.spec.ts)) directly over `clock()`, proving both safety and liveness across every reachable interleaving.
3. 400-seed randomized property runs ([tests/model.spec.ts](tests/model.spec.ts)) under the assume–guarantee source monitor ([tests/contracts.spec.ts](tests/contracts.spec.ts)).
4. 100% mutation testing (`npm run mutants`), where a single surviving mutant fails CI.

## What it does not do

- **It does not know the machine slept.** A late timer does not say whether the machine was asleep or the program
  was only not run for a while, and nothing here guesses. Where `monotonic` stops while the machine sleeps, sleep is
  not counted. Where it goes on, what waited through a sleep runs on waking, as it does with `setTimeout`. Whoever is
  told the machine is about to sleep and has woken, as Electron's `powerMonitor` is, says so with `pause()` and
  `resume()`, and then it is not counted anywhere.
- **It runs nothing at a time of day.** `after` is for how long. Something due at a moment on the calendar, which
  has to survive the program stopping and to follow the time of day being set, is another thing, and is deferred
  ([wall-deadlines-and-sleep.md](docs/deferred/wall-deadlines-and-sleep.md)).
- **A hidden window is woken seldom.** A browser runs a hidden window's timers as rarely as once a minute, so what
  is due there runs late, and never early.

## Installing

It is not on npm. Each `master` commit whose CI passed has a prerelease, `pkg-<commit>`, holding the package as
`npm pack` writes it, and a consumer installs it by that asset's URL:

```json
"@apackdev/clock": "https://github.com/spankyed/apack-clock/releases/download/pkg-<commit>/apackdev-clock-0.1.0.tgz"
```

## License

MIT or Apache-2.0, at your option.
