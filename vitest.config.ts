import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,   // เผื่อ Neon cold start
    hookTimeout: 30_000,
    fileParallelism: false, // integration test แตะ DB จริง — ห้ามขนาน
  },
});
