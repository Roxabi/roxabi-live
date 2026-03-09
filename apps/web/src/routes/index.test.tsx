import { describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({
  beforeLoad: undefined as ((ctx: unknown) => unknown) | undefined,
  redirect: vi.fn((opts: unknown) => opts),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: { beforeLoad?: (ctx: unknown) => unknown }) => {
    captured.beforeLoad = config.beforeLoad
    return { beforeLoad: config.beforeLoad }
  },
  redirect: captured.redirect,
}))

import './index'

describe('/ index route', () => {
  it('redirects unauthenticated users to /login', async () => {
    const ctx = { context: { session: null } }
    await expect(captured.beforeLoad!(ctx)).rejects.toMatchObject({ to: '/login' })
  })

  it('redirects authenticated users to /dashboard', async () => {
    const ctx = { context: { session: { user: { name: 'Ada' } } } }
    await expect(captured.beforeLoad!(ctx)).rejects.toMatchObject({ to: '/dashboard' })
  })
})
