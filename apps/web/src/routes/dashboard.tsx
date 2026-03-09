import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { GitPullRequestIcon, Layers3Icon, RocketIcon } from 'lucide-react'
import { signOut, useSession } from '@/lib/authClient'
import { requireAuth } from '@/lib/routeGuards'

export const Route = createFileRoute('/dashboard')({
  beforeLoad: requireAuth,
  component: DashboardPage,
  head: () => ({
    meta: [{ title: 'Dashboard | Roxabi' }],
  }),
})

const PLACEHOLDER_CARDS = [
  { icon: Layers3Icon, title: 'Issues', desc: 'Cross-project issue board — coming soon.' },
  { icon: GitPullRequestIcon, title: 'Pull Requests', desc: 'Open PR status — coming soon.' },
  { icon: RocketIcon, title: 'Deployments', desc: 'Vercel deployment status — coming soon.' },
]

function DashboardPage() {
  const { data: session } = useSession()
  const user = session?.user
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Roxabi Dashboard</h1>
        {user && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {user.image && <img src={user.image} alt="" className="h-7 w-7 rounded-full" />}
              <span>{user.name}</span>
            </div>
            <button
              type="button"
              onClick={() => signOut().then(() => navigate({ to: '/login' }))}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Sign out
            </button>
          </div>
        )}
      </header>
      <main className="p-6 grid gap-4 sm:grid-cols-3">
        {PLACEHOLDER_CARDS.map(({ icon: Icon, title, desc }) => (
          <Card key={title}>
            <CardHeader className="flex flex-row items-center gap-2 pb-2">
              <Icon className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium">{title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">{desc}</p>
            </CardContent>
          </Card>
        ))}
      </main>
    </div>
  )
}
