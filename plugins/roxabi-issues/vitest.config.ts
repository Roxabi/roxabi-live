import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**'],
    setupFiles: ['./vitest.setup.ts'],
    env: {
      // Prevent config from throwing during module evaluation.
      GITHUB_REPO: 'Test/test-repo',
    },
  },
})
