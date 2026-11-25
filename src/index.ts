// Public entry point for `@apackdev/clock`: re-exports only the consumer `Clock` contract and host `ClockController`.
export {
  ClockClosedError,
  ClockController,
  MAX_TIMER_MS,
  type Clock,
  type ClockSleepOptions,
  type ClockSources,
} from './clock.ts'
