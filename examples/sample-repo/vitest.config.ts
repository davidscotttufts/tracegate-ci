import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The Tracegate recorder rides along ONLY when a run asks for it
    // (TRACEGATE_RECORD=<dir>, set by `tracegate run`). It must come FIRST, so
    // that modules the other setup files load are recorded too.
    setupFiles: [...(process.env.TRACEGATE_RECORD ? ['tracegate-ci/vitest-setup'] : [])],
  },
});
