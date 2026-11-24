# Wall-clock deadlines (`until`) and wake notification (`poke`)

Status: deferred, 2026-11-24. Not built. Waits on kept states in `@apackdev/state`, which will introduce the first
real calendar-deadline caller (`until(data.due)`).

## Why it waits

Today the app has one delayed transition (`running.connecting` → `unreachable` after 30 seconds), which is an
active monotonic wait duration (`after(30_000)`), not a calendar moment. Building wall-clock deadlines before a
kept state needs one adds surface without a caller.

## What it would be

- **`until(wallTime, run)`:** runs `run` once when the clock's **clamped wall time** (`now()`) reaches `wallTime`,
  returning an idempotent cancel.
- **One wall-time base:** wall-clock deadlines drain against the **same monotonically clamped wall-time base** that
  `now()` returns — never against raw `Date.now()`. For any future deadline (`due > said`), clamped and raw agree;
  for a deadline at or before `said` (such as `until(step.time)` right before an NTP backward step), draining
  against the same clamped base fires immediately instead of stalling for the size of the backward jump.
- **Wake notification (`poke()` / `resume()`):** on macOS and Linux, `setTimeout` pauses while a laptop sleeps, so
  a wall-clock deadline that passed during sleep would fire hours late unless the host pokes the clock on wake.
  Whoever receives OS power events (Electron's `powerMonitor` `suspend` / `resume`) calls `suspend()` on suspend and
  `resume()` on wake — `resume()` both excludes the suspended span from monotonic `after()` entries (solving
  Windows sleep too) and drains any wall-clock `until()` entries whose `wallTime <= now()`.
- **Same queue shape:** a second indexed min-heap for wall-clock entries sharing the same `MAX_TIMER_MS` (`0x7fffffff`)
  hop cap, one-timer-per-turn drain, and remove-on-cancel hygiene.
