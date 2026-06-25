import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";

interface RouterContext {
  queryClient: QueryClient;
}

function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-6 py-4">
        <span className="text-lg font-semibold tracking-tight text-foreground">
          Roxabi Live
        </span>
      </header>
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: CockpitPage,
});

function CockpitPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Cockpit</h1>
      <div className="flex flex-wrap gap-3">
        <StatusBadge status="ready" />
        <StatusBadge status="blocked" />
        <StatusBadge status="running" />
        <StatusBadge status="done" />
      </div>
      <Button>Open dashboard</Button>
    </div>
  );
}

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  component: SignInPage,
});

function SignInPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-8">
        <h1 className="text-xl font-semibold text-foreground">Sign in</h1>
        <p className="text-sm text-muted-foreground">
          Access is gated by Cloudflare Access. Use your email OTP to continue.
        </p>
        <Button className="w-full">Continue with email</Button>
      </div>
    </div>
  );
}

const routeTree = rootRoute.addChildren([indexRoute, signInRoute]);

export const router = createRouter({
  routeTree,
  context: { queryClient: undefined as unknown as QueryClient },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
