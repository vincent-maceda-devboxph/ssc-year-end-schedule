import { defineConfig } from 'vitest/config';

// The API tests hit a real MongoDB and run several files in parallel (separate databases), and
// the concurrency tests send hundreds of requests, so the 5 s default is too tight on a busy laptop.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 60_000 },
});
