# apack-clock

A clock a program is handed in place of `setTimeout` and `Date.now()`. `README.md` defines the vocabulary, source
contracts, and guarantees; this is what to know before changing it.

## Layout

- `src/index.ts` is the whole package: `clock(sources)`, the heap of what waits ordered by when each is due, the one
  armed timer for what is due first, `view()`/`pending()`/`pause()`/`resume()`/`close()`, and the real sources it
  reads unless given others.
- `tests/clock.spec.ts` holds each guarantee in the README as a case. `tests/proof.spec.ts` runs bounded exhaustive
  fixpoint BFS directly over `clock()` for safety and liveness. `tests/model.spec.ts` runs 400 seeded property traces.
  `tests/contracts.spec.ts` and `tests/support/checked-sources.ts` enforce the assume–guarantee source contracts.
  `tests/worker.spec.ts` and `tests/support/clock-worker.ts` verify dedicated Web Workers across Chromium, Firefox,
  and WebKit. `tests/support/world.ts` supplies controlled sources wrapped in `checkedSources`.
- `docs/deferred/` is what is left out on purpose and why.
- `scripts/` is what CI and a release run: build determinism and size/cost checks (`package-check.mjs`), consumer
  runtime + TS 5.7 ES2023 typecheck smoke (`package-smoke.mjs`), `publint` + `attw` (`package-lint.mjs`), and the
  check that no workflow publishes to npm (`workflows-check.mjs`).

## Rules

- **Nothing runs early**, whatever a timer does. What is due is decided by reading `monotonic`, never by a timer
  having woken. Sub-millisecond remainders round up (`Math.ceil`) so OS jitter never spins at `0 ms`.
- **Nothing is guessed from a late timer.** It does not say whether the machine slept. Whoever is told says so through
  `pause()` and `resume()`.
- **How long is `monotonic`; the time it is, `wall`.** The two are never mixed: no reading of `monotonic` is handed
  out, and nothing that waits is moved by `wall`.
- **Everything it reads or is woken by is a `Source`**, so specs choose it. Nothing in `src/` reaches for a timer or
  the time except as the default of one.
- **No dependencies at run time.** It runs in Node, browsers, and Web Workers from one source, with
  `erasableSyntaxOnly: true` and Node `>=24.12.0`.
- **Every mutant is caught.** A line whose change no spec notices is a line nothing holds: add the case, or where the
  change is mathematically equivalent, explain why on that line.
- **One voice.** Use the eight-word glossary in `README.md` (`due`, `waits`, `armed`, `turn`, `hop`, `paused`,
  `closed`, `said`) consistently across code, comments, specs, and docs.

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
