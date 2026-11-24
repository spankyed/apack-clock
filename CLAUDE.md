# apack-clock

A clock a program is handed in place of `setTimeout` and `Date.now()`. `README.md` says what it is for and what
holds; this is what to know before changing it.

## Layout

- `src/index.ts` is the whole package: `clock(sources)`, the indexed binary min-heap of what waits in the order it
  is due, the one timer for the first of it, `view()`/`pending()`/`close()`, and the real sources it reads unless
  given others.
- `tests/clock.spec.ts` is each thing the README says holds, as a case. `tests/model.spec.ts` holds a clock to a
  list of things and the moment each is due, under runs drawn from a seed (including re-entrant cancels, pauses,
  throwing callbacks, stale wakeups, fractional jitter, and mid-flight close). `tests/support/world.ts` is the
  time, timers and turns a spec hands a clock, which move only when told to.
- `docs/deferred/` is what is left out on purpose and why.
- `scripts/` is what CI and a release run: the package smoke (runtime + TS 5.7 browser-consumer typecheck), package
  lint (`publint` + `attw`), and the check that no workflow publishes to npm.

## Rules

- **Nothing runs early**, whatever a timer does. What is due is decided by reading the clock that only goes
  forward, never by a timer having come back. Sub-millisecond remainders round up (`Math.ceil`) so OS jitter never
  spins at `0 ms`.
- **Nothing is guessed from a late timer.** It does not say whether the machine slept, and a rule that counts less
  for one either never gets there in a hidden window or runs slow in one. What says the machine slept is whoever is
  told, through `pause()` and `resume()`.
- **How long is the clock that only goes forward; the time it is, the time of day.** The two are never mixed: no
  reading of the first is handed out, and nothing that waits is moved by the second.
- **Everything it reads or is woken by is a `Source`**, so that a spec chooses it. Nothing in `src/` reaches for a
  timer or the time except as the default of one.
- **No dependencies at run time.** It runs in a window and in Node from one source, with `erasableSyntaxOnly: true`
  and Node `>=24.12.0`.
- **Every mutant is caught.** A line whose change no spec notices is a line nothing holds: add the case, or where
  the change is one nobody could see, switch that mutant off where it is with why.
- **A spec says what holds, not how.**

## Commands

```bash
npm run typecheck
npm run typecheck:floor
npm test
npm run test:browser
npm run mutants
npm run build
npm run package:lint
npm run package:smoke
npm run workflows:check
```
