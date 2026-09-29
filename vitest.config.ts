import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // scrypt with production params (N=2^17, r=8) is intentionally slow (~1s/call).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default'],
  },
});
