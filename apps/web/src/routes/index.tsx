import { createFileRoute, redirect } from '@tanstack/react-router'
import type { BeforeLoadContext } from '@/lib/routeGuards'

export const Route = createFileRoute('/')({
  beforeLoad: async (ctx: BeforeLoadContext) => {
    if (ctx.context.session) throw redirect({ to: '/dashboard' })
    throw redirect({ to: '/login' })
  },
})
