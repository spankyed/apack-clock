# @apackdev/clock

A clock a program is handed in place of `setTimeout` and `Date.now()`: something to run after this long, and the
time it is.

```ts
import { clock } from '@apackdev/clock'

using time = clock()
const ran: string[] = []
time.after(20, () => { ran.push('second') })
time.after(10, () => { ran.push('first') })
// What `after` returns calls it off.
time.after(15, () => { ran.push('never') })()
await time.sleep(40)

console.log(ran.join(', '))
```

```text
first, second
```

## What a clock is

| | |
|---|---|
| `after(ms, run)` | Runs `run` once, when `ms` have passed, unless what it returns is called first |
| `sleep(ms)` | A promise that resolves when `ms` have passed |
| `now()` | The time it is, in milliseconds since 1970 |
| `pending()` | How many things are currently waiting to run |
| `pause()` / `resume()` | Stops and starts the count: what passes between is counted against nothing that waits |
| `close()` / `[Symbol.dispose]()` | Calls off everything waiting, clears the underlying timer, and runs nothing after |

`clock()` reads the real time and sets real timers. `clock({ monotonic, wall, timer, turn })` takes any of the four
from whoever makes it (`Sources`), which is how its own specs choose when each thing happens.

It has the shape apack-link takes a clock in (`after`), and that the schedule of
[`@apackdev/orderings`](https://github.com/spankyed/apack-orderings) offers a scenario (`now`, `after`, `sleep`), so
code written against one runs on the other: a program is handed this, and a spec the schedule's.

## What holds

- **Nothing runs early.** How long is counted on a clock that only goes forward, and what is due is looked at
  again each time the clock is woken: a timer that comes back before its time runs nothing, and sub-millisecond
  remainders round up so OS jitter never spins at `0 ms`.
- **Setting the time of day moves nothing that waits.** `after` does not read it.
- **The time it is never goes back.** Where the time of day is set back (or reads `NaN`), `now()` says what it said
  before until the time of day has passed that.
- **One indexed heap and one timer, for what is due first**, however many things wait, and none once nothing does or
  after `close()`. Removing on cancel is $O(\log n)$ with no dead entries left behind.
- **No mid-callback timer churn, and stale wakeups are ignored.** What a callback asks for or calls off is settled
  once it returns; a cancelled underlying timer firing late cannot disturb a newer one.
- **Any finite length of time.** A timer set for more than 2 147 483 647 ms (about 24.8 days) runs at once; what
  waits longer here is woken for in hops, and runs when it is due. Non-finite delays (`NaN`, `±Infinity`) throw a
  `RangeError`.
- **Each thing run has a turn to itself**, and nothing runs as it is asked for: `after(0, run)` runs on a later
  turn. Of two due at the same moment, the one set first runs first.
- **Woken late, everything due runs**, in order, a turn each, and the timer is set for what is not due yet.
- **What something run throws is its own.** Whatever woke the clock is handed it, and what waits is seen to
  either way.
- **No dependencies**, and it runs in Node and in a window from one source.

Each of these is a spec, and the whole is held to a model under runs drawn from a seed: things asked for, called
off (including re-entrantly from inside callbacks), the count stopped and started, throwing callbacks, the time of
day set, spurious stale wakeups, closing mid-flight, and the clock woken on time, late, very late and early.
Every mutant of the source is run against the specs (`npm run mutants`), and one that survives fails CI.

## What it does not do

- **It does not know the machine slept.** A late timer does not say whether the machine was asleep or the program
  was only not run for a while, and nothing here guesses. Where the clock that only goes forward stops while the
  machine sleeps, sleep is not counted. Where it goes on, a thing that waited through a sleep runs on waking, as it
  does with `setTimeout`. Whoever is told the machine is about to sleep and has woken, as Electron's `powerMonitor`
  is, says so with `pause()` and `resume()`, and then it is not counted anywhere.
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
