import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // The runs drawn from a seed take a moment, and longer on a slow machine: a minute is for one that never comes to
    // rest, not for one that is slow.
    testTimeout: 60_000,
  },
})
